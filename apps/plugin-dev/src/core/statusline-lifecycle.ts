/**
 * The visible state of the statusline's one read from redskilled.
 *
 * `live` is deliberately quiet: current data is its own evidence. Every other
 * state replaces the daemon tail with one compact token, except a deadline miss
 * with a last-known tail, where the old data stays visible beside its age and
 * the `degraded` token.
 */
import { formatAgeSeconds } from "@reddb-io/redskilled-render";

/**
 * What the statusline can say about its own daemon read, in an operator's words.
 *
 * The vocabulary is deliberately plain: these strings are read in a prompt by
 * someone who is doing something else, so each one has to answer "what is wrong
 * and is it mine to fix" without a glossary. `bedrock-only`, `registering` and
 * `unregistered` named the MECHANISM; `no-daemon`, `joining` and `no-producer`
 * name the SITUATION.
 */
export type StatuslineLifecycleState =
  /** The socket did not answer, or the probe is switched off. */
  | "no-daemon"
  /** The probe is in flight and has said nothing yet. */
  | "connecting"
  /** The handshake for this repository is in flight. */
  | "joining"
  /** The daemon is up and NOTHING is draining this repository. */
  | "no-producer"
  /** Current data. Renders no badge at all — health is its own evidence. */
  | "live"
  /** Real data, past its freshness window. Renders its AGE, never a word. */
  | "stale";

export type StatuslineSocketProbe = "disabled" | "connecting" | "unreachable" | "answered";
export type StatuslineRegistrationPresence = "pending" | "absent" | "present";

export interface StatuslineLifecycleInput {
  readonly probe: StatuslineSocketProbe;
  readonly registration?: StatuslineRegistrationPresence;
  readonly payloadAgeMs?: number | null;
  readonly stalenessWindowMs?: number;
  /** A daemon may call a payload stale for a reason other than age. */
  readonly payloadStale?: boolean;
}

/** Map wire facts to the one visible lifecycle state. PURE. */
export function resolveStatuslineLifecycle(input: StatuslineLifecycleInput): StatuslineLifecycleState {
  if (input.probe === "disabled" || input.probe === "unreachable") return "no-daemon";
  if (input.probe === "connecting") return "connecting";
  if (input.registration === "pending") return "joining";
  if (input.registration !== "present") return "no-producer";

  const agePastWindow =
    input.payloadAgeMs != null &&
    Number.isFinite(input.payloadAgeMs) &&
    input.stalenessWindowMs != null &&
    input.payloadAgeMs > input.stalenessWindowMs;
  return input.payloadStale === true || agePastWindow ? "stale" : "live";
}

/** The compact lifecycle token; healthy data carries no redundant badge. PURE. */
export function renderStatuslineLifecycleToken(state: StatuslineLifecycleState): string | null {
  return state === "live" ? null : `rsk=${state}`;
}

export interface LifecycleTailInput {
  readonly state: StatuslineLifecycleState;
  /** Whatever data this render HAS — this read's, or the last known one. */
  readonly tail?: readonly string[];
  /** How old that data is, when it can be established. */
  readonly ageMs?: number;
}

/**
 * Render the lifecycle-owned tail segment. PURE.
 *
 * **Data always wins over a word.** A tail that exists is rendered, whatever the
 * state, with a leading age badge saying how late it is. The rule this replaces
 * discarded the whole tail on any non-live read and printed one token in its
 * place, so an operator asking "how is the queue" got `rsk=degraded` — a report
 * about the reporter, in exchange for every number they wanted. Late numbers are
 * worth more than no numbers, and the badge is what keeps them honest.
 *
 * The badge leads rather than trails: it is the first thing after the bedrock,
 * so the age is read BEFORE the values it qualifies rather than discovered after
 * them.
 *
 * A bare state token is what remains when there is genuinely nothing to draw —
 * no daemon answered, or the handshake has not finished. That is the only case
 * where a word is the whole answer, because it is the whole truth.
 */
export function lifecycleTailLines(input: LifecycleTailInput): string[] {
  const tail = [...(input.tail ?? [])];
  if (input.state === "live") return tail;
  if (tail.length === 0) return [renderStatuslineLifecycleToken(input.state)!];

  const [head, ...rest] = tail;
  // The badge says the AGE only when lateness is the message. For every other
  // state the data may be perfectly fresh and the SITUATION is what the reader
  // needs: a repository nobody drains reads `rsk=no-producer`, not `age=5s`,
  // which would answer a question nobody asked.
  const age = input.state === "stale" && input.ageMs != null
    ? formatAgeSeconds(Math.max(0, input.ageMs)) ?? "0s"
    : null;
  const badge = age === null ? renderStatuslineLifecycleToken(input.state)! : `age=${age}`;
  return [`${badge} · ${head}`, ...rest];
}
