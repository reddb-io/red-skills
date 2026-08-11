// Queue composition, disposable worktrees and the statusline aggregate.
import { existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { worktreesDir } from "@reddb-io/shared/red-paths.js";
import type {
  QueueStatusOutput,
  WorktreeRemoveInput,
} from "@reddb-io/red-castle/mcp-server";
import { readBuildInfo } from "@reddb-io/build-info";
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

import { projectStatus } from "./project.js";
import { workerVitals } from "./vitals.js";

export function buildQueueStatus(
  eligibleForAgent: readonly IssueCandidate[],
  heldForSummon: readonly IssueCandidate[],
  readyForHuman: readonly HitlCandidate[],
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
  };
}

export async function partitionReadyForAgentByTrust(
  candidates: readonly IssueCandidate[],
  policy: TrustPolicy,
  deps: {
    issueTrust(candidate: IssueCandidate): Promise<TrustProvenance>;
    actorTrustSignals: ActorTrustLookup;
  },
): Promise<{
  eligible: IssueCandidate[];
  heldForSummon: IssueCandidate[];
}> {
  const eligible: IssueCandidate[] = [];
  const heldForSummon: IssueCandidate[] = [];
  const gateActive = policy.enabled || policy.failClosed === true;
  for (const candidate of candidates) {
    if (!gateActive) {
      eligible.push(candidate);
      continue;
    }
    const verdict = await evaluateClaimTrust(
      policy,
      await deps.issueTrust(candidate),
      deps.actorTrustSignals,
    );
    (verdict.executable ? eligible : heldForSummon).push(candidate);
  }
  return { eligible, heldForSummon };
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
export async function collectStatuslineAggregate(root: string) {
  const repoCtx = {
    root,
    repo: inferGitHubRepoSlug(root),
    remote: "origin",
  };

  const [project, localGit, docs, afkBlock, fleetChip, fleet, workers, validationGate] =
    await Promise.all([
      resolveProject(root),
      collectStatuslineLocalGit(root),
      collectStatuslineDocs(repoCtx).catch(() => undefined),
      collectStatuslineAfk(repoCtx).catch(() => null),
      collectStatuslineFleet(repoCtx).catch(() => undefined),
      projectStatus(root).catch(() => null),
      workerVitals(root),
      collectStatuslineValidationGate(root),
    ]);

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
    /**
     * The LOCAL repository facts, and honest nulls where the remote ones were.
     *
     * The open-PR/open-issue counts came from this app's own `gh` cache, which is
     * gone (ADR 0141 decision 2): every remote counter is the daemon's, served
     * dated on its statusline payload, and this tool reads that payload in #3568.
     * Until it does the numbers are `null` — an absence a consumer can see —
     * rather than a zero that reads as an empty repository. The diffstat stays
     * here because it never needed a network.
     */
    repo: {
      open_prs: null,
      today_prs: null,
      open_issues: null,
      local_added: localGit.localAdded,
      local_removed: localGit.localRemoved,
    },
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
    /** The queue depths, on the same terms as the counts above: daemon-owned. */
    queue: {
      ready_for_agent: null,
      ready_for_human: null,
    },
  };
}

/** The `statusline_aggregate` payload contract, inferred from its single
 * producer so a field-coverage test can pin the shape without restating it. */
export type StatuslineAggregate = Awaited<
  ReturnType<typeof collectStatuslineAggregate>
>;

