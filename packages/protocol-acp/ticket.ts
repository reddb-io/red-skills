// ticket — the Ticket handoff the daemon puts on a Worker's turn (issue #4020).
//
// ADR 0148's cut says WHETHER, WHEN AND WHERE a Worker exists is the daemon's;
// what it then DOES with the turn is the body's. The handoff is where those two
// meet, so it is wire: the daemon names the Ticket, the trunk, the labels and
// the budget the operator declared, and `@reddb-io/worker`'s Ticket loop runs
// the arc — claim, implement, gate, re-seed, publish, land — against it.
//
// Three things the handoff deliberately does NOT carry, and the reason each is
// absent:
//
//   - **A credential, a remote or a Project.** Every write leaves the Worker as
//     a request; naming the target here would make the Worker the chooser of
//     where its work lands (ADR 0144 §3).
//   - **A run mode the Worker picks.** `run_mode` is stated BY the daemon and
//     checked against the lane the labels carry, which is the drift issue #3026
//     was written about: a Ticket whose lane implies a mode the Worker does not
//     hold must be refused before the claim, not after the push.
//   - **A gate verdict.** The gate runs locally, inside the turn, because a
//     verdict computed elsewhere cannot be what a re-seed reacts to (ADR 0129).
//
// ## The brief is a REQUIRED field with a shape, not just a non-empty string
//
// Ticket #4139 made the brief contract the decoder's business. `handoff` was
// already required to be non-empty, which only ever refused the empty string;
// a brief reading "make it better" decoded cleanly and cost a Worker its whole
// workspace to discover it could not be finished. So the decoder now asks the
// same question the triage promotion asks — does this brief carry executable
// acceptance criteria? — and refuses the handoff when it does not, exactly the
// way it refuses a missing `base`.
//
// The refusal is `undefined` rather than a throw, unchanged and for the
// original reason: the same Worker body serves ordinary prompt turns, so a
// decoder that threw would fail every turn that never claimed to carry a
// Ticket. What that costs is a diagnostic, which is why the door AFTER this one
// — the Worker preflight in the Ticket loop — states the refusal in words.

import { briefStatesExecutableAcceptance } from "@reddb-io/shared/brief-contract.js";

/** One Ticket, as the daemon hands it to the Worker body for a turn. */
export interface RedskillsTicketHandoff {
  /** The Ticket number on the Issue tracker. */
  readonly number: number;
  /** The pull request title the landing request will carry. */
  readonly title: string;
  /** The Ticket's labels; the lane among them implies the required run mode. */
  readonly labels: readonly string[];
  /** The trunk the branch is measured and landed against. */
  readonly base: string;
  /** What the implementer is told to do on the first round. */
  readonly handoff: string;
  /** This Worker's host-scoped identity, as it appears in the claim marker. */
  readonly worker_id: string;
  /** The runner behind the child Agent, recorded on the claim. */
  readonly runner?: string;
  /** The mode this Worker holds, checked against the lane before the claim. */
  readonly run_mode?: string;
  /** How many times the implementer may be re-instructed IN PLACE. */
  readonly reseed_budget?: number;
  /** The operator's extra gate commands, run after feedback and only if it passed. */
  readonly backpressure_commands?: readonly string[];
  /**
   * The project's DECLARED local gate (#4166). When present, the Worker runs
   * exactly these commands as its feedback stage instead of improvising a
   * package-cone suite — the declared schedule is the sole local validation
   * authority, and an improvised full suite both contradicts it and flakes
   * under the Worker's memory ceiling.
   */
  readonly validation_commands?: readonly string[];
  /**
   * The operator's standing orders, verbatim (Spec #4129, #4141).
   *
   * Its OWN field, and that is the whole point. The daemon used to splice the
   * orders onto the front of `handoff`, which made them indistinguishable from
   * the brief: the brief contract linted them as if they were acceptance
   * criteria, a re-seed's replacement text dropped them, and the Worker had no
   * way to render them as the authoritative block the exit protocol names. A
   * directive that survives every respawn has to travel as a directive.
   *
   * Refined like its peers — DROPPED, never refused, when malformed. An
   * operator's typo in their orders should cost the orders, not the Ticket:
   * refusing the handoff would strand the work with no channel to say why.
   */
  readonly standing_orders?: string;
}

/** The six fields a handoff must state; the rest are refinements. */
type RequiredTicketFields = Pick<
  RedskillsTicketHandoff,
  "number" | "title" | "labels" | "base" | "handoff" | "worker_id"
>;

/**
 * The Ticket a turn's `_meta` carries, or `undefined` when it carries none.
 *
 * A turn without a Ticket is not an error: the same Worker body serves ordinary
 * prompt turns, and a parser that threw would make every one of them fail on
 * the absence of something they never claimed to have. A MALFORMED Ticket is
 * refused the same way, and since #4139 a vague brief counts as malformed.
 */
export function ticketHandoffFromMeta(meta: unknown): RedskillsTicketHandoff | undefined {
  const candidate = (meta as { redskills?: { ticket?: unknown } } | undefined)?.redskills?.ticket;
  if (candidate == null || typeof candidate !== "object") return undefined;
  const ticket = candidate as Record<string, unknown>;
  if (!statesRequiredTicketFields(ticket)) return undefined;
  if (!briefStatesExecutableAcceptance(ticket.handoff)) return undefined;
  return {
    number: ticket.number,
    title: ticket.title,
    labels: ticket.labels,
    base: ticket.base,
    handoff: ticket.handoff,
    worker_id: ticket.worker_id,
    ...optionalTicketFields(ticket),
  };
}

/** Every required field present, of the right type, and non-empty. */
function statesRequiredTicketFields(
  ticket: Record<string, unknown>,
): ticket is Record<string, unknown> & RequiredTicketFields {
  return (
    typeof ticket.number === "number" && Number.isInteger(ticket.number) && ticket.number > 0 &&
    typeof ticket.title === "string" && ticket.title !== "" &&
    typeof ticket.base === "string" && ticket.base !== "" &&
    typeof ticket.handoff === "string" && ticket.handoff !== "" &&
    typeof ticket.worker_id === "string" && ticket.worker_id !== "" &&
    isStringArray(ticket.labels)
  );
}

/**
 * The refinements a handoff may carry, each DROPPED rather than refused when it
 * is malformed: an operator's typo in a backpressure list should cost the list,
 * never the Ticket.
 */
function optionalTicketFields(ticket: Record<string, unknown>): Partial<RedskillsTicketHandoff> {
  return {
    ...(typeof ticket.runner === "string" ? { runner: ticket.runner } : {}),
    ...(typeof ticket.run_mode === "string" ? { run_mode: ticket.run_mode } : {}),
    ...(typeof ticket.reseed_budget === "number" && Number.isFinite(ticket.reseed_budget)
      ? { reseed_budget: Math.max(0, Math.trunc(ticket.reseed_budget)) }
      : {}),
    ...(isStringArray(ticket.backpressure_commands)
      ? { backpressure_commands: ticket.backpressure_commands }
      : {}),
    ...(isStringArray(ticket.validation_commands)
      ? { validation_commands: ticket.validation_commands }
      : {}),
    ...(typeof ticket.standing_orders === "string" && ticket.standing_orders.trim() !== ""
      ? { standing_orders: ticket.standing_orders }
      : {}),
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
