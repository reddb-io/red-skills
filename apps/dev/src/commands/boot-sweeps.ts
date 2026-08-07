// commands/boot-sweeps.ts — the project's one-shot boot sweep suite (#623).
//
// The closure used to live in the per-project process ADR 0130 Amendment 4
// removed, which is why it read as that process's own pre-spawn step. It never
// was: the sweeps are about the REPOSITORY — orphan worktrees, stale branches,
// blocked issues, stragglers — and the resident MCP runs them on the same
// schedule the removed process did. Moving the closure to its own module is what
// keeps the sweeps once the thing that used to call them is gone.
import { dirname, join } from "node:path";
import {
  formatDeathAttributions,
  runBootDeathReaper,
} from "@reddb-io/shared/death-attribution.js";
import { stateDir } from "@reddb-io/shared/red-paths.js";
import {
  afkPaths,
  collectBootPrecheckFacts,
  collectBootOptions,
  buildBootDeps,
  type RepoContext,
} from "../runtime/wire.js";
import {
  formatPreconditionFailure,
  runBoot,
  type BootResult,
  type BootstrapInput,
} from "../core/boot.js";

/**
 * Render a one-line summary of a {@link BootResult} for the project's lane
 * (#623). A precheck failure is reported as such (workers still run their own);
 * otherwise the per-sweep counts are listed so an operator can confirm the
 * project's single boot did its work. Pure over the result.
 */
export function formatBootSweepResult(result: BootResult): string {
  if (!result.precheck.ok) {
    return `boot sweeps: precheck FAILED (${formatPreconditionFailure(result.precheck)}) — workers will run their own precheck`;
  }
  const oc = result.orphanCleanup;
  const ac = result.attemptCap;
  const bc = result.branchCleanup;
  const tj = result.tmpJanitor;
  const ds = result.docsSweep?.plan;
  const us = result.unblockSweep;
  const st = result.straggler;
  const janitorRemovalLog = (tj?.removals ?? [])
    .map((removal) => ` | tmp-janitor remove=${removal.path} liveness=${removal.livenessVerdict}`)
    .join("");
  return (
    "boot sweeps complete: " +
    `orphans removed=${oc?.removed.length ?? 0} restored=${oc?.restored.length ?? 0} kept=${oc?.kept.length ?? 0}` +
    ` | attempt-cap reclaimed=${ac?.reclaimed.length ?? 0}` +
    // `spared` is reported beside `local` on purpose (#2866): a reclaim that
    // only ever prints its deletions cannot be audited for what it refused.
    ` | branches remote=${bc?.remoteLiveReaped.length ?? 0} local=${bc?.localLiveReaped.length ?? 0} spared=${bc?.localSpared?.length ?? 0}` +
    // `state-records` is reported beside the lanes (#2978): the record reclaim
    // states what it removed AND what it kept, so a pile that stops shrinking is
    // visible as a protected count rather than as silence.
    ` | tmp-janitor expired=${tj?.expiredLanes.length ?? 0} workers=${tj?.staleWorkers.length ?? 0} state-records=${tj?.workerStateRecords?.length ?? 0} orphan-runners=${tj?.orphanTestRunners?.length ?? 0} unknown=${tj?.unknownTmpRoots.length ?? 0} protected=${(tj?.protectedLiveWorkers.length ?? 0) + (tj?.protectedLiveFeedback.length ?? 0) + (tj?.protectedLiveWorkerStateRecords?.length ?? 0)}` +
    janitorRemovalLog +
    ` | docs-sweep ${ds?.action ?? "clean"} files=${ds?.files.length ?? 0}` +
    ` | unblocked=${us?.promoted.length ?? 0}` +
    ` | stragglers unlabeled=${st?.counts.unlabeled ?? 0} triage=${st?.counts.needsTriage ?? 0} info=${st?.counts.needsInfo ?? 0}`
  );
}

/**
 * Build the project's boot closure (#623). Runs the FULL shared sweep suite a
 * single time — precheck, bootstrap, orphan cleanup, attempt cap, branch
 * cleanup, unblock sweep, straggler check — over real IO, then logs the result
 * via `log`. The reconcile sweep (boot step 7) is intentionally NOT wired (no
 * reconcileRunner): reconcile is dispatched per-tick instead, so landing parked
 * branches at boot would duplicate that path. A throw propagates to the caller.
 *
 * The bootstrap writes a project-scoped `afk-supervisor-boot.pid` inside the
 * project's runtime dir (NOT a worker dir), so it is never mistaken for a live
 * worker by the monitor or a later orphan sweep.
 */
export function buildProjectBootSweeps(
  root: string,
  repo: string,
  log: (line: string) => void,
): () => Promise<void> {
  const ctx: RepoContext = { root, repo, remote: "origin" };
  const paths = afkPaths(root);
  return async (): Promise<void> => {
    // FIRST, and before anything that can fail on the network (#3028): the
    // deaths from the last boot are attributed while the evidence is freshest,
    // and a precheck failure below must not be what buries them. Local files
    // only, so it costs nothing and cannot throw.
    log(formatDeathAttributions(runBootDeathReaper({ stateRoot: stateDir(root) })));
    const nowS = Math.floor(Date.now() / 1000);
    const facts = await collectBootPrecheckFacts(ctx, { log });
    const bootstrap: BootstrapInput = {
      tmpDir: paths.tmpDir,
      stateDir: paths.stateDir,
      workerDir: paths.tmpDir,
      workerPidFile: join(dirname(paths.supervisorPidPath), "afk-supervisor-boot.pid"),
      workerPid: process.pid,
    };
    const options = await collectBootOptions(ctx, facts, bootstrap, nowS);
    const bootDeps = await buildBootDeps(ctx, options, nowS, log);
    const result = await runBoot(bootDeps, options);
    log(formatBootSweepResult(result));
  };
}
