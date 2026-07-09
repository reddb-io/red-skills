/**
 * opencode-host.ts — Prototype OpenCode *host* Task-mirror sink (issue #888).
 *
 * This is a narrow, reversible prototype that treats OpenCode as an interactive
 * HOST surface — a server that holds a session's task/progress state — when an
 * OpenCode server API is configured and reachable. It is NOT the OpenCode
 * *Agent runner*: that runner stays a headless, API-auth Worker (see
 * `opencode-env.ts` and `taskMirrorCapability("opencode") === headless` in
 * `mirror.ts`). Host mirroring is a separate, opt-in surface layered on top; it
 * changes neither runner selection nor AFK execution semantics.
 *
 * The sink is capability-gated by construction:
 *
 *   no host client configured        → no-op + NO_SERVER notice (headless path intact)
 *   client present, server unreachable → no-op + UNREACHABLE notice
 *   client present, server reachable   → publish the SHARED mirror plan
 *
 * The mapping itself is not reinvented: the desired Worker set is reconciled
 * against the tasks the server already holds via the shared {@link mirrorPlan},
 * so host mirroring speaks the exact same macro phase (`[n/5 <phase>]`) and micro
 * activity (`activity: <x>`) vocabulary as the native Claude Task mirror. The OpenCode
 * server interactions are funnelled through {@link OpenCodeHostClient}, a small
 * fakeable seam so every branch is testable without a live OpenCode process.
 */

import { mirrorPlan, type MirrorCall, type TrackedTask, type WorkerRecord } from "./mirror.js";

/**
 * The minimum OpenCode server interactions the host sink needs, modelled as an
 * injectable seam so tests fake it (no live OpenCode process). All three calls
 * are async because real interactions are network round-trips. Implementations
 * MAY throw on transport failure — the sink treats any throw as "unreachable"
 * and degrades cleanly, so a host implementation need not swallow its own errors.
 */
export interface OpenCodeHostClient {
  /** Probe whether the host server API is configured AND reachable right now. */
  available(): Promise<boolean>;
  /** Read the tasks the server already tracks for a session (for reconcile). */
  readTasks(sessionId: string): Promise<TrackedTask[]>;
  /** Publish the reconciled task/progress plan to the session. */
  publishTasks(sessionId: string, calls: readonly MirrorCall[]): Promise<void>;
}

/** Outcome of one host-sink tick. */
export interface OpenCodeHostSinkResult {
  /** The plan applied to the host (empty when degraded or already steady-state). */
  plan: MirrorCall[];
  /** True only when the host server was reached and the plan was published. */
  mirrored: boolean;
  /** One-line operator notice, present only on the degraded (no-op) paths. */
  notice?: string;
}

export const OPENCODE_HOST_NO_SERVER_NOTICE =
  "afk: OpenCode host mirroring is off (no host server configured) — the OpenCode Agent runner stays headless; this is separate from running OpenCode as a headless runner.";

export const OPENCODE_HOST_UNREACHABLE_NOTICE =
  "afk: OpenCode host server is unreachable — falling back to no host mirror; the OpenCode Agent runner is unaffected and keeps running headless.";

/**
 * OpenCode half of the runner-specific Task-mirror sink, host-surface variant
 * (issue #888). The reader + reconciler + plan map are reused unchanged through
 * {@link mirrorPlan}; only the server I/O and the capability gate are new here.
 *
 *   client === undefined        → no-op + NO_SERVER notice (host mirroring off).
 *   client.available() falsy    → no-op + UNREACHABLE notice.
 *   any client call throws      → no-op + UNREACHABLE notice (clean degrade).
 *   server reachable            → reconcile vs server-held tasks, publish, mirror.
 *
 * Never throws: a host that cannot be reached degrades to the headless behaviour,
 * it does not fail the run.
 */
export async function openCodeHostSinkPlan(
  desired: readonly WorkerRecord[],
  client: OpenCodeHostClient | undefined,
  sessionId: string,
): Promise<OpenCodeHostSinkResult> {
  if (client === undefined) {
    return { plan: [], mirrored: false, notice: OPENCODE_HOST_NO_SERVER_NOTICE };
  }
  try {
    if (!(await client.available())) {
      return { plan: [], mirrored: false, notice: OPENCODE_HOST_UNREACHABLE_NOTICE };
    }
    const tracked = await client.readTasks(sessionId);
    const plan = mirrorPlan(desired, tracked);
    if (plan.length > 0) await client.publishTasks(sessionId, plan);
    return { plan, mirrored: true };
  } catch {
    // Transport / server error → degrade to the headless behaviour. The prototype
    // is reversible by design: a failing host never blocks the Worker.
    return { plan: [], mirrored: false, notice: OPENCODE_HOST_UNREACHABLE_NOTICE };
  }
}
