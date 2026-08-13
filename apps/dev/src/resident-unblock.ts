// resident-unblock.ts — the session-reachable Unblock belt (#3014).
//
// The redskilled MCP resident is what is awake on a repo operated through live
// sessions only: no `redskilled` daemon, no `/afk` boot, no worker to run the
// close cascade. Its janitor already runs the Unblock Sweep, but only as step 7
// of the full boot suite, behind a precheck, the operational probes, and the
// docs sweep — any of which aborts the run before the promote path (the full
// diagnosis lives in `runtime/unblock-pass.ts`). So a dependent whose last
// blocker a human closed in the GitHub UI kept `blocked:dependency` forever.
//
// This belt gives the sweep its OWN schedule: one pass detached at resident
// start — the session-boot clearer — and one per interval afterwards. It shares
// nothing with the boot suite, so no unrelated halt can starve it, and it costs
// a single `gh issue list` on a repo with nothing blocked.
//
// The periodic pass also closes the idle-queue stranding failure: when a close
// cascade misses an unblock and every remaining Ticket is dependency-blocked,
// ready-for-agent falls to zero, no Worker is born, and no Worker boot can run
// another sweep. Without this independent belt the dependent is stranded
// forever; the resident's idempotent pass self-heals it within one interval
// without requiring a Worker birth.
import { join } from "node:path";
import {
  createEnginePaths,
  createSingletonLeaseStore,
  type SingletonLeaseOwner,
  type SingletonLeaseStore,
} from "@reddb-io/red-castle/engine";
import { resolveRepoRoot } from "@reddb-io/shared/repo-root.js";
import { readPidStartTime } from "./core/state.js";
import type { UnblockSweepReport } from "./core/boot-sweep.js";
import { runRepoUnblockPass } from "./runtime/unblock-pass.js";

/** How often the belt re-runs after its start-time pass. Matched to the
 * resident's other belts: frequent enough that drift dies within one working
 * session, cheap enough to be one `gh issue list` when nothing is blocked. */
export const RESIDENT_UNBLOCK_INTERVAL_MS = 5 * 60 * 1000;

/** The repo-scoped singleton that owns the belt, so several stdio hosts for the
 * same repo do not each sweep the same tracker. */
export const UNBLOCK_SWEEP_SINGLETON = "unblock-sweep";

export interface ResidentUnblockTimers {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(timer: unknown): void;
}

export interface ResidentUnblockOptions {
  readonly root?: string;
  /** The pass to run. Injected in tests; the default is the real `gh` pass. */
  readonly pass?: (root: string) => Promise<UnblockSweepReport>;
  readonly leases?: SingletonLeaseStore;
  readonly owner?: SingletonLeaseOwner;
  readonly intervalMs?: number;
  readonly timers?: ResidentUnblockTimers;
  readonly notice?: (message: string) => void;
}

export interface ResidentUnblockSweep {
  /** Run one pass now, returning the promoted issue numbers. Concurrent callers
   * share the in-flight pass rather than doubling the tracker reads. */
  sweep(): Promise<UnblockSweepReport>;
  /** Stop the belt, drain any in-flight pass, and release the singleton. */
  stop(): Promise<void>;
}

function defaultTimers(): ResidentUnblockTimers {
  return {
    setInterval(callback, intervalMs) {
      const timer = setInterval(callback, intervalMs);
      timer.unref();
      return timer;
    },
    clearInterval(timer) {
      clearInterval(timer as NodeJS.Timeout);
    },
  };
}

/**
 * Start the Unblock belt inside the redskilled MCP resident. Returns the handle, or
 * `null` when another live host for this repo already owns the singleton.
 *
 * The first pass is DETACHED from the caller: a slow or unavailable tracker
 * delays no stdio handshake, and a failing pass costs itself and nothing else —
 * the belt keeps its next tick, because a sweep that dies on one transport fault
 * is exactly the starvation this module exists to end.
 */
export async function startResidentUnblockSweep(
  options: ResidentUnblockOptions = {},
): Promise<ResidentUnblockSweep | null> {
  const root = resolveRepoRoot(options.root ?? process.cwd());
  const leases =
    options.leases ?? createSingletonLeaseStore(createEnginePaths(join(root, ".red")));
  const owner = options.owner ?? {
    pid: process.pid,
    startTime: readPidStartTime(process.pid) ?? `pid-${process.pid}`,
  };
  const acquired = await leases.acquire(UNBLOCK_SWEEP_SINGLETON, owner);
  if (!acquired.acquired) return null;

  const pass = options.pass ?? runRepoUnblockPass;
  const notice = options.notice ?? (() => undefined);
  const timers = options.timers ?? defaultTimers();
  let running: Promise<UnblockSweepReport> | undefined;
  let timer: unknown;

  const sweep = (): Promise<UnblockSweepReport> => {
    if (running) return running;
    running = pass(root)
      .catch((error): UnblockSweepReport => {
        notice(
          `unblock sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return { promoted: [], outcomes: [] };
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  timer = timers.setInterval(
    () => void sweep(),
    options.intervalMs ?? RESIDENT_UNBLOCK_INTERVAL_MS,
  );
  void sweep();

  return {
    sweep,
    async stop() {
      if (timer !== undefined) {
        timers.clearInterval(timer);
        timer = undefined;
      }
      await running;
      await leases.release(UNBLOCK_SWEEP_SINGLETON, owner);
    },
  };
}
