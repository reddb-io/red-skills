import {
  decodeInvitation,
  decodeRelayEnvelope,
  decryptLinkPayload,
  deriveDeviceSecret,
  encryptLinkPayload,
  encodeRelayEnvelope,
  randomLinkSecret,
} from "./crypto";
import {
  isRelayEnvelope,
  type RedskilledLinkOperation,
  type RedskilledLinkOperationAnswer,
  type RedskilledLinkPairAnswer,
  type RedskilledLinkPairRequest,
  type RedskilledLinkPairedHost,
  type RedskilledLinkRequest,
  type RedskilledLinkResponse,
  type RedskilledRelayEnvelope,
} from "./protocol";

interface MessageEventLike { readonly data: unknown }
interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (event: MessageEventLike) => void): void;
  addEventListener(type: "error" | "close", listener: () => void): void;
}
export type LinkWebSocketConstructor = new (url: string) => WebSocketLike;

export interface RedskilledMobileLinkClient {
  state(): Promise<RedskilledLinkOperationAnswer>;
  dispatch(issueUrl: string): Promise<RedskilledLinkOperationAnswer>;
  stop(workerId: string): Promise<RedskilledLinkOperationAnswer>;
}

export async function pairRedskilledHost(
  invitationCode: string,
  deviceName: string,
  WebSocketImpl: LinkWebSocketConstructor = globalThis.WebSocket as unknown as LinkWebSocketConstructor,
): Promise<RedskilledLinkPairedHost> {
  const invitation = decodeInvitation(invitationCode);
  if (Date.parse(invitation.expires_at) <= Date.now()) throw new Error("pairing invitation expired");
  const deviceId = `device-${randomLinkSecret().slice(0, 22)}`;
  const requestId = randomLinkSecret().slice(0, 22);
  const request: RedskilledLinkPairRequest = {
    version: 1,
    request_id: requestId,
    operation: "pair",
    invite_id: invitation.invite_id,
    device_id: deviceId,
    device_name: deviceName.trim() || "Redskilled Mobile",
  };
  const answerEnvelope = await exchange(
    invitation.relay_url,
    {
      version: 1,
      kind: "pair-request",
      host_id: invitation.host_id,
      device_id: deviceId,
      invite_id: invitation.invite_id,
      ...encryptLinkPayload(request, invitation.secret),
    },
    "pair-response",
    WebSocketImpl,
  );
  const answer = decryptLinkPayload<RedskilledLinkPairAnswer>(answerEnvelope, invitation.secret);
  if (!answer.ok || answer.request_id !== requestId || answer.host_id !== invitation.host_id) {
    throw new Error(answer.error ?? "Host refused pairing");
  }
  return {
    version: 1,
    relay_url: invitation.relay_url,
    host_id: invitation.host_id,
    host_name: answer.host_name ?? invitation.host_name,
    device_id: deviceId,
    device_secret: deriveDeviceSecret(invitation.secret, deviceId),
  };
}

export function createRedskilledMobileLinkClient(
  paired: RedskilledLinkPairedHost,
  WebSocketImpl: LinkWebSocketConstructor = globalThis.WebSocket as unknown as LinkWebSocketConstructor,
): RedskilledMobileLinkClient {
  const invoke = async (operation: RedskilledLinkOperation): Promise<RedskilledLinkOperationAnswer> => {
    const requestId = randomLinkSecret().slice(0, 22);
    const request: RedskilledLinkRequest = { version: 1, request_id: requestId, ...operation };
    const answerEnvelope = await exchange(
      paired.relay_url,
      {
        version: 1,
        kind: "device-request",
        host_id: paired.host_id,
        device_id: paired.device_id,
        ...encryptLinkPayload(request, paired.device_secret),
      },
      "host-response",
      WebSocketImpl,
    );
    const answer = decryptLinkPayload<RedskilledLinkResponse>(answerEnvelope, paired.device_secret);
    if (answer.request_id !== requestId) throw new Error("Host returned a response for another request");
    if (!answer.ok || answer.value == null) throw new Error(answer.error ?? "Host refused the operation");
    return answer.value;
  };
  return {
    state: () => invoke({ operation: "state", params: {} }),
    dispatch: (issueUrl) => invoke({ operation: "ticket_dispatch", params: { issue_url: issueUrl } }),
    stop: (workerId) => invoke({ operation: "worker_stop", params: { worker_id: workerId } }),
  };
}

async function exchange(
  relayUrl: string,
  request: Exclude<RedskilledRelayEnvelope, { readonly kind: "host-online" }>,
  answerKind: "pair-response" | "host-response",
  WebSocketImpl: LinkWebSocketConstructor,
): Promise<Extract<RedskilledRelayEnvelope, { readonly kind: typeof answerKind }>> {
  return await new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(relayUrl);
    const timeout = setTimeout(() => finish(new Error("redskilled-link relay timed out")), 15_000);
    let settled = false;
    const finish = (error?: Error, answer?: RedskilledRelayEnvelope) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket.close();
      if (error != null) reject(error);
      else resolve(answer as Extract<RedskilledRelayEnvelope, { readonly kind: typeof answerKind }>);
    };
    socket.addEventListener("open", () => socket.send(encodeRelayEnvelope(request)));
    socket.addEventListener("message", (event) => {
      try {
        const decoded = decodeRelayEnvelope(messageText(event.data));
        if (!isRelayEnvelope(decoded) || decoded.kind !== answerKind || decoded.device_id !== request.device_id) return;
        finish(undefined, decoded);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener("error", () => finish(new Error("redskilled-link relay connection failed")));
    socket.addEventListener("close", () => finish(new Error("redskilled-link relay closed before answering")));
  });
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(value));
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value as Uint8Array);
  return String(value);
}
