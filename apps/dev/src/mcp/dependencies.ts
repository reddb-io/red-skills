// Dependency wiring for the castle MCP surface.
import { join } from "node:path";
import {
  castleLanePath,
  createCastleLaneWriters,
  createEnginePaths,
  readCastleHistoryRecords,
  readCastleLaneRecords,
  parseWorkSelector,
  RUNNER_SPECS,
  detectRunner,
} from "@reddb-io/red-castle/engine";
import type {
  CastleMcpDependencies,
  QueueStatusInput,
  WorkerRequestInput,
  WorkerSteerInput,
  WorkerSteerStatusInput,
  WorkerVitalsProjectedOutput,
} from "@reddb-io/red-castle/mcp-server";
import { listWaits as listRspWaits } from "../../../rsp/src/wait/registry.js";
import { collectDashboardReport } from "../commands/dashboard.js";
import { listCandidates, listHitlCandidates } from "../runtime/gh.js";
import { matchesSelector } from "../core/session.js";
import * as ghx from "../runtime/gh.js";
import {
  createRedskilledBirthPort,
  resolveProjectLabel,
} from "../runtime/redskilled-birth.js";
import {
  afkPaths,
  collectMonitorInputs,
  resolveRepoContext,
} from "../runtime/wire.js";
import {
  loadConfig,
} from "../core/config.js";
import {
  parseTrustPolicy,
} from "../core/trust-gate.js";
import {
  ResidentReadCache,
  QUEUE_STATUS_KEY,
  DEADEND_AUDIT_KEY,
  claimStatusKey,
  cascadeStatusKey,
} from "../resident-read-cache.js";

import type { DevAfkMcpOperations } from "./operations.js";
import { createDefaultDevAfkMcpOperations } from "./handlers.js";
import {
  concretizeSelectorUser,
  drain,
  projectResize,
  projectStart,
  projectStatus,
  releaseProjectRegistration,
  waitStatusImpl,
} from "./project.js";
import { laneLogs, projectFields, workerVitals } from "./vitals.js";
import {
  buildQueueStatus,
  collectStatuslineAggregate,
  listDisposableWorktrees,
  partitionReadyForAgentByTrust,
  removeDisposableWorktree,
  type StatuslineAggregateReaders,
} from "./queue.js";
import { eventsSinceImpl } from "./events.js";

export interface CastleMcpReadPorts {
  statuslinePayload?: StatuslineAggregateReaders["statuslinePayload"];
  projectLabel?: StatuslineAggregateReaders["projectLabel"];
  listCandidates?: typeof listCandidates;
  listHitlCandidates?: typeof listHitlCandidates;
}

export function withCachedDeps(
  deps: CastleMcpDependencies,
  cache: ResidentReadCache,
): CastleMcpDependencies {
  return {
    ...deps,
    queueStatus: async (input) => {
      // Scoped previews bypass the cache: the cache key is selector-blind, so a
      // scoped result must never be stored as (or served from) the full view.
      if (input?.selector) return deps.queueStatus(input);
      const cached = cache.get(QUEUE_STATUS_KEY) as
        | Awaited<ReturnType<typeof deps.queueStatus>>
        | undefined;
      if (cached !== undefined) return cached;
      const result = await deps.queueStatus(input);
      cache.set(QUEUE_STATUS_KEY, result);
      return result;
    },
    claimStatus: async (input) => {
      // Batch reads (#2369) bypass the single-issue cache key.
      if (input.issue === undefined) return deps.claimStatus(input);
      const key = claimStatusKey(input.issue);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = await deps.claimStatus(input);
      cache.set(key, result);
      return result;
    },
    cascadeStatus: async (input) => {
      const key = cascadeStatusKey(input.issue);
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const result = await deps.cascadeStatus(input);
      cache.set(key, result);
      return result;
    },
    deadendAudit: async () => {
      // The resident cron refreshes this envelope; repeated tool calls within
      // the refresh window are served from cache and cost zero GitHub quota.
      const cached = cache.get(DEADEND_AUDIT_KEY);
      if (cached !== undefined) return cached;
      const result = await deps.deadendAudit();
      cache.set(DEADEND_AUDIT_KEY, result);
      return result;
    },
    claimRelease: async (input) => {
      for (const issue of input.issues ?? (input.issue !== undefined ? [input.issue] : [])) {
        cache.invalidate(claimStatusKey(issue));
      }
      return deps.claimRelease(input);
    },
    landBranch: async (input) => {
      cache.invalidate(cascadeStatusKey(input.issue));
      return deps.landBranch(input);
    },
    requeue: async (input) => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.requeue(input);
    },
    unblockSweep: async () => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.unblockSweep();
    },
    triage: async (input) => {
      cache.invalidate(QUEUE_STATUS_KEY);
      return deps.triage(input);
    },
  };
}

export function createCastleMcpDependencies(
  root = process.cwd(),
  operations: DevAfkMcpOperations = createDefaultDevAfkMcpOperations(root),
  readers: CastleMcpReadPorts = {},
): CastleMcpDependencies {
  const baseDeps: CastleMcpDependencies = {
    projectStatus: () => projectStatus(root),
    drain: (input) => drain(root, input),
    projectStart: (input) => projectStart(root, input),
    projectResize: (input) => projectResize(root, input),
    projectReset: async () => createRedskilledBirthPort({ root }).resetBirthBreaker(),
    // Stopping is giving the registration back and asking the host to end this
    // project's Workers. There is no process of the project's own left to kill
    // (ADR 0130 Amendment 4), so `force` no longer selects a harder teardown —
    // the kill is the daemon's either way.
    projectStop: async () => ({ status: "stopped", ...(await releaseProjectRegistration(root)) }),
    hostState: () => createRedskilledBirthPort({ root }).hostState(),
    hostDashboard: () => createRedskilledBirthPort({ root }).hostDashboard(),
    hostProvisionCheck: () => createRedskilledBirthPort({ root }).provisionCheck(),
    hostUnitStatus: () => createRedskilledBirthPort({ root }).unitStatus(),
    logs: (input) => laneLogs(root, input),
    workerVitals: async (input) => {
      const records = await workerVitals(root, { live_only: input.live_only });
      if (!input.fields?.length) return records;
      // A `fields` projection deliberately narrows the declared shape; the
      // contract validates those calls against its relaxed projection schema.
      return projectFields(
        records as unknown as Array<Record<string, unknown>>,
        input.fields,
      ) as WorkerVitalsProjectedOutput;
    },
    dashboard: ({ periodDays }) => collectDashboardReport(periodDays, root),
    monitor: async () => {
      const [monitor, interactiveReservation] = await Promise.all([
        collectMonitorInputs(root),
        createRedskilledBirthPort({ root }).interactiveReservation().catch(() => 0),
      ]);
      return {
        ...monitor,
        fleet: monitor.fleet == null
          ? null
          : { ...monitor.fleet, interactiveReservation },
      };
    },
    history: async ({ limit }) => {
      const records = await readCastleHistoryRecords(
        createEnginePaths(join(root, ".red")).castleHistory,
      );
      return limit === undefined ? records : records.slice(-limit);
    },
    queueStatus: async (input?: QueueStatusInput) => {
      const context = await resolveRepoContext(root);
      const gh = { cwd: root, repo: context.repo };
      let [readyForAgent, readyForHuman] = await Promise.all([
        (readers.listCandidates ?? listCandidates)(gh),
        (readers.listHitlCandidates ?? listHitlCandidates)(gh),
      ]);
      // Scoped preview: apply a fleet selector (tags/user/spec/lane/…) over the
      // ready pool, mirroring exactly what a fleet with that selector would see.
      if (input?.selector) {
        const selector = await concretizeSelectorUser(
          root,
          parseWorkSelector(input.selector),
        );
        readyForAgent = readyForAgent.filter((c) => matchesSelector(c, selector ?? {}));
      }
      const config = loadConfig(afkPaths(root).configPath, { warn: () => undefined });
      const policy = parseTrustPolicy(config, await ghx.repoVisibility(gh));
      const { eligible, heldForSummon } = await partitionReadyForAgentByTrust(
        readyForAgent,
        policy,
        {
          issueTrust: (candidate) => ghx.issueTrust(gh, candidate.number),
          actorTrustSignals: (actor) => ghx.actorTrustSignals(gh, actor),
        },
      );
      return buildQueueStatus(eligible, heldForSummon, readyForHuman);
    },
    workerDispatch: (input) => {
      if (input.issue !== undefined) {
        return operations.dispatchIssue(root, {
          ...input,
          issue: input.issue,
        });
      }
      if (input.demand !== undefined) {
        if (input.mode === "scout") {
          return operations.dispatchScout(root, {
            demand: input.demand,
            runner: input.runner,
          });
        }
        return operations.dispatchDemand(root, {
          ...input,
          demand: input.demand,
          // scout was handled above — narrow mode back to go-mode union
          mode: input.mode as "no-mistakes" | "direct-PR" | "local-only" | undefined,
        });
      }
      throw new Error("worker dispatch requires an issue or demand");
    },
    workerStatus: async ({ worker, live_only, fields }) => {
      const records = await workerVitals(root, { live_only });
      const filtered = worker === undefined
        ? records
        : records.filter((record) => record.worker.id === worker);
      return projectFields(filtered as Array<Record<string, unknown>>, fields);
    },
    workerStop: (input) => operations.stopWorker(root, input),
    runnerList: async () =>
      Object.fromEntries(
        Object.entries(RUNNER_SPECS).map(([runner, spec]) => [
          runner,
          {
            efforts: spec.efforts,
            channel: spec.channel,
            factory: spec.factory,
            ...(spec.forcedModel ? { forced_model: spec.forcedModel } : {}),
            ...(spec.defaultEffort
              ? { default_effort: spec.defaultEffort }
              : {}),
            structured_output: spec.structuredOutput === true,
            auth_env: spec.resolveAuthEnv !== undefined,
          },
        ]),
      ),
    runnerDetect: async ({ runner }) => detectRunner({ flag: runner }),
    runnerSteer: async (input: WorkerSteerInput) => {
      const paths = createEnginePaths(join(root, ".red"));
      const steerPath = paths.workerSteerFile(input.worker);
      const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import("node:fs/promises");
      const { dirname } = await import("node:path");
      await mkdirAsync(dirname(steerPath), { recursive: true });
      const { encode } = await import("@reddb-io/toon");
      await writeFileAsync(steerPath, encode({ text: input.text }), "utf8");
      const writers = createCastleLaneWriters(paths);
      await writers.worker(input.worker).append({
        kind: "worker.steered",
        worker_id: input.worker,
        payload: { reason: input.text.slice(0, 200) },
      });
      return { worker: input.worker, steer: "written" };
    },
    steerStatus: async (input: WorkerSteerStatusInput) => {
      const paths = createEnginePaths(join(root, ".red"));
      const steerPath = paths.workerSteerFile(input.worker);
      const { access } = await import("node:fs/promises");
      const pending = await access(steerPath).then(() => true).catch(() => false);
      if (pending) {
        return { worker: input.worker, status: "pending" };
      }
      const lanePath = castleLanePath(paths, "worker", input.worker);
      const records = await readCastleLaneRecords(lanePath);
      const consumed = records.filter((r) => r.kind === "worker.steer_consumed");
      if (consumed.length > 0) {
        const last = consumed[consumed.length - 1]!;
        const iteration =
          typeof last.payload?.iteration === "number"
            ? last.payload.iteration
            : undefined;
        return { worker: input.worker, status: "consumed", iteration };
      }
      return { worker: input.worker, status: "none" };
    },
    workerRequest: (input: WorkerRequestInput) => {
      const dispatch = { ...input, request: input.text };
      delete (dispatch as Partial<WorkerRequestInput>).text;
      if (dispatch.issue !== undefined) {
        return operations.dispatchIssue(root, {
          ...dispatch,
          issue: dispatch.issue,
        });
      }
      if (dispatch.demand !== undefined) {
        if (dispatch.mode === "scout") {
          return operations.dispatchScout(root, {
            demand: dispatch.demand,
            runner: dispatch.runner,
          });
        }
        return operations.dispatchDemand(root, {
          ...dispatch,
          demand: dispatch.demand,
          mode: dispatch.mode as "no-mistakes" | "direct-PR" | "local-only" | undefined,
        });
      }
      throw new Error("worker request requires an issue or demand");
    },
    requeue: (input) => operations.requeue(input),
    retake: (input) => operations.retake(input),
    reap: () => operations.reap(),
    unblockSweep: () => operations.unblockSweep(),
    gateRun: (input) => operations.gateRun(input),
    landBranch: (input) => operations.landBranch(input),
    cascadeStatus: (input) => operations.cascadeStatus(input),
    claimStatus: (input) => operations.claimStatus(input),
    claimRelease: (input) => operations.claimRelease(input),
    hitlResolve: (input) => operations.hitlResolve(input),
    mergeArm: (input) => operations.mergeArm(input),
    mergeStatus: () => operations.mergeStatus(),
    mergeRelease: (input) => operations.mergeRelease(input),
    worktreeList: () => listDisposableWorktrees(root),
    worktreeRemove: (input) => removeDisposableWorktree(root, input),
    waitStart: (input) => operations.waitStart(input),
    waitList: () => listRspWaits(root),
    waitStatus: (input) => waitStatusImpl(root, input),
    dailyReview: (input) => operations.dailyReview(input),
    weeklyReview: (input) => operations.weeklyReview(input),
    triage: (input) => operations.triage(input),
    respond: (input) => operations.respond(input),
    deadendAudit: () => operations.deadendAudit(),
    statuslineAggregate: () =>
      collectStatuslineAggregate(root, {
        statuslinePayload:
          readers.statuslinePayload
          ?? (() => createRedskilledBirthPort({ root }).statuslinePayload()),
        projectLabel: readers.projectLabel ?? (() => resolveProjectLabel(root)),
      }),
    eventsSince: (input) => eventsSinceImpl(root, input),
  };
  return withCachedDeps(baseDeps, new ResidentReadCache());
}
