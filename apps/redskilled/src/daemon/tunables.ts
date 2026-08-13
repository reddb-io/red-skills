// Daemon intervals and the two bounded log readers. Each number carries the
// reasoning that fixes it, because a timing constant with no stated coupling
// is one the next reader moves freely.
import { type RedskilledHostEvent,
} from "../event-lane.js";
import { type RedskilledDeathObservation,
} from "../statusline-payload.js";
/**
 * Default idle window before a Worker-free daemon leaves.
 *
 * **Shorter than `DEFAULT_REDSKILLED_REPLACE_CHECK_MS` (fifteen minutes), which
 * is why the idle exit asks about the published version on its way out.** A quiet
 * host's daemon leaves three times over before that interval's first tick, so an
 * upgrade that only ever rode the timer could not fire here at all (#2968) — and
 * the failure hid itself, because a daemon born after a release reports the right
 * version without ever having upgraded. `leaveIdleSession` is the coupling; these
 * two numbers may move freely, in either direction, without reintroducing it.
 */
export const DEFAULT_REDSKILLED_IDLE_MS = 300_000;

/**
 * How long a published-version read may take before it counts as unresolved.
 *
 * A bound rather than a preference: the shipped probe is a `fetch` with no
 * timeout of its own, and the idle exit now waits on one — a registry that
 * accepts the connection and never answers would otherwise strand a daemon that
 * had already decided to leave, holding the session for a host that wanted none.
 * A read that runs out of time resolves to whatever this host can say WITHOUT
 * the registry — the cached bundle — and to UNKNOWN when it can say nothing.
 */
export const DEFAULT_REDSKILLED_PUBLISHED_PROBE_TIMEOUT_MS = 10_000;

/**
 * How long after starting a daemon takes its FIRST published-version look.
 *
 * **The busy daemon's blind spot, and the one the idle exit cannot cover.** A
 * daemon that only ever looks on the interval spends its first fifteen minutes
 * unable to know anything at all, and a daemon holding a registration never
 * reaches the idle boundary that would have asked — so a release published into
 * that window is served past for a whole interval, with `checks: 0` looking
 * exactly like a timer that is broken (#2975). One look shortly after boot makes
 * the daemon's own answer say which.
 *
 * Deliberately a minute rather than instant: a successor that mis-resolves its
 * own version would otherwise restart itself as fast as it could boot. A
 * replacement's own child skips this look entirely
 * (`REDSKILLED_BORN_BY_REPLACEMENT_ENV`) and waits for the ordinary interval.
 */
export const DEFAULT_REDSKILLED_REPLACE_BOOT_CHECK_MS = 60_000;

/**
 * Default window between memory samples.
 *
 * A whole-set sample is one pass over the process table, so the interval is
 * chosen for how fast a runaway must be caught rather than for how many Workers
 * are running — the cost does not move with the Worker count.
 */
export const DEFAULT_REDSKILLED_SAMPLE_MS = 15_000;

/**
 * Default window between lease renewals.
 *
 * A lease whose `renewed_at` never moves is worse than one without the field: it
 * reads as a five-hour-stale record on a daemon that has been serving for five
 * hours, and it invites exactly the freshness check that would then be
 * permanently wrong about a healthy host (#3092). Renewal is a one-file rewrite,
 * so the window is chosen for how quickly a reader should be able to tell a live
 * holder from an abandoned record, not for cost.
 */
export const DEFAULT_REDSKILLED_LEASE_RENEW_MS = 30_000;

/**
 * How old a frozen lease must be before an unowned socket disproves it.
 *
 * Two missed renewals keep an ordinary start race authoritative while bounding
 * recovery from a live process that has already unlinked its socket.
 */
export const REDSKILLED_SOCKETLESS_LEASE_REAP_MS = DEFAULT_REDSKILLED_LEASE_RENEW_MS * 2;

/**
 * How often the daemon re-evaluates registration liveness.
 *
 * Registration liveness has its own belt: tracker cost may change the queue
 * cadence, but it may never stop the lease mechanism from firing. One minute is
 * comfortably inside the five-minute registration TTL and the repo's cache-warm
 * cadence band.
 */
export const DEFAULT_REDSKILLED_REGISTRATION_SUSTAIN_MS = 60_000;

/**
 * How many lapsed registrations the daemon keeps where a reader can see them.
 *
 * A tail, not a history: the question a lapse block answers is "did my drain stop,
 * and when", which is asked about the last few — and an unbounded list on a
 * long-lived host is a leak wearing the shape of an audit trail.
 */
export const REDSKILLED_LAPSE_MEMORY = 16;

/** Project one durable host event into the loss shape every renderer consumes. */

export function observedWorkerDeath(
  event: RedskilledHostEvent,
  context: { readonly startedAt?: string; readonly refusal?: string } = {},
): RedskilledDeathObservation | null {
  if (event.event !== "worker-death" && event.event !== "worker-budget-kill") return null;
  if (event.event === "worker-death" && event.exit_code === 0) return null;
  const hostEndedWorker = event.event === "worker-budget-kill";
  const bootRefused = !hostEndedWorker && context.refusal != null;
  const unitOom = !hostEndedWorker && !bootRefused && event.systemd_result === "oom-kill";
  const signalled = !hostEndedWorker && !bootRefused && event.signal != null;
  const unitAttributed = !hostEndedWorker && !bootRefused && event.systemd_result != null;
  const observation = context.refusal ?? event.detail ??
    `redskilled observed exit code=${event.exit_code ?? "null"} signal=${event.signal ?? "null"}`;
  const startedAt = context.startedAt == null ? null : Date.parse(context.startedAt);
  const endedAt = Date.parse(event.ts);
  const uptimeS = startedAt != null && Number.isFinite(startedAt) && Number.isFinite(endedAt)
    ? Math.max(0, endedAt - startedAt) / 1_000
    : undefined;
  return {
    version: 1,
    ts: event.ts,
    kind: "worker",
    id: event.worker_id,
    pid: event.pid,
    // The daemon observed the loss at this instant; an early Worker published no
    // finer heartbeat or phase, and inventing either would be worse than saying so.
    last_seen: event.ts,
    last_phase: bootRefused ? "boot-refused" : "unreported",
    sender_class: hostEndedWorker ? "teardown" : bootRefused ? "boot-refused" : unitOom ? "oomd" : signalled ? "user-signal" : "unknown",
    confidence: hostEndedWorker || bootRefused || signalled || unitAttributed ? "high" : "none",
    signal: event.signal,
    host_boot_changed: false,
    // A budget kill is the daemon's own act and therefore evidence. A spontaneous
    // exit has an observation but no known sender; keep that receipt under
    // `checked` so `unknown` remains honest rather than becoming a guessed cause.
    evidence: hostEndedWorker || bootRefused || signalled || unitAttributed ? [observation] : [],
    checked: bootRefused ? ["Worker log tail"] : [`redskilled host event: ${observation}`],
    project_label: event.project_label,
    ...(uptimeS === undefined ? {} : { uptime_s: uptimeS }),
    detail: context.refusal ?? event.detail,
    observed_exit: event.exit_code != null || event.signal != null || event.systemd_result != null,
  };
}

/** The explicit boot-guard refusal from one bounded log-tail read, if present. PURE. */
export function bootRefusalFromLog(line: string | null): string | null {
  const refusal = line?.match(/\bsession-error:\s*(.+)$/)?.[1]?.trim();
  return refusal == null || refusal === "" ? null : refusal;
}
