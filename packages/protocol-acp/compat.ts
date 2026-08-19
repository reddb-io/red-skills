// compat — ACP v1/v2 negotiation and the RedSkills wire major (ADR 0145 §2-3).
//
// ACP v2 draft revisions share `protocolVersion: 2` while changing
// incompatibly, so the number on the wire is not enough to tell two peers
// apart; every revision RedSkills ships names itself in `_meta.redskills`. The
// RedSkills wire major is a SECOND, independent axis: two peers can agree on
// ACP and still disagree on RedSkills workflow traffic.
//
// This module is the one home of both answers. A private copy in the daemon or
// in an adapter is how the two ends of one socket come to disagree about what
// they just negotiated.
import { RequestError, type SessionNotification } from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";

export const ACP_PROTOCOL_VERSION = 1;
export const ACP_V2_DRAFT_REVISION = "schema-v2.0.0-alpha.2";
export const REDSKILLS_WIRE_MAJOR = 1;

export function requireCompatibleWireMajor(meta: unknown, required = false): void {
  const redskills = record(record(meta)?.redskills);
  const wireMajor = redskills?.wireMajor;
  if (wireMajor == null && !required) return;
  if (wireMajor !== REDSKILLS_WIRE_MAJOR) {
    const received = typeof wireMajor === "number" ? wireMajor : "omitted";
    throw RequestError.invalidParams(
      { redskills: { receivedWireMajor: received, supportedWireMajor: REDSKILLS_WIRE_MAJOR } },
      `unsupported RedSkills wire major ${received}; expected ${REDSKILLS_WIRE_MAJOR}`,
    );
  }
}

export function requireSupportedV2Revision(meta: acpV2.InitializeRequest["_meta"]): void {
  const redskills = record(meta?.redskills);
  const revision = redskills?.acpDraftRevision;
  if (revision !== ACP_V2_DRAFT_REVISION) {
    const received = typeof revision === "string" ? revision : "omitted";
    throw acpV2.RequestError.invalidParams(
      { redskills: { receivedRevision: received, supportedRevision: ACP_V2_DRAFT_REVISION } },
      `unsupported ACP v2 draft revision ${received}; expected ${ACP_V2_DRAFT_REVISION}`,
    );
  }
}

export function translateV1SessionUpdateToV2(
  update: SessionNotification["update"],
  messageId: string,
): acpV2.SessionUpdate | undefined {
  if (update.sessionUpdate === "plan") {
    return {
      sessionUpdate: "plan_update",
      plan: { type: "items", planId: "primary", entries: update.entries },
    };
  }
  if (update.sessionUpdate === "agent_message_chunk") {
    return {
      sessionUpdate: "agent_message_chunk",
      messageId,
      content: update.content as acpV2.ContentBlock,
    };
  }
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
