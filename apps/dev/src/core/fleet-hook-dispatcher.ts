/**
 * fleet-hook-dispatcher.ts — dispatch fleet-scoped lifecycle hooks from the
 * `__supervise` process (issue #833).
 *
 * Fleet hooks use the same `HookExec` executor contract as worker hooks: each
 * command receives the documented RED_AFK_FLEET_* env and the event context as
 * JSON on stdin. stdout is informational and not threaded as a mutable context
 * (unlike the worker interceptor). Exit-code policy follows
 * FLEET_HOOK_EXIT_POLICY; `on_stall_reap` has an additional veto semantic —
 * a non-zero exit from any command cancels the hard-reap kill for that pass.
 */

import type { HookExec } from "./hook-dispatcher.js";
import { FLEET_HOOK_EXIT_POLICY, type FleetHookName } from "./fleet-hook-config.js";

/**
 * Fleet-scoped context passed as stdin-JSON to every fleet hook command, and
 * used to derive the RED_AFK_FLEET_* env overlay. Fields absent for a given
 * event are omitted from the serialised JSON and not exported as env vars.
 */
export interface FleetHookContext {
  /** The lifecycle point being dispatched — always present. */
  event: FleetHookName;
  /** The supervisor's configured runner (RED_AFK_RUNNER). Always present. */
  runner: string;
  /** Fleet slot index (0-based). Absent for `pre_fleet` and `post_fleet`. */
  slot?: number;
  /** Live worker PID for the slot. Absent when the slot has no worker. */
  pid?: number;
  /**
   * CSV of worker IDs that occupied the slot. Populated for `on_circuit_trip`
   * from the trip-sweep's worker log parse.
   */
  worker_ids?: string;
  /** Fast-death ring size at the time of the circuit trip. `on_circuit_trip` only. */
  death_count?: number;
  /** Seconds the agent lane has been idle. `on_stall_detected` / `on_stall_reap`. */
  idle_seconds?: number;
  /** Epoch (seconds) when the stall window opened. `on_stall_detected` / `on_stall_reap`. */
  stall_since?: number;
  /** Supervisor log file path. Populated for `on_circuit_trip`. */
  supervisor_log?: string;
}

/** One recorded command execution, in dispatch order. */
export interface FleetHookExecution {
  name: FleetHookName;
  command: string;
  rc: number;
}

/** The structured outcome of dispatching one fleet lifecycle point. */
export interface FleetHookDispatchResult {
  /**
   * `true` when a `pre_fleet` abort-policy command returned non-zero. The
   * caller should halt fleet boot when this is true.
   */
  aborted: boolean;
  /**
   * `true` when an `on_stall_reap` command returned non-zero — the veto signal
   * that cancels the hard-reap kill for this pass. Always `false` for other
   * fleet hook names.
   */
  vetoed: boolean;
  /** Every command that ran, in dispatch order. */
  executions: FleetHookExecution[];
}

/**
 * Derive the documented RED_AFK_FLEET_* env overlay from a fleet hook context.
 * Fields absent from the context are not exported as empty strings — they are
 * simply omitted so a hook can distinguish "slot not relevant" from "slot = 0".
 */
export function deriveFleetHookEnv(
  base: Record<string, string>,
  context: FleetHookContext,
): Record<string, string> {
  const env: Record<string, string> = { ...base };
  env.RED_AFK_FLEET_EVENT = context.event;
  // Standard RED_AFK_RUNNER for consistency with worker hooks.
  env.RED_AFK_RUNNER = context.runner;
  if (context.slot !== undefined) env.RED_AFK_FLEET_SLOT = String(context.slot);
  if (context.pid !== undefined && context.pid > 0) env.RED_AFK_FLEET_PID = String(context.pid);
  if (context.worker_ids !== undefined && context.worker_ids.length > 0) {
    env.RED_AFK_FLEET_WORKER_IDS = context.worker_ids;
  }
  if (context.death_count !== undefined) {
    env.RED_AFK_FLEET_DEATH_COUNT = String(context.death_count);
  }
  if (context.idle_seconds !== undefined) {
    env.RED_AFK_FLEET_IDLE_SECONDS = String(context.idle_seconds);
  }
  if (context.stall_since !== undefined && context.stall_since > 0) {
    env.RED_AFK_FLEET_STALL_SINCE = String(context.stall_since);
  }
  if (context.supervisor_log !== undefined && context.supervisor_log.length > 0) {
    env.RED_AFK_FLEET_SUPERVISOR_LOG = context.supervisor_log;
  }
  return env;
}

export interface DispatchFleetHookOptions {
  /**
   * Base RED_AFK_* env prepended to every command (ROOT, REPO, etc.). Per-
   * event vars derived from the context are layered on top.
   */
  env?: Record<string, string>;
  /** Sink for dispatcher log lines (defaults to no-op). */
  log?: (message: string) => void;
}

/**
 * Dispatch one fleet lifecycle point's command list under the fleet hook
 * contract and exit-code policy.
 *
 * Each command receives `deriveFleetHookEnv(base, context)` as env and the
 * serialised context as stdin JSON. stdout is acknowledged but not threaded
 * as a mutable context (fleet hooks are notification-only). The exit-code
 * policy follows `FLEET_HOOK_EXIT_POLICY`:
 *
 *   - `pre_fleet` (abort): first non-zero halts the chain; `aborted=true`.
 *   - `on_stall_reap` (continue + veto): first non-zero sets `vetoed=true`
 *     and stops further commands so the supervisor skips the hard-reap kill.
 *   - all other points (continue): non-zero is logged, chain continues.
 */
export async function dispatchFleetHook(
  name: FleetHookName,
  commands: string[],
  context: FleetHookContext,
  exec: HookExec,
  options: DispatchFleetHookOptions = {},
): Promise<FleetHookDispatchResult> {
  const env = deriveFleetHookEnv(options.env ?? {}, context);
  const log = options.log ?? (() => {});
  const policy = FLEET_HOOK_EXIT_POLICY[name];
  const stdinJson = JSON.stringify(context);

  const executions: FleetHookExecution[] = [];

  for (const command of commands) {
    if (command.length === 0) continue;

    log(`[afk:fleet-hooks] ${name}: enter: ${command}`);
    const { code } = await exec(command, env, stdinJson);
    executions.push({ name, command, rc: code });
    log(`[afk:fleet-hooks] ${name}: exit rc=${code}: ${command}`);

    if (code !== 0) {
      if (name === "on_stall_reap") {
        log(`[afk:fleet-hooks] ${name}: hook vetoed the reap (rc=${code}): ${command}`);
        return { aborted: false, vetoed: true, executions };
      }
      if (policy === "abort") {
        log(`[afk:fleet-hooks] ${name}: command failed (rc=${code}): ${command}`);
        return { aborted: true, vetoed: false, executions };
      }
      log(`[afk:fleet-hooks] ${name}: command failed (rc=${code}), continuing: ${command}`);
    }
  }

  return { aborted: false, vetoed: false, executions };
}
