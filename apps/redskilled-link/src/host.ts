import WebSocket from "ws";
import type { RedskillsOperatorAcpClient } from "@reddb-io/redskilled/acp-operator-client";

import {
  decryptLinkPayload,
  decodeRelayEnvelope,
  deriveDeviceSecret,
  encodeRelayEnvelope,
  encryptLinkPayload,
} from "@reddb-io/red-skills-link-protocol/crypto";
import {
  isRelayEnvelope,
  type RedskilledLinkPairAnswer,
  type RedskilledLinkPairRequest,
  type RedskilledLinkRequest,
  type RedskilledLinkResponse,
  type RedskilledLinkOperationAnswer,
  type RedskilledRelayEnvelope,
} from "@reddb-io/red-skills-link-protocol/protocol";
import type { RedskilledLinkStateStore } from "./state.js";

export interface RedskilledLinkHostDeps {
  readonly state: RedskilledLinkStateStore;
  readonly operator: RedskillsOperatorAcpClient;
}

export async function handleHostEnvelope(
  envelope: RedskilledRelayEnvelope,
  deps: RedskilledLinkHostDeps,
): Promise<RedskilledRelayEnvelope | null> {
  if (envelope.kind === "pair-request") return await handlePair(envelope, deps);
  if (envelope.kind !== "device-request") return null;
  const device = await deps.state.acceptNonce(envelope.device_id, envelope.nonce);
  let request: RedskilledLinkRequest;
  try {
    request = decryptLinkPayload(envelope, device.secret);
  } catch (error) {
    throw new Error(`device authentication failed: ${messageOf(error)}`);
  }
  const response: RedskilledLinkResponse = await executeOperation(request, deps.operator)
    .then((value) => ({ version: 1 as const, request_id: request.request_id, ok: true, value }))
    .catch((error) => ({ version: 1, request_id: request.request_id, ok: false, error: messageOf(error) }));
  const encrypted = encryptLinkPayload(response, device.secret);
  return {
    version: 1,
    kind: "host-response",
    host_id: envelope.host_id,
    device_id: envelope.device_id,
    ...encrypted,
  };
}

export async function runRedskilledLinkHost(
  deps: RedskilledLinkHostDeps,
  signal?: AbortSignal,
): Promise<void> {
  const identity = await deps.state.identity();
  let delayMs = 250;
  while (!signal?.aborted) {
    try {
      await runHostConnection(identity.relay_url, identity.host_id, deps, signal);
      delayMs = 250;
    } catch {
      if (signal?.aborted) break;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(10_000, delayMs * 2);
    }
  }
}

async function runHostConnection(
  relayUrl: string,
  hostId: string,
  deps: RedskilledLinkHostDeps,
  signal?: AbortSignal,
): Promise<void> {
  const socket = new WebSocket(relayUrl);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  socket.send(encodeRelayEnvelope({ version: 1, kind: "host-online", host_id: hostId }));
  await new Promise<void>((resolve) => {
    signal?.addEventListener("abort", () => {
      socket.close();
      resolve();
    }, { once: true });
    socket.on("message", (data) => {
      void Promise.resolve().then(async () => {
        const decoded = decodeRelayEnvelope(data.toString());
        if (!isRelayEnvelope(decoded)) return;
        const answer = await handleHostEnvelope(decoded, deps);
        if (answer != null && socket.readyState === WebSocket.OPEN) socket.send(encodeRelayEnvelope(answer));
      }).catch(() => undefined);
    });
    socket.once("close", () => resolve());
    socket.once("error", () => resolve());
  });
}

async function handlePair(
  envelope: Extract<RedskilledRelayEnvelope, { readonly kind: "pair-request" }>,
  deps: RedskilledLinkHostDeps,
): Promise<RedskilledRelayEnvelope> {
  const invitation = envelope.invite_id == null ? undefined : await deps.state.invitation(envelope.invite_id);
  if (invitation == null) {
    throw new Error("pairing invitation is absent or expired");
  }
  const request = decryptLinkPayload<RedskilledLinkPairRequest>(envelope, invitation.secret);
  if (
    request.version !== 1 || request.operation !== "pair" || request.invite_id !== invitation.invite_id ||
    request.device_id !== envelope.device_id || request.device_name.trim() === ""
  ) throw new Error("invalid pairing request");
  const deviceSecret = deriveDeviceSecret(invitation.secret, request.device_id);
  const identity = await deps.state.identity();
  let pairError: string | undefined;
  try {
    await deps.state.pair(invitation.invite_id, {
      device_id: request.device_id,
      device_name: request.device_name.trim(),
      secret: deviceSecret,
    });
  } catch (error) {
    pairError = messageOf(error);
  }
  const response: RedskilledLinkPairAnswer = {
    version: 1,
    request_id: request.request_id,
    ok: pairError == null,
    ...(pairError == null
      ? { host_id: identity.host_id, host_name: identity.host_name }
      : { error: pairError }),
  };
  return {
    version: 1,
    kind: "pair-response",
    host_id: identity.host_id,
    device_id: request.device_id,
    ...encryptLinkPayload(response, invitation.secret),
  };
}

async function executeOperation(
  request: RedskilledLinkRequest,
  operator: RedskillsOperatorAcpClient,
): Promise<RedskilledLinkOperationAnswer> {
  if (request.version !== 1 || typeof request.request_id !== "string" || request.request_id === "") {
    throw new Error("invalid redskilled-link request");
  }
  if (request.operation === "state" && Object.keys(request.params).length === 0) return await operator.state();
  if (request.operation === "ticket_dispatch" && Object.keys(request.params).length === 1) {
    return await operator.dispatch(request.params.issue_url);
  }
  if (request.operation === "worker_stop" && Object.keys(request.params).length === 1) {
    return await operator.stop(request.params.worker_id);
  }
  throw new Error("operation is outside the Mobile operator allowlist");
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
