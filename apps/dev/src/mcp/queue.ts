// Queue composition, disposable worktrees and the statusline aggregate.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { worktreesDir } from "@reddb-io/shared/red-paths.js";
import type {
  QueueStatusOutput,
  WorktreeRemoveInput,
} from "@reddb-io/red-castle/mcp-server";
import { readBuildInfo } from "@reddb-io/build-info";
import type { RedskilledRenderPayload } from "@reddb-io/redskilled-render";
import type { HitlCandidate } from "../core/hitl-selection.js";
import type { IssueCandidate } from "../core/session.js";
import {
  collectStatuslineAfk,
  collectStatuslineDocs,
  collectStatuslineFleet,
  collectStatuslineLocalGit,
  collectStatuslineValidationGate,
  inferGitHubRepoSlug,
} from "../runtime/wire.js";
import { resolveProject } from "../commands/statusline.js";
import {
  evaluateClaimTrust,
  type ActorTrustLookup,
  type TrustPolicy,
  type TrustProvenance,
} from "../core/trust-gate.js";
import * as gitx from "../runtime/git.js";
import {
  createRedskilledBirthPort,
  resolveProjectLabel,
} from "../runtime/redskilled-birth.js";

import { projectStatus } from "./project.js";
import { workerVitals } from "./vitals.js";

export function buildQueueStatus(
  eligibleForAgent: readonly IssueCandidate[],
  heldForSummon: readonly IssueCandidate[],
  readyForHuman: readonly HitlCandidate[],
  errors: readonly QueueStatusError[] = [],
): QueueStatusOutput {
  const projectCandidate = ({ body: _body, author: _author, ...candidate }: IssueCandidate) => candidate;
  return {
    ready_for_agent: {
      eligible: eligibleForAgent.map(projectCandidate),
      held_for_summon: heldForSummon.map(projectCandidate),
    },
    ready_for_human: [...readyForHuman],
    counts: {
      ready_for_agent_eligible: eligibleForAgent.length,
      ready_for_agent_held: heldForSummon.length,
      ready_for_human: readyForHuman.length,
    },
    degraded: errors.length > 0,
    errors: [...errors],
  };
}

export interface QueueStatusError {
  kind: "trust-read";
  number: number;
  message: string;
}

export const DEFAULT_QUEUE_TRUST_READ_DEADLINE_MS = 30_000;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withDeadline<T>(promise: Promise<T>, deadline: number, message: string): Promise<T> {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(
      () => rejectPromise(new Error(message)),
      Math.max(0, deadline - Date.now()),
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolvePromise(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        rejectPromise(error);
      },
    );
  });
}

export async function partitionReadyForAgentByTrust(
  candidates: readonly IssueCandidate[],
  policy: TrustPolicy,
  deps: {
    issueTrust(candidate: IssueCandidate): Promise<TrustProvenance>;
    actorTrustSignals: ActorTrustLookup;
    trustReadDeadlineMs?: number;
  },
): Promise<{
  eligible: IssueCandidate[];
  heldForSummon: IssueCandidate[];
  errors: QueueStatusError[];
}> {
  const eligible: IssueCandidate[] = [];
  const heldForSummon: IssueCandidate[] = [];
  const errors: QueueStatusError[] = [];
  const gateActive = policy.enabled || policy.failClosed === true;
  if (!gateActive) return { eligible: [...candidates], heldForSummon, errors };
  const deadlineMs = deps.trustReadDeadlineMs ?? DEFAULT_QUEUE_TRUST_READ_DEADLINE_MS;
  const deadline = Date.now() + deadlineMs;

  const results = await Promise.all(candidates.map(async (candidate) => {
    try {
      const verdict = await withDeadline(
        (async () => evaluateClaimTrust(
          policy,
          await deps.issueTrust(candidate),
          deps.actorTrustSignals,
        ))(),
        deadline,
        `trust read timed out after ${deadlineMs}ms`,
      );
      return { candidate, status: "success", executable: verdict.executable } as const;
    } catch (error) {
      return { candidate, status: "error", error: errorMessage(error) } as const;
    }
  }));

  for (const result of results) {
    if (result.status === "error") {
      errors.push({
        kind: "trust-read",
        number: result.candidate.number,
        message: result.error,
      });
    } else {
      (result.executable ? eligible : heldForSummon).push(result.candidate);
    }
  }
  return { eligible, heldForSummon, errors };
}

/** Every checkout under the disposable `.red/tmp/worktrees/<lane>/` lanes, in
 * lane-then-name order. A missing lane root is an empty list, not an error. */
export async function listDisposableWorktrees(root: string) {
  const { readdir } = await import("node:fs/promises");
  const worktreesRoot = worktreesDir(root);
  const lanes = await readdir(worktreesRoot, { withFileTypes: true }).catch(() => []);
  const out: { lane: string; name: string; path: string }[] = [];
  for (const lane of lanes.filter((entry) => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const entries = await readdir(join(worktreesRoot, lane.name), {
      withFileTypes: true,
    }).catch(() => []);
    for (const entry of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      out.push({
        lane: lane.name,
        name: entry.name,
        path: relative(root, join(worktreesRoot, lane.name, entry.name)),
      });
    }
  }
  return out;
}

/** Remove ONE checkout under the disposable worktree lanes. A path that escapes
 * `.red/tmp/worktrees/` is refused — the tool never removes a real checkout. */
export async function removeDisposableWorktree(root: string, input: WorktreeRemoveInput) {
  const worktreesRoot = resolve(worktreesDir(root));
  const target = resolve(root, input.path);
  const rel = relative(worktreesRoot, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("worktree path escapes the disposable worktree lanes");
  }
  await gitx.worktreeRemove({ cwd: root }, target);
  return { path: relative(root, target), removed: !existsSync(target) };
}

/**
 * The castle-side statusline aggregate, assembled from the SAME collector cores
 * the command-backed `statusline` render path uses — `resolveProject`,
 * `collectStatuslineRepo`, `collectStatuslineDocs`, `collectStatuslineAfk`,
 * `collectStatuslineFleet` — plus the `fleet_status` and `worker_vitals`
 * projections, so the tool never grows a parallel implementation.
 *
 * Every collector reads local state or the TTL cache the collectors already
 * own (ADR 0084: no synchronous network fetch in a render path), so this tool
 * is as cheap as one statusline tick.
 *
 * Host-side render inputs (session model/effort, context %, 5h/7d usage) come
 * from the Claude Code statusline stdin payload and are deliberately absent —
 * the tool must not fake them.
 */
export interface StatuslineAggregateReaders {
  statuslinePayload(): Promise<
    Pick<RedskilledRenderPayload, "remote_counters" | "repository_activity">
  >;
  projectLabel(): string;
}

export async function collectStatuslineAggregate(
  root: string,
  readers: StatuslineAggregateReaders = {
    statuslinePayload: () =>
      createRedskilledBirthPort({ root }).statuslinePayload(),
    projectLabel: () => resolveProjectLabel(root),
  },
) {
  const repoCtx = {
    root,
    repo: inferGitHubRepoSlug(root),
    remote: "origin",
  };

  const [
    project,
    localGit,
    docs,
    afkBlock,
    fleetChip,
    fleet,
    workers,
    validationGate,
    daemonPayload,
  ] =
    await Promise.all([
      resolveProject(root),
      collectStatuslineLocalGit(root),
      collectStatuslineDocs(repoCtx).catch(() => undefined),
      collectStatuslineAfk(repoCtx).catch(() => null),
      collectStatuslineFleet(repoCtx).catch(() => undefined),
      projectStatus(root).catch(() => null),
      workerVitals(root),
      collectStatuslineValidationGate(root),
      readers.statuslinePayload().catch(() => undefined),
    ]);

  const projectLabel = readers.projectLabel();
  const counterProject = daemonPayload?.remote_counters?.projects.find(
    (candidate) => candidate.project_label === projectLabel,
  );
  const activityProject = daemonPayload?.repository_activity?.projects.find(
    (candidate) => candidate.project_label === projectLabel,
  );
  const remoteCounters = daemonPayload?.remote_counters == null
    ? null
    : {
        ...daemonPayload.remote_counters,
        projects: counterProject == null ? [] : [counterProject],
      };
  const repositoryActivity = daemonPayload?.repository_activity == null
    ? null
    : {
        ...daemonPayload.repository_activity,
        projects: activityProject == null ? [] : [activityProject],
      };

  return {
    project: {
      basename: project.basename,
      branch: project.branch || null,
      detached_sha: project.detachedSha ?? null,
      version: project.version ?? readBuildInfo("dev").version,
      latest_cached_version: project.latestCachedVersion ?? null,
      pointer_version: project.pointerVersion ?? null,
      docs_unlanded: docs?.count ?? 0,
    },
    /** Flattened compatibility values, all sourced from the daemon payload. */
    repo: {
      open_prs: counterProject?.counters.open_pull_requests.value
        ?? activityProject?.counts?.open_pull_requests
        ?? null,
      today_prs: counterProject?.counters.merged_today.value
        ?? activityProject?.counts?.merged_today
        ?? null,
      open_issues: counterProject?.counters.open_issues.value
        ?? activityProject?.counts?.open_issues
        ?? null,
      local_added: localGit.localAdded,
      local_removed: localGit.localRemoved,
    },
    /** The daemon's own dated blocks, scoped to this MCP's project. */
    remote_counters: remoteCounters,
    repository_activity: repositoryActivity,
    docs: { unlanded: docs?.count ?? 0 },
    validation_gate: validationGate,
    fleet,
    /** The repo-summary fleet CHIP the header line renders: the two facts the
     * `fleet_status` snapshot does not carry (supervisor-reported queue depth
     * and the busy-but-no-fresh-worker `degraded` marker), from the statusline
     * fleet collector. Null when no fresh supervisor snapshot exists. */
    fleet_chip: fleetChip
      ? {
          runner: fleetChip.runner,
          busy: fleetChip.busy,
          total: fleetChip.total,
          queue: fleetChip.queue,
          parked: fleetChip.parked ?? 0,
          degraded: fleetChip.degraded ?? false,
          churn_deaths: fleetChip.churnDeaths ?? 0,
          churn_respawns: fleetChip.churnRespawns ?? 0,
          churn_window_s: fleetChip.churnWindowS ?? 0,
          breaker_count: fleetChip.breaker?.count ?? 0,
          bundle_version: fleetChip.bundleVersion ?? null,
          /** Staleness inside the payload (ADR 0128 §6): the chip travels with
           * the anchor's verdict, so a renderer cannot draw it as current. */
          stale: fleetChip.stale ?? false,
          stale_age_s: fleetChip.staleAgeS ?? 0,
        }
      : null,
    workers,
    /** The aggregated AFK block exactly as the plain single-line form renders
     * it — summed across live workers, including the fleet runner/model/effort
     * label the per-worker rows carry individually. Null when no live worker. */
    afk: afkBlock,
    /** Flattened compatibility values from the same dated counter block above. */
    queue: {
      ready_for_agent: counterProject?.counters.ready_queue.value ?? null,
      ready_for_human: counterProject?.counters.human_queue.value ?? null,
    },
  };
}

/** The `statusline_aggregate` payload contract, inferred from its single
 * producer so a field-coverage test can pin the shape without restating it. */
export type StatuslineAggregate = Awaited<
  ReturnType<typeof collectStatuslineAggregate>
>;
