export const REDSKILLED_LINK_PROTOCOL_VERSION = 1 as const;

export interface RedskilledLinkInvitation {
  readonly version: 1;
  readonly relay_url: string;
  readonly host_id: string;
  readonly host_name: string;
  readonly invite_id: string;
  readonly secret: string;
  readonly expires_at: string;
}

export interface RedskilledLinkPairedHost {
  readonly version: 1;
  readonly relay_url: string;
  readonly host_id: string;
  readonly host_name: string;
  readonly device_id: string;
  readonly device_secret: string;
}

export type RedskilledLinkOperation =
  | { readonly operation: "state"; readonly params: Record<string, never> }
  | { readonly operation: "ticket_dispatch"; readonly params: { readonly issue_url: string } }
  | { readonly operation: "worker_stop"; readonly params: { readonly worker_id: string } };

export type RedskilledLinkOperationAnswer =
  | {
      readonly version: 1;
      readonly daemon_version: string;
      readonly workers: readonly {
        readonly worker_id: string;
        readonly project_label: string;
        readonly started_at: string;
      }[];
    }
  | {
      readonly version: 1;
      readonly repository: string;
      readonly ticket: number;
      readonly worker_id: string;
    }
  | {
      readonly version: 1;
      readonly worker_id: string;
      readonly applied: boolean;
      readonly detail: string;
    };

export type RedskilledLinkRequest = RedskilledLinkOperation & {
  readonly version: 1;
  readonly request_id: string;
};

export interface RedskilledLinkResponse {
  readonly version: 1;
  readonly request_id: string;
  readonly ok: boolean;
  readonly value?: RedskilledLinkOperationAnswer;
  readonly error?: string;
}

export interface RedskilledLinkPairRequest {
  readonly version: 1;
  readonly request_id: string;
  readonly operation: "pair";
  readonly invite_id: string;
  readonly device_id: string;
  readonly device_name: string;
}

export interface RedskilledLinkPairAnswer {
  readonly version: 1;
  readonly request_id: string;
  readonly ok: boolean;
  readonly host_id?: string;
  readonly host_name?: string;
  readonly error?: string;
}

type DeviceRouteEnvelope<Kind extends "device-request" | "pair-request"> = {
  readonly version: 1;
  readonly kind: Kind;
  readonly host_id: string;
  readonly device_id: string;
  readonly nonce: string;
  readonly payload: string;
  readonly invite_id?: string;
};

type HostRouteEnvelope<Kind extends "host-response" | "pair-response"> = {
  readonly version: 1;
  readonly kind: Kind;
  readonly host_id: string;
  readonly device_id: string;
  readonly nonce: string;
  readonly payload: string;
};

export type RedskilledRelayEnvelope =
  | { readonly version: 1; readonly kind: "host-online"; readonly host_id: string }
  | DeviceRouteEnvelope<"device-request">
  | DeviceRouteEnvelope<"pair-request">
  | HostRouteEnvelope<"host-response">
  | HostRouteEnvelope<"pair-response">;

export function isRelayEnvelope(value: unknown): value is RedskilledRelayEnvelope {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.host_id !== "string") return false;
  if (record.kind === "host-online") return Object.keys(record).length === 3;
  return (
    ["device-request", "pair-request", "host-response", "pair-response"].includes(String(record.kind)) &&
    typeof record.device_id === "string" && typeof record.nonce === "string" &&
    typeof record.payload === "string"
  );
}
