/**
 * fleet-hook-config.ts — the second hook execution class dispatched from the
 * `__supervise` process (issue #833). Fleet hooks carry no issue/worktree
 * context; they expose the supervisor's own lifecycle to operators (slot
 * spawn/death, circuit trip, stall detection, hard-reap veto, boot/shutdown).
 *
 * Fleet hooks resolve from the same `.red/hooks/<point>/` + library layering
 * as worker hooks via `resolveDirScripts` from hook-config.ts. There are no
 * built-in defaults — only directory-layer scripts apply. The hook-PATH
 * directory convention, script ordering (numeric prefix → lexical), and
 * project-wins shadowing are identical to the worker-hook class.
 */

import { existsSync, readdirSync } from "node:fs";
import { resolveDirScripts, type ListFiles } from "./hook-config.js";
import type { HookExitPolicy } from "./hook-dispatcher.js";

/**
 * Fleet-scoped lifecycle points, in logical dispatch order. Unlike the
 * worker-scoped `CANONICAL_HOOK_NAMES`, these carry no issue/worktree fields;
 * the context is slot-level (index, pid, death ring, supervisor log path).
 */
export const FLEET_HOOK_NAMES = [
  /** Supervisor boot — fires after boot sweeps, before the initial fleet spawn.
   * Policy: abort — a non-zero exit prevents the fleet from starting. */
  "pre_fleet",
  /** Supervisor shutdown — fires after all workers have been terminated.
   * Policy: continue (informational; the process exits regardless). */
  "post_fleet",
  /** A slot got a new live worker process (initial spawn or idle-unpark or
   * half-open probe or respawn). Policy: continue. */
  "on_slot_spawn",
  /** A slot's worker process exited. Policy: continue. */
  "on_slot_death",
  /** The circuit breaker tripped on K fast deaths in the window — the trip
   * sweep ran. Context carries slot, worker-ids, and death count.
   * Policy: continue. */
  "on_circuit_trip",
  /** A slot was newly flagged stalled (first detection; does not re-fire until
   * the stall clears and re-opens). Policy: continue. */
  "on_stall_detected",
  /** Veto gate for the hard-reap kill: a non-zero exit from any command
   * cancels the kill for this pass so a worker mid a long build/test is not
   * reaped unfairly. Policy: continue (non-zero is the veto signal, not an
   * error; remaining commands are skipped once the veto fires). */
  "on_stall_reap",
  /** A dead slot was respawned (non-clean exit path or clean-exit-with-work
   * path in handleDeadSlot). Fires in addition to `on_slot_spawn` so operators
   * can react specifically to post-death recovery. Policy: continue. */
  "on_respawn",
] as const;

export type FleetHookName = (typeof FLEET_HOOK_NAMES)[number];

const FLEET_HOOK_NAME_SET = new Set<string>(FLEET_HOOK_NAMES);

export function isFleetHookName(name: string): name is FleetHookName {
  return FLEET_HOOK_NAME_SET.has(name);
}

/**
 * Per-fleet-hook exit-code policy. `pre_fleet` aborts the boot; all `on_*`
 * hooks log and continue. `on_stall_reap` is `continue` because its non-zero
 * veto semantic is handled explicitly by the caller — it does not abort the
 * fleet process.
 */
export const FLEET_HOOK_EXIT_POLICY: Record<FleetHookName, HookExitPolicy> = {
  pre_fleet: "abort",
  post_fleet: "continue",
  on_slot_spawn: "continue",
  on_slot_death: "continue",
  on_circuit_trip: "continue",
  on_stall_detected: "continue",
  on_stall_reap: "continue",
  on_respawn: "continue",
};

export interface ResolveFleetHooksOptions {
  /** Plugin's library hooks dir (`<skill>/hooks/`). */
  libraryHooksDir?: string;
  /** Project's hooks dir (`.red/hooks/`). */
  projectHooksDir?: string;
  /** Injected dir lister for testing (defaults to readdirSync). */
  listFiles?: ListFiles;
  /** Injected existence check for testing (defaults to existsSync). */
  dirExists?: (dir: string) => boolean;
}

/** The resolved, ordered command list for every fleet lifecycle point. */
export type ResolvedFleetHooks = Record<FleetHookName, string[]>;

/**
 * Resolve fleet hook scripts from the library and project hook directories,
 * using the same layered-PATH shadowing rules as worker hooks. Fleet hooks
 * have no built-in defaults — only per-point directory scripts apply.
 *
 * Reads `<libraryHooksDir>/<point>/` and `<projectHooksDir>/<point>/`,
 * merges them with project-wins shadowing, and sorts by numeric prefix then
 * lexically. Either dir may be undefined or absent — its contribution is empty.
 */
export function resolveFleetHooks(options: ResolveFleetHooksOptions): ResolvedFleetHooks {
  const { libraryHooksDir, projectHooksDir } = options;
  const listFiles = options.listFiles ?? ((dir) => readdirSync(dir));
  const dirExists = options.dirExists ?? existsSync;
  const resolved = {} as ResolvedFleetHooks;
  for (const name of FLEET_HOOK_NAMES) {
    // resolveDirScripts accepts any string as the point name — it is used
    // purely as a directory path component, not validated against HookName.
    resolved[name] = resolveDirScripts(
      name as never,
      libraryHooksDir,
      projectHooksDir,
      listFiles,
      dirExists,
    );
  }
  return resolved;
}
