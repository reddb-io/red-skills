import nacl from "tweetnacl";
import { fromByteArray, toByteArray } from "base64-js";
import { decodeWireFrame, encodeWireFrame } from "@reddb-io/shared/resident-wire.js";

import type {
  RedskilledLinkInvitation,
  RedskilledLinkPairedHost,
} from "./protocol";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
export const REDSKILLED_PAIRING_URI_PREFIX = "redskilled://pair/";

export interface EncryptedLinkPayload {
  readonly nonce: string;
  readonly payload: string;
}

export function randomLinkSecret(): string {
  return base64Url(nacl.randomBytes(nacl.secretbox.keyLength));
}

export function deriveDeviceSecret(inviteSecret: string, deviceId: string): string {
  const seed = concat(fromBase64Url(inviteSecret), encoder.encode(deviceId));
  return base64Url(nacl.hash(seed).slice(0, nacl.secretbox.keyLength));
}

export function encryptLinkPayload(value: unknown, secret: string): EncryptedLinkPayload {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const plain = encoder.encode(encodeWireFrame(value, "toon"));
  const cipher = nacl.secretbox(plain, nonce, requireKey(secret));
  return { nonce: base64Url(nonce), payload: base64Url(cipher) };
}

export function decryptLinkPayload<T>(payload: EncryptedLinkPayload, secret: string): T {
  const plain = nacl.secretbox.open(
    fromBase64Url(payload.payload),
    fromBase64Url(payload.nonce),
    requireKey(secret),
  );
  if (plain == null) throw new Error("redskilled-link authentication failed");
  return decodeWireFrame(decoder.decode(plain)) as T;
}

export function encodeInvitation(invitation: RedskilledLinkInvitation): string {
  return base64Url(encoder.encode(encodeWireFrame(invitation, "toon")));
}

export function encodeInvitationUri(invitation: RedskilledLinkInvitation): string {
  return `${REDSKILLED_PAIRING_URI_PREFIX}${encodeInvitation(invitation)}`;
}

export function decodeInvitation(value: string): RedskilledLinkInvitation {
  const trimmed = value.trim();
  const code = trimmed.startsWith(REDSKILLED_PAIRING_URI_PREFIX)
    ? trimmed.slice(REDSKILLED_PAIRING_URI_PREFIX.length)
    : trimmed;
  if (code === "" || code.includes("/") || code.includes("?") || code.includes("#")) {
    throw new Error("invalid redskilled-link invitation URI");
  }
  const decoded = decodeWireFrame(decoder.decode(fromBase64Url(code)));
  if (!isInvitation(decoded)) throw new Error("invalid redskilled-link invitation");
  return decoded;
}

export function encodePairedHost(host: RedskilledLinkPairedHost): string {
  return base64Url(encoder.encode(encodeWireFrame(host, "toon")));
}

export function decodePairedHost(value: string): RedskilledLinkPairedHost {
  const decoded = decodeWireFrame(decoder.decode(fromBase64Url(value.trim())));
  if (!isPairedHost(decoded)) throw new Error("invalid paired Redskilled Host");
  return decoded;
}

export function encodeRelayEnvelope(value: unknown): string {
  return encodeWireFrame(value, "toon");
}

export function decodeRelayEnvelope(value: string): unknown {
  return decodeWireFrame(value);
}

function requireKey(secret: string): Uint8Array {
  const key = fromBase64Url(secret);
  if (key.length !== nacl.secretbox.keyLength) throw new Error("invalid redskilled-link secret");
  return key;
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function base64Url(value: Uint8Array): string {
  return fromByteArray(value).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  return toByteArray(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
}

function isInvitation(value: unknown): value is RedskilledLinkInvitation {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const invite = value as Record<string, unknown>;
  return invite.version === 1 && [
    "relay_url", "host_id", "host_name", "invite_id", "secret", "expires_at",
  ].every((field) => typeof invite[field] === "string" && invite[field] !== "");
}

function isPairedHost(value: unknown): value is RedskilledLinkPairedHost {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const host = value as Record<string, unknown>;
  return host.version === 1 && [
    "relay_url", "host_id", "host_name", "device_id", "device_secret",
  ].every((field) => typeof host[field] === "string" && host[field] !== "");
}
