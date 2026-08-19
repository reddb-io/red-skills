/**
 * acp-permission — how one Worker's permission request is decided, and by whom.
 *
 * Three answers and no fourth: a durable `allow_always` the operator already
 * gave, an attached client's decision inside a bounded deadline, or HITL. A
 * disconnect and a timeout are the SAME thing here — an uncovered decision,
 * never approval — which is the property that lets a Worker ask for reach
 * while nobody is at the keyboard without the daemon inventing consent.
 */
import {
  withTimeout,
} from "@reddb-io/protocol-acp";
import type { RequestPermissionRequest, RequestPermissionResponse } from "@agentclientprotocol/sdk";

import type { AcpSessionJournal as DurableAcpSessionJournal } from "./acp-session-journal.js";

type PermissionDecision = Extract<
  ReturnType<DurableAcpSessionJournal["recovery"]>["entries"][number],
  { kind: "permission" }
>;

export async function resolvePermission(
  journal: DurableAcpSessionJournal,
  publicSessionId: string,
  request: RequestPermissionRequest,
  attached: () => boolean,
  project: (request: RequestPermissionRequest) => Promise<RequestPermissionResponse>,
): Promise<RequestPermissionResponse> {
  const policyKey = permissionPolicyKey(request);
  const granted = [...journal.recovery(publicSessionId).entries]
    .reverse()
    .find((entry): entry is PermissionDecision => entry.kind === "permission" &&
      entry.policy_key === policyKey && entry.decision === "attached-approved" &&
      entry.option_kind === "allow_always");
  const preAuthorized = granted == null
    ? undefined
    : request.options.find((option) => option.optionId === granted.option_id && option.kind === "allow_always");
  if (preAuthorized != null) {
    await journal.permission(publicSessionId, request, policyKey, "policy-pre-authorized", preAuthorized.optionId);
    return permissionAnswer(preAuthorized.optionId, "policy-pre-authorized");
  }

  if (attached()) {
    try {
      const response = await withTimeout(
        project(request),
        permissionDecisionTimeoutMs(),
        "attached ACP permission decision",
      );
      const outcome = response.outcome;
      const selected = outcome.outcome === "selected"
        ? request.options.find((option) => option.optionId === outcome.optionId)
        : undefined;
      if (selected != null) {
        const approved = selected.kind === "allow_once" || selected.kind === "allow_always";
        const decision = approved ? "attached-approved" : "attached-denied";
        await journal.permission(publicSessionId, request, policyKey, decision, selected.optionId);
        return permissionAnswer(selected.optionId, decision, response._meta);
      }
    } catch {
      // A disconnect or bounded timeout is an uncovered decision, never approval.
    }
  }

  await journal.permission(publicSessionId, request, policyKey, "hitl-required");
  return {
    outcome: { outcome: "cancelled" },
    _meta: { redskills: { permissionResolution: "hitl-required", durableHitl: true } },
  };
}

export function permissionAnswer(
  optionId: string,
  permissionResolution: "attached-approved" | "attached-denied" | "policy-pre-authorized",
  meta?: RequestPermissionResponse["_meta"],
): RequestPermissionResponse {
  return {
    outcome: { outcome: "selected", optionId },
    _meta: {
      ...(meta ?? {}),
      redskills: {
        ...((meta as { redskills?: object } | undefined)?.redskills ?? {}),
        permissionResolution,
      },
    },
  };
}

export function permissionPolicyKey(request: RequestPermissionRequest): string {
  return `${request.toolCall.kind ?? "other"}:${request.toolCall.title ?? "untitled"}`;
}

function permissionDecisionTimeoutMs(): number {
  const configured = Number.parseInt(process.env.REDSKILLED_ACP_PERMISSION_TIMEOUT_MS ?? "30000", 10);
  return Number.isFinite(configured) && configured >= 0 ? configured : 30_000;
}
