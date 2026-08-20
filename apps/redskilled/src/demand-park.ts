// demand-park — a gate-blocked demand turn moves its Ticket out of the queue.
//
// #4160: two Workers finished `gate-blocked at feedback` on one Ticket and the
// Ticket kept `ready-for-agent`, so every freed slot re-birthed a Worker for
// the same head item — claim spam, duplicate work, an infinite grinder on one
// issue. A verdict that changes nothing on the tracker is indistinguishable
// from no verdict: the park is what makes the queue advance.
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

/** The one Ticket verdict this module acts on; every other outcome passes by. */
export interface GateBlockedVerdict {
  readonly failedStage: string;
  readonly detail?: string;
}

/** Read a turn's Ticket verdict and answer only when the gate blocked. PURE. */
export function gateBlockedVerdictOf(response: {
  readonly _meta?: unknown;
}): GateBlockedVerdict | null {
  const ticket = (response._meta as { redskills?: { ticket?: unknown } } | undefined)
    ?.redskills?.ticket;
  if (ticket == null || typeof ticket !== "object") return null;
  const verdict = ticket as { outcome?: unknown; failedStage?: unknown; detail?: unknown };
  if (verdict.outcome !== "gate-blocked") return null;
  return {
    failedStage: typeof verdict.failedStage === "string" ? verdict.failedStage : "feedback",
    ...(typeof verdict.detail === "string" ? { detail: verdict.detail } : {}),
  };
}

/**
 * Compose the one tracker mutation that parks a gate-blocked Ticket, or say
 * why none can be composed. The refusal is a sentence, not a throw: a park the
 * planner refuses (a dependency edge still standing, a vocabulary conflict) is
 * an outcome the demand record must carry, never a dead Worker.
 */
export function gateBlockedParkWrite(input: {
  readonly workspacePath: string;
  readonly ticket: { readonly number: number; readonly labels: readonly string[] };
  readonly workerId: string;
  readonly verdict: GateBlockedVerdict;
}): { readonly request: RedskilledGithubWriteRequest; readonly summary: string } | { readonly refusal: string } {
  const vocabulary = readEngineLabelVocabulary(
    loadEngineConfig(resolve(input.workspacePath, ".red"), { warn: () => undefined }),
  );
  const plan = planTransition(
    input.ticket.labels,
    { kind: "park", reason: `${vocabulary.blockedPrefix}validation` },
    vocabulary,
  );
  if (isRefused(plan)) return { refusal: plan.reason };
  const detail = input.verdict.detail == null
    ? ""
    : `\n\n\`\`\`\n${input.verdict.detail.slice(0, 800)}\n\`\`\``;
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
          `🤖 AFK park by worker \`${input.workerId}\`: the local gate blocked at ` +
          `\`${input.verdict.failedStage}\`.${detail}\n\n` +
          `Requeue with \`/retake ${input.ticket.number}\` once the blocker is repaired.`,
      },
    },
  };
}

/**
 * The executor the demand-turn runner calls after a completed Ticket turn.
 *
 * Answers a one-line record of what it did — a park summary, a stated refusal,
 * or `null` when the verdict was not `gate-blocked` — and never throws for a
 * park that could not happen: the turn already finished, and the only thing
 * left to protect is the operator's ability to read why the queue did or did
 * not advance.
 */
export function parkGateBlockedTurn(
  gateway: RedskilledGithubGatewayRegistration | undefined,
): (
  project: AcpProjectWorkspace,
  ticket: Readonly<Record<string, unknown>>,
  response: { readonly _meta?: unknown },
  workerId: string,
) => Promise<string | null> {
  return async (project, ticket, response, workerId) => {
    const verdict = gateBlockedVerdictOf(response);
    if (verdict == null) return null;
    // The turn's ticket is opaque wire until read here, exactly once.
    const number = Number(ticket.number);
    const labels = Array.isArray(ticket.labels)
      ? ticket.labels.filter((label): label is string => typeof label === "string")
      : [];
    if (!Number.isInteger(number) || number <= 0) {
      return `park refused: the turn's ticket names no issue number`;
    }
    const composed = gateBlockedParkWrite({
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
