/**
 * brief-refusal-turn — what a Worker does when the brief it was handed is one
 * the contract refuses (#4296).
 *
 * **A Worker handed a brief nobody can execute must END THE TURN SAYING SO.**
 * Before this, the wire decoder answered `undefined` for a refused brief and
 * the Worker read that as "this turn carries no Ticket": it took the ordinary
 * prompt path, echoed, and ended `no-workflow-outcome (end_turn)`. The daemon
 * saw a healthy turn over a Ticket that never left `ready-for-agent`, so the
 * planner birthed another Worker on the next tick — ~60 of them on one item,
 * ~15s apart, on an operator's machine.
 *
 * The refusal travels the way every other terminal Ticket verdict travels:
 * `_meta.redskills.ticket`, so `describeTurnOutcome` names it and the daemon's
 * single park door can act on it. Nothing new is invented for it — a second
 * channel for one more terminal outcome is a second thing the daemon has to
 * learn to read.
 *
 * The brief is NOT re-linted here. The decision arrives already made from the
 * wire decoder, carrying the contract's own sentence, because a refusal that
 * re-derives its reason is a refusal that can disagree with the door that
 * refused.
 */
import { methods, type AgentContext, type PromptResponse } from "@agentclientprotocol/sdk";
import { decodeTicketHandoff, type TicketHandoffDecision } from "@reddb-io/protocol-acp";

/**
 * The stage a wire-door brief refusal names.
 *
 * Deliberately NOT one of {@link import("./ticket-loop.js").TicketLoopStage}'s
 * five: the loop never ran. A reader who sees `refused at brief` knows no claim
 * was placed, no Worktree was touched and no comment was written — which is
 * exactly the difference between this and the loop's own `refused at claim`.
 */
export const TICKET_BRIEF_REFUSAL_STAGE = "brief";

/**
 * Which Ticket decision governs this turn: the prompt's, else the session's.
 * PURE.
 *
 * The prompt's `_meta` wins whenever it states ANYTHING — a handoff or a
 * refusal — because that is the Ticket this turn was opened for. The session's
 * is the fallback for the daemon that stated the Ticket once, at `session/new`,
 * and prompts against it afterwards. A refusal on either side is still a
 * refusal: an absent decision may never launder one.
 */
export function ticketDecisionForTurn(
  turnMeta: unknown,
  sessionMeta: unknown,
): TicketHandoffDecision {
  const fromTurn = decodeTicketHandoff(turnMeta);
  return fromTurn.kind === "absent" ? decodeTicketHandoff(sessionMeta) : fromTurn;
}

/**
 * The turn's answer for a refused brief: terminal, named, and carrying the
 * contract's sentence. PURE.
 *
 * `end_turn` rather than a cancellation: nothing was interrupted, the Worker
 * read its instructions and found them unexecutable. `workflowOutcome` stays
 * absent for the same reason a gate block leaves it absent — only a landed
 * Ticket is a completion, and naming this one would tell the daemon to close a
 * Ticket nothing shipped.
 */
export function briefRefusalResponse(reason: string): PromptResponse {
  return {
    stopReason: "end_turn",
    _meta: {
      redskills: {
        ticket: {
          outcome: "refused",
          stage: TICKET_BRIEF_REFUSAL_STAGE,
          detail: reason,
        },
      },
    },
  } satisfies PromptResponse;
}

/**
 * Say the refusal out loud on the session, before the turn's answer carries it.
 *
 * Two readers, one notification: the sentence goes in the transcript a human
 * reads, and the `ticketStage` cell moves the statusline's phase to `brief!` so
 * an operator watching a drain sees WHICH item stopped and why without opening
 * a log.
 */
export function notifyBriefRefusal(
  parent: AgentContext,
  sessionId: string,
  reason: string,
): Promise<void> {
  return parent.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `${reason}\n` },
    },
    _meta: {
      redskills: {
        lifecycle: { event: `ticket-${TICKET_BRIEF_REFUSAL_STAGE}-blocked` },
        ticketStage: { stage: TICKET_BRIEF_REFUSAL_STAGE, ok: false, detail: reason },
      },
    },
  });
}
