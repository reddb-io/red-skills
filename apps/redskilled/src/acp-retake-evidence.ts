import { randomUUID } from "node:crypto";
import { methods, type AgentConnection } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AcpRetakeEvidenceProjection } from "./acp-session-journal.js";

export function isAcpRetakePrompt(prompt: unknown): boolean {
  if (!Array.isArray(prompt)) return false;
  const text = prompt
    .map((block) => record(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n")
    .trim()
    .toLowerCase();
  return text === "/retake";
}

export function renderAcpRetakeEvidence(projection: AcpRetakeEvidenceProjection): string {
  const lines = ["Subordinate provider session evidence (the redskilled journal remains session truth):"];
  if (projection.evidence.length === 0) lines.push("- no provider artifact was reported");
  for (const evidence of projection.evidence) {
    lines.push(evidence.reference == null
      ? `- ${evidence.provider} reported no provider artifact`
      : `- ${evidence.reference} — ${evidence.provider}, ${evidence.availability}, retained as evidence`);
  }
  return `${lines.join("\n")}\n`;
}

export async function notifyV1AcpRetakeEvidence(
  upstream: AgentConnection["client"],
  sessionId: string,
  projection: AcpRetakeEvidenceProjection,
): Promise<void> {
  await upstream.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: renderAcpRetakeEvidence(projection) },
    },
  });
}

export async function notifyV2AcpRetakeEvidence(
  upstream: acpV2.AgentContext,
  sessionId: string,
  projection: AcpRetakeEvidenceProjection,
): Promise<void> {
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      messageId: randomUUID(),
      content: { type: "text", text: renderAcpRetakeEvidence(projection) },
    },
  });
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId,
    update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    _meta: { redskills: { authority: "redskilled" } },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
