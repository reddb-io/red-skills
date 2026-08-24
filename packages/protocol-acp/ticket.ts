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
// The refusal is not a throw, unchanged and for the original reason: the same
// Worker body serves ordinary prompt turns, so a decoder that threw would fail
// every turn that never claimed to carry a Ticket.
//
// ## Absent and refused are not the same answer (#4296)
//
// #4139 spelled the brief refusal as `return undefined`, "exactly the way it
// refuses a missing `base`". At this door `undefined` means **no Ticket
// handoff**, and the Worker's fallback for that is not a refusal — it is the
// ordinary prompt path: echo the prompt, end the turn. So a Ticket the contract
// rejected produced `no-workflow-outcome (end_turn)`, the daemon read a healthy
// turn, the item kept `ready-for-agent`, and the planner birthed again every
// ~15s. Observed on an operator's host: ~60 Workers on one item, twice.
//
// **A fail-closed check that answers `undefined` into a path whose fallback is
// "echo" is not fail-closed; it is fail-silent-and-loop.** The missing-`base`
// precedent it copied is safe only because a daemon never states a handoff
// without a base — it never states one with a brief it composed itself either,
// which is precisely why a refused brief has to reach the Worker as a REASON.
//
// So the decoder answers a decision: `absent` (nothing claimed a Ticket, or the
// shape is not one — the legal prompt-turn answer, unchanged), `refused` (a
// complete handoff arrived and the brief contract rejected it, carrying the
// contract's own sentence), or the handoff itself. `ticketHandoffFromMeta` is
// kept as the yes/no reading of that decision, so every caller that only wants
// a handoff is unchanged.

import { briefContractStructuralRefusal } from "@reddb-io/shared/brief-contract.js";

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
  /** The daemon won the remote claim before birth; the Worker must not post it twice. */
  readonly preclaimed?: true;
}

/** The six fields a handoff must state; the rest are refinements. */
type RequiredTicketFields = Pick<
  RedskillsTicketHandoff,
  "number" | "title" | "labels" | "base" | "handoff" | "worker_id"
>;

/**
 * What one turn's `_meta` says about a Ticket, in the three answers that differ.
 *
 * `absent` and `refused` are separate cases on purpose: they used to share
 * `undefined`, and the Worker's handling of "absent" is to run an ordinary
 * prompt turn — which turned a refused brief into a silent echo and an endless
 * re-birth (#4296).
 */
export type TicketHandoffDecision =
  /**
   * This turn claims no Ticket — nothing under `_meta.redskills.ticket`, or a
   * shape that is not a handoff. The legal prompt-turn answer, and the reason
   * a malformed shape stays here: an ordinary turn's unrelated `_meta` must
   * not be read as a Ticket somebody got wrong.
   */
  | { readonly kind: "absent" }
  /**
   * A complete handoff arrived and the brief contract rejected it. The reason
   * is the lint's own sentence, verbatim, because whoever is sent back needs
   * to know which acceptance-criteria item to fix.
   */
  | { readonly kind: "refused"; readonly reason: string }
  /** A handoff the decoder accepts, refinements included. */
  | { readonly kind: "handoff"; readonly ticket: RedskillsTicketHandoff };

/**
 * Read a turn's `_meta` into the decision it states. PURE.
 *
 * A turn without a Ticket is not an error: the same Worker body serves ordinary
 * prompt turns, and a parser that threw would make every one of them fail on
 * the absence of something they never claimed to have. A structurally malformed
 * Ticket is `absent` for the same reason — the wire decoder still refuses every
 * invalid shape exactly as it did. A brief the contract rejects is `refused`,
 * and it is the one refusal that keeps its reason: the daemon composed that
 * brief itself, so somebody upstream can act on the sentence.
 */
export function decodeTicketHandoff(meta: unknown): TicketHandoffDecision {
  const candidate = (meta as { redskills?: { ticket?: unknown } } | undefined)?.redskills?.ticket;
  if (candidate == null || typeof candidate !== "object") return { kind: "absent" };
  const ticket = candidate as Record<string, unknown>;
  if (!statesRequiredTicketFields(ticket)) return { kind: "absent" };
  const refusal = briefContractStructuralRefusal(ticket.handoff);
  if (refusal != null) return { kind: "refused", reason: refusal };
  return {
    kind: "handoff",
    ticket: {
      number: ticket.number,
      title: ticket.title,
      labels: ticket.labels,
      base: ticket.base,
      handoff: ticket.handoff,
      worker_id: ticket.worker_id,
      ...optionalTicketFields(ticket),
    },
  };
}

/**
 * The Ticket a turn's `_meta` carries, or `undefined` when it carries none the
 * decoder accepts.
 *
 * The yes/no reading of {@link decodeTicketHandoff}, for the callers that only
 * ever wanted a handoff. A caller that must tell a refusal from an absence — the
 * Worker deciding what KIND of turn this is — asks the decision instead.
 */
export function ticketHandoffFromMeta(meta: unknown): RedskillsTicketHandoff | undefined {
  const decision = decodeTicketHandoff(meta);
  return decision.kind === "handoff" ? decision.ticket : undefined;
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
    ...(ticket.preclaimed === true ? { preclaimed: true as const } : {}),
  };
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}
