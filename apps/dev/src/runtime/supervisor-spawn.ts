// supervisor-spawn — the single place that spawns the native `__supervise`
// process. Shared by the fleet-launch command (fleet.ts) and the external
// watchdog's relaunch (watchdog-io.ts) so both speak the same pid/stop-file
// protocol and forward the same filter/policy args. No decision logic lives
// here — callers resolve target/runner/passthrough and inject them.

import { spawn } from "node:child_process";
import { readBuildInfo } from "@reddb-io/build-info";
import { closeSync, mkdirSync, openSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { encodeDevSnapshotToon } from "../core/toon-snapshot.js";
import type { ElasticShrinkMode, HeartbeatSlotPid } from "../core/supervisor.js";
import { PROJECT_SUPERVISOR_LANE } from "@reddb-io/red-castle/engine";
import { afkPaths } from "./wire.js";
import { readPidStartTime } from "../core/state.js";
import { migrateLegacyDevPaths } from "./red-path-migration.js";
import { migrateCastleCutover } from "./castle-cutover-migration.js";
import { isSupervisorIdentityLive, readSupervisorIdentity, reapStaleSupervisorState } from "./supervisor-state.js";
import {
  detectFleetScopeProbes,
  planFleetScope,
  readFleetScopeSettings,
  type FleetScopeProbes,
  type FleetScopeSettings,
} from "./fleet-scope.js";
import { loadConfig } from "../core/config.js";
import { createRedskilledBirthPort, redskilledUnreachableAdvice } from "./redskilled-birth.js";
import {
  resolveSupervisorEntry,
  supervisorLaunchVersion,
  type SupervisorEntryLookup,
} from "./supervisor-entry.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The launch entry resolver owns argv[1] interpretation (#2808); re-exported here
// so the `__watchdog`/`__supervise` callers keep one import site.
export { resolveDevScriptPath } from "./supervisor-entry.js";

function isLivePid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPinnedPid(
  pidFile: string,
  pidStartFile: string,
  deadlineMs: number,
): Promise<number | null> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    const identity = await readSupervisorIdentity(pidFile, pidStartFile);
    if (identity && isSupervisorIdentityLive(identity, isLivePid, readPidStartTime)) {
      return identity.pid;
    }
    await sleep(100);
  }
  return null;
}

export interface SpawnSupervisorOptions {
  root: string;
  target: number;
  runner: string;
  /** Trunk override from the project's work policy, propagated to every worker. */
  base?: string;
  /** Filter/policy argv (--spec/--issues/--alternate/--fallback-runner) threaded
   * into each slot's `run --once`. */
  passthrough?: readonly string[];
  /** Optional operator request, forwarded as RED_AFK_REQUEST + `--request`. */
  request?: string;
  /** Optional per-drain USD budget, forwarded as RED_AFK_DRAIN_MAX_COST_USD. */
  drainBudgetUsd?: number;
  /** Initial shrink mode for runtime target decreases. */
  shrinkMode?: ElasticShrinkMode;
  /** Prior supervisor slot -> worker pid map for takeover/adoption. */
  adoptSlotPids?: readonly HeartbeatSlotPid[];
  /** Maximum time to wait for the child to publish its pid file. */
  probeDeadlineMs?: number;
  /** Where isolation notices go. Defaults to stderr — never silent. */
  onNotice?: (message: string) => void;
  /** Test/caller injection for the cgroup-isolation decision (#2697). */
  scope?: { probes?: FleetScopeProbes; settings?: FleetScopeSettings };
  /** Test/caller injection for the published-bundle entry resolution (#2808). */
  entry?: SupervisorEntryLookup;
  /**
   * Whether this launch births Workers through the redskilled daemon (#2855).
   * A supervisor launch is the era boundary, so it is where the one-time cutover
   * migration runs. **Absent, it is ON** (#2851): since the cutover every Worker
   * this launch produces is the daemon's, so the boundary is unconditional. A
   * caller states `false` only to rehearse the era that ended.
   */
  cutoverActive?: boolean;
  /**
   * How this launch proves the host daemon will answer (#2851).
   *
   * Injected so a test can pose as a host with no daemon; a real caller passes
   * nothing and gets the session's own socket. The reach is NOT optional — see
   * `spawnSupervisor` — only its implementation is.
   */
  reachDaemon?: (root: string) => Promise<void>;
}

/** The launch's own reach: start the session daemon, or fail with its reason. */
async function defaultReachDaemon(root: string): Promise<void> {
  const port = createRedskilledBirthPort({ root });
  try {
    await port.reach();
  } catch (err) {
    throw new Error(redskilledUnreachableAdvice(port.socketPath, err));
  }
}

/**
 * Spawn a detached `__supervise` process for `root`, waiting for it to write its
 * pid file. The default 15s boot window covers migrations/reaps in large repos;
 * callers can shorten or extend it for their environment. Returns the supervisor
 * pid, or null when the pid file never appeared (the caller surfaces the log tail).
 */
export async function spawnSupervisor(opts: SpawnSupervisorOptions): Promise<number | null> {
  // The host answers BEFORE anything is launched (#2851, ADR 0130 rule 6). Since
  // the cutover every Worker is born by the daemon, so a supervisor started
  // without one would boot, tick, and refuse every single birth — a fleet that
  // looks launched and drains nothing. Failing here instead makes the missing
  // daemon the launch's own error, with the socket named. Deliberately NOT
  // caught: there is no old path to fall back to any more.
  await (opts.reachDaemon ?? defaultReachDaemon)(opts.root);
  await migrateLegacyDevPaths(opts.root).catch(() => undefined);
  // The ADR 0130 cutover migration (#2855): a supervisor launch is the boundary
  // between the era that births Workers here and the era that births them
  // through the daemon, so the one-time carry-across of live pre-cutover state
  // runs exactly here — never in a Worker's own boot, which must never quiesce
  // its peers. Stamped and gated; inert until the daemon owns birth.
  //
  // The era is ACTIVE from here on (#2851). #2855 shipped the migration gated
  // and inert because nothing birthed through the daemon yet; this launch just
  // proved the daemon answers and every Worker it produces will be the daemon's,
  // so the boundary this migration was written for is exactly here. A caller may
  // still state `false` — a test rehearsing the pre-cutover era.
  await migrateCastleCutover(opts.root, {
    cutoverActive: opts.cutoverActive ?? true,
    ...(opts.onNotice ? { deps: { notice: opts.onNotice } } : {}),
  }).catch(() => undefined);
  const paths = afkPaths(opts.root);
  mkdirSync(dirname(paths.supervisorPidPath), { recursive: true });
  await reapStaleSupervisorState(dirname(paths.supervisorPidPath), isLivePid);
  const pidFile = paths.supervisorPidPath;

  const childArgs = [...(opts.passthrough ?? [])];
  if (opts.request) childArgs.unshift("--request", opts.request);

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    RED_AFK_TARGET: String(opts.target),
    RED_AFK_RUNNER: opts.runner,
  };
  if (opts.request) env.RED_AFK_REQUEST = opts.request;
  if (opts.base?.trim()) env.RED_AFK_TRUNK = opts.base.trim();
  if (opts.drainBudgetUsd !== undefined) env.RED_AFK_DRAIN_MAX_COST_USD = String(opts.drainBudgetUsd);
  if (opts.shrinkMode !== undefined) env.RED_AFK_SHRINK_MODE = opts.shrinkMode;
  if (opts.adoptSlotPids && opts.adoptSlotPids.length > 0) {
    env.RED_AFK_ADOPT_SLOT_PIDS = JSON.stringify(opts.adoptSlotPids);
  }

  const notify = opts.onNotice ?? ((message: string) => {
    try {
      process.stderr.write(`⚠ ${message}\n`);
    } catch {
      // a closed stderr never blocks a launch
    }
  });

  // The supervisor runs the PUBLISHED bundle, not the launching process's own
  // (#2808): an MCP server on a stale plugin cache used to hand the fleet a
  // supervisor older than the one the boot probe already called skewed. An
  // unresolvable published version throws out of here — loudly, by contract.
  const entry = resolveSupervisorEntry(opts.entry);
  if (entry.source !== "local-build" && entry.source !== "caller-entry") {
    const launching = opts.entry?.installedVersion ?? readBuildInfo("dev").version;
    notify(
      `fleet launch resolved the published bundle ${entry.version} (${entry.source}); ` +
        `the launching process runs ${launching}`,
    );
  }

  // Cgroup isolation (#2697): the scope must exist BEFORE the supervisor starts,
  // because moving a running process between cgroups leaves its memory charge
  // behind. Every worker, gate install, and test fork inherits this scope.
  const direct = {
    command: entry.command,
    args: [...entry.args, "__supervise", ...childArgs],
  };
  const plan = planFleetScope({
    label: PROJECT_SUPERVISOR_LANE,
    command: direct.command,
    args: direct.args,
    settings: opts.scope?.settings ?? readFleetScopeSettings(
      loadConfig(paths.configPath, { warn: () => undefined }),
    ),
    probes: opts.scope?.probes ?? detectFleetScopeProbes(),
    salt: process.pid,
  });
  if (plan.warning) notify(plan.warning);

  const launch = (command: string, args: readonly string[]): void => {
    let stderrFd: number | undefined;
    try {
      mkdirSync(dirname(paths.supervisorLogPath), { recursive: true });
      stderrFd = openSync(paths.supervisorLogPath, "a");
    } catch {
      stderrFd = undefined;
    }
    try {
      const child = spawn(command, [...args], {
        cwd: opts.root,
        env,
        detached: true,
        stdio: ["ignore", "ignore", stderrFd ?? "ignore"],
      });
      child.unref();
    } finally {
      if (stderrFd !== undefined) closeSync(stderrFd);
    }
  };

  launch(plan.command, plan.args);

  // Pinned-pid probe (#2442) over the boot window main extended for
  // migrations/reaps (#2470): identity must be live AND start-time-pinned.
  const deadlineMs = opts.probeDeadlineMs ?? 15_000;
  const pid = await waitForPinnedPid(pidFile, paths.supervisorPidStartPath, deadlineMs);
  if (pid !== null || !plan.isolated) return pid;

  // A host that has systemd-run but refuses the transient scope (unit collision,
  // a broken user manager) must not cost us the fleet: retry unscoped, loudly.
  notify(`fleet cgroup isolation failed: scope ${plan.unit} produced no supervisor; relaunching unscoped in the caller's cgroup`);
  await reapStaleSupervisorState(dirname(paths.supervisorPidPath), isLivePid);
  launch(direct.command, direct.args);
  return waitForPinnedPid(pidFile, paths.supervisorPidStartPath, deadlineMs);
}

/**
 * Stamp a placeholder #406 fleet-heartbeat state file with `epoch` so a freshly
 * relaunched supervisor is not itself read as quiescent during its boot window
 * (the watchdog's idempotency guard). The new supervisor overwrites this on its
 * first real tick. Atomic write (tmp + rename), best-effort — a failure to stamp
 * only narrows the double-fire guard, it never blocks the relaunch.
 */
export function stampFreshFleetHeartbeat(
  statePath: string,
  epoch: number,
  runner: string,
  target: number,
  // The respawned supervisor runs the bundle the LAUNCH resolves — the published
  // one, which is not always this process's own (#2808) — so the stamp knows its
  // version before the first real tick. Leaving the field absent made every worker
  // probing the lane read `version_unknown` for the whole boot window (#2752).
  bundleVersion: string = supervisorLaunchVersion(),
): void {
  // TOON, never raw JSON — this is the fleet supervisor state snapshot surface
  // (ADR 0097); `readFleetState` sniffs so a stamp from an older bundle still reads.
  const body = encodeDevSnapshotToon({
    ts: new Date(epoch * 1000).toISOString(),
    epoch,
    // A fresh relaunch stamp counts as progress: the new supervisor is
    // healthy until proven otherwise, so seed both epochs to `epoch`.
    last_progress_epoch: epoch,
    target,
    runner,
    shrink_mode: "drain-then-retire",
    ...(bundleVersion ? { bundle_version: bundleVersion } : {}),
    ready_for_agent: 0,
    slots: { busy: 0, free: target, total: target, parked: 0 },
    slot_pids: [],
    spawns_this_tick: 0,
  });
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, body, "utf8");
  renameSync(tmp, statePath);
}
