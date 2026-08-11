/**
 * worker-display — what a surface SHOWS about one Worker, as its project said it.
 *
 * **The project publishes; the daemon stores and lays out.** Every field here
 * travels on the heartbeat the Worker's own project already sends, exactly as its
 * last logged line does, and the daemon never reads one for meaning: no branch in
 * this process asks what a phase is, whether an origin is `afk` or `go`, or what
 * an issue number refers to. That is what keeps ADR 0130 rule 3 intact while the
 * dashboard reaches statusline parity — the frozen contract widens by one opaque
 * record, not by castle semantics.
 *
 * **The progress bar arrives as two integers, never as a vocabulary.** A daemon
 * that drew a pipeline bar would have to know the pipeline, and the phase order is
 * a per-project fact that changes on a bundle version the daemon does not track.
 * `phase_index` and `phase_total` are the whole of it: the renderer draws
 * `index` completed cells, one cursor and the remainder ahead, and stays ignorant
 * of what any of them are called.
 *
 * **Absent is `null`, never a zero.** A Worker whose project publishes no display
 * record and a Worker genuinely holding zero tokens are opposite facts, and a
 * surface that could not tell them apart would render an unmeasured row as an
 * idle one — the same failure `RedskilledStatuslineVitals` refuses for RSS.
 *
 * **`elapsed` is absent on purpose, and `started_at` is why.** Two surfaces that
 * each published their own elapsed figure would disagree about now the moment one
 * of them sampled a beat later; a start instant is a fact that cannot drift, and
 * the render subtracts it from the payload's own `generated_at`. One clock, read
 * once, in the process that is already dating the answer.
 *
 * PURE.
 */

/**
 * One Worker's display record, as its project published it.
 *
 * The field names are the statusline's own, so a reader comparing the dashboard
 * against the line it mirrors is comparing like with like rather than translating
 * between two vocabularies for the same fact.
 */
export interface RedskilledWorkerDisplay {
  /** The agent CLI driving this Worker (`claude`, `codex`, …). */
  readonly runner: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  /** Where the work came from (`afk`, `go`, `landing`, …), opaque here. */
  readonly origin: string | null;
  /** The work item this Worker is on, as a string the daemon never parses. */
  readonly issue: string | null;
  readonly phase: string | null;
  /** What the phase is doing right now — the statusline's `phase·step` tail. */
  readonly step: string | null;
  /** How many pipeline steps are behind this one; `null` when unstated. */
  readonly phase_index: number | null;
  /** How many steps the pipeline has at all; `null` when unstated. */
  readonly phase_total: number | null;
  /** True when the project reports this Worker blocked or failed. */
  readonly failed: boolean;
  /** Proof-of-life as the project spells it (`3s`, `~11m+`, `!4m`). */
  readonly heartbeat: string | null;
  /** A declared child-process wait. These fields are opaque project vocabulary:
   * the daemon stores them and renderers show them without interpreting the
   * command. `wait_started_at`, rather than the agent heartbeat, owns its age. */
  readonly wait_kind: string | null;
  readonly wait_subject: string | null;
  readonly wait_pid: number | null;
  readonly wait_started_at: string | null;
  readonly wait_deadline: string | null;
  readonly wait_escalation: string | null;
  /**
   * When this Worker started the work it is on, ISO-8601, as its project stamped it.
   *
   * The render derives `elapsed` from this against the payload's `generated_at`;
   * it is deliberately NOT the process start the daemon already holds, because a
   * Worker that took a second work item is a new span the host cannot see.
   */
  readonly started_at: string | null;
  /** When the current macro phase began, ISO-8601; null before it was witnessed. */
  readonly phase_started_at: string | null;
  /** Last LOC or commit movement, ISO-8601; the non-resetting stall anchor. */
  readonly progress_at: string | null;
  /**
   * Input-side tokens the last turn carried — the context window's occupancy.
   *
   * A count, not a fraction: the window's SIZE is a per-model fact neither the
   * daemon nor the render is told, and a percentage of an assumed ceiling is the
   * kind of precise-looking wrong number `eta` is refused for.
   */
  readonly context: number | null;
  /**
   * Seconds this Worker's project expects the work still to take; `null` when it
   * will not say.
   *
   * **Computed by the project, and by nobody else.** The render is stateless and
   * cannot accumulate the history an honest estimate needs; the daemon is
   * forbidden the semantics to know what a phase is (ADR 0130 rule 3). So it
   * travels as an opaque count, exactly as `tokens` does, and every surface prints
   * what it was handed.
   *
   * **A linear extrapolation from the progress bar is not an ETA.** `phase_index /
   * phase_total` moves with the bar, so it looks precise while being
   * systematically wrong — `coding` and `validating` do not cost the same. A
   * project with nothing better to say publishes `null`, and a dashboard that
   * lies about one figure loses its reader for all of them.
   */
  readonly eta: number | null;
  readonly added: number | null;
  readonly removed: number | null;
  readonly tokens: number | null;
  readonly tools: number | null;
  readonly reasoning: number | null;
  readonly text: number | null;
}

/** The record the daemon keeps: the published fields, and when they landed. */
export interface RedskilledWorkerDisplayRecord {
  readonly display: RedskilledWorkerDisplay;
  readonly published_at: string;
}

/**
 * How long a published display string may be.
 *
 * Clamped by the PUBLISHER, never by the daemon — the same split the log line
 * already answers to. The daemon shortening a value would be the daemon
 * interpreting content, and every surface clamps to its own width anyway; this
 * bound exists only so a runaway value cannot make a heartbeat expensive.
 */
export const REDSKILLED_DISPLAY_FIELD_MAX = 64;

/** A record that says nothing — the honest shape of a Worker that published none. */
export const REDSKILLED_WORKER_DISPLAY_ABSENT: RedskilledWorkerDisplay = {
  runner: null,
  model: null,
  effort: null,
  origin: null,
  issue: null,
  phase: null,
  step: null,
  phase_index: null,
  phase_total: null,
  failed: false,
  heartbeat: null,
  wait_kind: null,
  wait_subject: null,
  wait_pid: null,
  wait_started_at: null,
  wait_deadline: null,
  wait_escalation: null,
  started_at: null,
  phase_started_at: null,
  progress_at: null,
  context: null,
  eta: null,
  added: null,
  removed: null,
  tokens: null,
  tools: null,
  reasoning: null,
  text: null,
};

const TEXT_FIELDS = [
  "runner",
  "model",
  "effort",
  "origin",
  "issue",
  "phase",
  "step",
  "heartbeat",
  "wait_kind",
  "wait_subject",
  "wait_started_at",
  "wait_deadline",
  "wait_escalation",
  "started_at",
  "phase_started_at",
  "progress_at",
] as const;
const COUNT_FIELDS = [
  "phase_index",
  "phase_total",
  "wait_pid",
  "context",
  "eta",
  "added",
  "removed",
  "tokens",
  "tools",
  "reasoning",
  "text",
] as const;

/**
 * The published record, shape-checked and nothing more. PURE.
 *
 * A field the daemon cannot recognise as a string or a finite count becomes
 * `null` rather than failing the whole heartbeat: one project shipping a newer
 * bundle than another is the ordinary state of a host-scoped daemon (ADR 0130
 * rule 3), and refusing a Worker's whole record over one unreadable field would
 * lose the twelve it could read. `null` is returned only for a value that is not
 * an object at all — there is then nothing published to store.
 */
export function coerceWorkerDisplay(value: unknown): RedskilledWorkerDisplay | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const display: Record<string, unknown> = { ...REDSKILLED_WORKER_DISPLAY_ABSENT };
  for (const field of TEXT_FIELDS) {
    const candidate = raw[field];
    display[field] = typeof candidate === "string" && candidate.trim() !== "" ? candidate : null;
  }
  for (const field of COUNT_FIELDS) {
    const candidate = raw[field];
    display[field] = typeof candidate === "number" && Number.isFinite(candidate) ? candidate : null;
  }
  display.failed = raw.failed === true;
  return display as unknown as RedskilledWorkerDisplay;
}

/**
 * The publisher's own clamp, applied before the record goes on the wire. PURE.
 *
 * Here rather than in the daemon for the reason {@link REDSKILLED_DISPLAY_FIELD_MAX}
 * gives: the project owns its content, and a daemon that trimmed a value would be
 * reading it.
 */
export function clampPublishedWorkerDisplay(display: RedskilledWorkerDisplay): RedskilledWorkerDisplay {
  const clamped: Record<string, unknown> = { ...display };
  for (const field of TEXT_FIELDS) {
    const value = display[field];
    clamped[field] = value == null ? null : value.slice(0, REDSKILLED_DISPLAY_FIELD_MAX);
  }
  return clamped as unknown as RedskilledWorkerDisplay;
}

/** True when `value` is a complete display record — a consumer's fail-closed check. */
export function isRedskilledWorkerDisplay(value: unknown): value is RedskilledWorkerDisplay {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const display = value as Record<string, unknown>;
  if (typeof display.failed !== "boolean") return false;
  for (const field of TEXT_FIELDS) {
    if (display[field] !== null && typeof display[field] !== "string") return false;
  }
  for (const field of COUNT_FIELDS) {
    const candidate = display[field];
    if (candidate !== null && !(typeof candidate === "number" && Number.isFinite(candidate))) return false;
  }
  return true;
}
