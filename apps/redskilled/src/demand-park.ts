// demand-park — a demand turn whose verdict is terminal moves its Ticket out of
// the queue.
//
// #4160: two Workers finished `gate-blocked at feedback` on one Ticket and the
// Ticket kept `ready-for-agent`, so every freed slot re-birthed a Worker for
// the same head item — claim spam, duplicate work, an infinite grinder on one
// issue. A verdict that changes nothing on the tracker is indistinguishable
// from no verdict: the park is what makes the queue advance.
//
// #4296 arrived at the same grinder by a different road: a brief the contract
// refuses. Nothing was gated, because nothing was claimed — the Worker read the
// handoff, found the acceptance criteria unexecutable, and ended the turn. Same
// consequence, so the same door: **ONE park, two terminal verdicts.** A second
// door would be a second place to forget the `ready-for-agent` removal, and the
// removal is the only part the loop actually depends on.
//
// The two verdicts differ in what they blame and therefore in what they park
// under. A gate that blocked is `blocked:validation` — the code failed. A brief
// the contract refuses is `blocked:spec`: nothing is wrong with the tree, the
// Ticket's own words cannot be executed, and the repair is a human rewriting
// the acceptance criteria.
//
// The transition itself is the Worker engine's own planner (`planTransition`,
// the single owner of state-label mutations), fed the label vocabulary the
// PROJECT declares in its `.red/config.yaml` — the daemon spells no label of
// its own. The write travels as one authorized `issue-transition` mutation
// through the Project-bound gateway, exactly like every other Worker write.

import { resolve } from "node:path";

import {
  isRefused,
  loadEngineConfig,
  planTransition,
  readEngineLabelVocabulary,
} from "@reddb-io/worker/engine";
import type { RedskilledGithubWriteRequest } from "@reddb-io/protocol-acp";

import { bindAcpProjectGithubWrite } from "./acp-github.js";
import type { RedskilledGithubGatewayRegistration } from "./github-gateway.js";
import type { AcpProjectWorkspace } from "./project-workspace.js";

/**
 * The Ticket verdicts this module acts on; every other outcome passes by.
 *
 * `gate-blocked` names the stage that failed. `brief-refused` names none: the
 * loop never started, so there is no stage to report — only the sentence the
 * contract wrote.
 */
export type ParkVerdict =
  | { readonly kind: "gate-blocked"; readonly failedStage: string; readonly detail?: string }
  | { readonly kind: "brief-refused"; readonly detail: string };

/**
 * The stage a wire-door brief refusal names, mirroring the Worker's own
 * `TICKET_BRIEF_REFUSAL_STAGE`. Spelled here rather than imported because it is
 * WIRE: the daemon reads whatever the running bundle sent, and a bundle old
 * enough to send no stage at all must still be readable as "not a brief refusal".
 */
const BRIEF_REFUSAL_STAGE = "brief";

/**
 * Read a turn's Ticket verdict and answer only when the queue must not serve
 * this item again. PURE.
 *
 * A `refused` verdict from any OTHER stage passes by, deliberately: the Ticket
 * loop refuses at `claim` for a failed claim write and at `land` for a landing
 * the forge rejected, and both of those are worth retrying. Only the brief
 * refusal is known to be identical on the next birth, which is what makes it
 * the one refusal a park may act on.
 */
export function parkVerdictOf(response: { readonly _meta?: unknown }): ParkVerdict | null {
  const ticket = (response._meta as { redskills?: { ticket?: unknown } } | undefined)
    ?.redskills?.ticket;
  if (ticket == null || typeof ticket !== "object") return null;
  const verdict = ticket as {
    outcome?: unknown;
    stage?: unknown;
    failedStage?: unknown;
    detail?: unknown;
  };
  if (verdict.outcome === "gate-blocked") {
    return {
      kind: "gate-blocked",
      failedStage: typeof verdict.failedStage === "string" ? verdict.failedStage : "feedback",
      ...(typeof verdict.detail === "string" ? { detail: verdict.detail } : {}),
    };
  }
  if (
    verdict.outcome === "refused" &&
    verdict.stage === BRIEF_REFUSAL_STAGE &&
    typeof verdict.detail === "string" &&
    verdict.detail !== ""
  ) {
    return { kind: "brief-refused", detail: verdict.detail };
  }
  return null;
}

/**
 * Which `blocked:*` reason a verdict parks under, and the sentence an operator
 * reads above the detail block. PURE.
 *
 * Split out because the two halves answer to different owners: the reason is
 * the PROJECT's declared label vocabulary, and the sentence is this module's
 * account of what happened. Keeping them in one place is what stops a third
 * verdict from arriving with a label and no explanation.
 */
function parkReasonFor(
  verdict: ParkVerdict,
  blockedPrefix: string,
): { readonly reason: string; readonly headline: string; readonly detail: string | undefined } {
  if (verdict.kind === "gate-blocked") {
    return {
      reason: `${blockedPrefix}validation`,
      headline: `the local gate blocked at \`${verdict.failedStage}\``,
      detail: verdict.detail,
    };
  }
  return {
    reason: `${blockedPrefix}spec`,
    headline:
      "this Ticket's brief cannot be executed as written, so no Worker claimed it " +
      "and no work was done",
    detail: verdict.detail,
  };
}

/**
 * Compose the one tracker mutation that parks a Ticket whose turn ended
 * terminally, or say why none can be composed. The refusal is a sentence, not a
 * throw: a park the planner refuses (a dependency edge still standing, a
 * vocabulary conflict) is an outcome the demand record must carry, never a dead
 * Worker.
 */
export function parkWrite(input: {
  readonly workspacePath: string;
  readonly ticket: { readonly number: number; readonly labels: readonly string[] };
  readonly workerId: string;
  readonly verdict: ParkVerdict;
}): { readonly request: RedskilledGithubWriteRequest; readonly summary: string } | { readonly refusal: string } {
  const vocabulary = readEngineLabelVocabulary(
    loadEngineConfig(resolve(input.workspacePath, ".red"), { warn: () => undefined }),
  );
  const parked = parkReasonFor(input.verdict, vocabulary.blockedPrefix);
  const plan = planTransition(
    input.ticket.labels,
    { kind: "park", reason: parked.reason },
    vocabulary,
  );
  if (isRefused(plan)) return { refusal: plan.reason };
  const detail = parked.detail == null
    ? ""
    : `\n\n\`\`\`\n${parked.detail.slice(0, 800)}\n\`\`\``;
  return {
    summary: `parked #${input.ticket.number}: +[${plan.add.join(", ")}] -[${plan.remove.join(", ")}]`,
    request: {
      idempotency_key: `park:${input.ticket.number}:${input.workerId}`,
      write: {
        kind: "issue-transition",
        issue: input.ticket.number,
        add: plan.add,
        remove: plan.remove,
        comment:
          `🤖 AFK park by worker \`${input.workerId}\`: ${parked.headline}.${detail}\n\n` +
          `Requeue with \`/retake ${input.ticket.number}\` once the blocker is repaired.`,
      },
    },
  };
}

/**
 * The executor the demand-turn runner calls after a completed Ticket turn.
 *
 * Answers a one-line record of what it did — a park summary, a stated refusal,
 * or `null` when the verdict was neither terminal one — and never throws for a
 * park that could not happen: the turn already finished, and the only thing
 * left to protect is the operator's ability to read why the queue did or did
 * not advance.
 */
export function parkTerminalTurn(
  gateway: RedskilledGithubGatewayRegistration | undefined,
): (
  project: AcpProjectWorkspace,
  ticket: Readonly<Record<string, unknown>>,
  response: { readonly _meta?: unknown },
  workerId: string,
) => Promise<string | null> {
  return async (project, ticket, response, workerId) => {
    const verdict = parkVerdictOf(response);
    if (verdict == null) return null;
    // The turn's ticket is opaque wire until read here, exactly once.
    const number = Number(ticket.number);
    const labels = Array.isArray(ticket.labels)
      ? ticket.labels.filter((label): label is string => typeof label === "string")
      : [];
    if (!Number.isInteger(number) || number <= 0) {
      return `park refused: the turn's ticket names no issue number`;
    }
    const composed = parkWrite({
      workspacePath: project.workspacePath,
      ticket: { number, labels },
      workerId,
      verdict,
    });
    if ("refusal" in composed) return `park refused for #${number}: ${composed.refusal}`;
    const write = bindAcpProjectGithubWrite(gateway, () => project);
    await write({ params: composed.request });
    return composed.summary;
  };
}
