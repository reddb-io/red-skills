import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { hostname, homedir } from "node:os";
import { dirname, join } from "node:path";
import { redskilledHomeDir } from "@reddb-io/shared/redskilled-home.js";
import { decodeWireFrame, encodeWireFrame } from "@reddb-io/shared/resident-wire.js";

import { randomLinkSecret } from "@reddb-io/red-skills-link-protocol/crypto";
import type { RedskilledLinkInvitation } from "@reddb-io/red-skills-link-protocol/protocol";

export interface LinkDeviceRecord {
  readonly device_id: string;
  readonly device_name: string;
  readonly secret: string;
  readonly paired_at: string;
  readonly revoked: boolean;
  readonly nonces: readonly string[];
}

export interface RedskilledLinkPublicStatus {
  readonly version: 1;
  readonly active_paired_device_count: number;
}

interface LinkInvitationRecord extends RedskilledLinkInvitation {
  readonly used_at?: string;
}

interface LinkState {
  readonly version: 1;
  readonly host_id: string;
  readonly host_name: string;
  readonly relay_url: string;
  readonly invitations: readonly LinkInvitationRecord[];
  readonly devices: readonly LinkDeviceRecord[];
}

/** One paired device as an operator may SEE it — the secret never leaves the store. */
export interface LinkDeviceView {
  readonly device_id: string;
  readonly device_name: string;
  readonly paired_at: string;
  readonly revoked: boolean;
}

export interface RedskilledLinkStateStore {
  identity(): Promise<Pick<LinkState, "host_id" | "host_name" | "relay_url">>;
  configure(options: { readonly relayUrl?: string; readonly hostName?: string }): Promise<void>;
  createInvitation(ttlMs?: number): Promise<RedskilledLinkInvitation>;
  invitation(inviteId: string): Promise<LinkInvitationRecord | undefined>;
  pair(inviteId: string, device: Omit<LinkDeviceRecord, "paired_at" | "revoked" | "nonces">): Promise<void>;
  device(deviceId: string): Promise<LinkDeviceRecord | undefined>;
  acceptNonce(deviceId: string, nonce: string): Promise<LinkDeviceRecord>;
  /** Every device this Host ever paired, revoked included — secrets omitted. */
  devices(): Promise<readonly LinkDeviceView[]>;
  /** Cut one device off the wire. `false` when no live device carries the id. */
  revoke(deviceId: string): Promise<boolean>;
}

export function defaultLinkStatePath(homeDir = homedir()): string {
  return join(redskilledHomeDir(homeDir), "link", "state.toon");
}

export function defaultLinkStatusPath(homeDir = homedir()): string {
  return join(redskilledHomeDir(homeDir), "link", "status.json");
}

/**
 * Read the public status projection the state store publishes beside itself.
 *
 * `null` is "nothing has been published here", stated rather than guessed —
 * the file appears on the first state mutation, so a fresh install reads null
 * until the Host companion has actually done something.
 */
export async function readPublicLinkStatus(
  path = defaultLinkStatusPath(),
): Promise<RedskilledLinkPublicStatus | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const value = JSON.parse(text) as unknown;
    if (value == null || typeof value !== "object" || Array.isArray(value)) return null;
    const status = value as Record<string, unknown>;
    if (status.version !== 1 || typeof status.active_paired_device_count !== "number") return null;
    return { version: 1, active_paired_device_count: status.active_paired_device_count };
  } catch {
    return null;
  }
}

export function createRedskilledLinkStateStore(options: {
  readonly path?: string;
  readonly statusPath?: string;
  readonly relayUrl?: string;
  readonly hostName?: string;
  readonly now?: () => Date;
}): RedskilledLinkStateStore {
  const path = options.path ?? defaultLinkStatePath();
  const statusPath = options.statusPath ?? join(dirname(path), "status.json");
  const now = options.now ?? (() => new Date());
  const initial = (): LinkState => {
    const relayUrl = options.relayUrl?.trim();
    if (!relayUrl) {
      throw new Error("redskilled link is not configured; run it once with --relay wss://relay.example");
    }
    return {
      version: 1,
      host_id: randomUUID(),
      host_name: options.hostName?.trim() || hostname(),
      relay_url: relayUrl,
      invitations: [],
      devices: [],
    };
  };
  const read = async (): Promise<LinkState> => {
    try {
      const parsed = decodeWireFrame(await readFile(path, "utf8"));
      return isLinkState(parsed) ? parsed : initial();
    } catch {
      return initial();
    }
  };
  const mutate = async <T>(
    operation: (state: LinkState) => readonly [LinkState, T],
    publishStatus = false,
  ): Promise<T> => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const lock = `${path}.lock`;
    let held;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        held = await open(lock, "wx", 0o600);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    if (held == null) throw new Error("redskilled-link state is busy");
    try {
      const current = await read();
      const [next, answer] = operation(current);
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      await writeFile(temporary, encodeWireFrame(next, "toon"), { mode: 0o600 });
      await rename(temporary, path);
      // This projection is advisory. A failed public-status write must never
      // turn an already-committed pairing into a client-visible error.
      if (publishStatus) await writePublicStatus(statusPath, next).catch(() => undefined);
      return answer;
    } finally {
      await held.close();
      await rm(lock, { force: true });
    }
  };
  return {
    async identity() {
      const state = await mutate((current) => [current, current], true);
      return { host_id: state.host_id, host_name: state.host_name, relay_url: state.relay_url };
    },
    async configure(config) {
      const relayUrl = config.relayUrl?.trim();
      const hostName = config.hostName?.trim();
      await mutate((state) => [{
        ...state,
        ...(relayUrl ? { relay_url: relayUrl } : {}),
        ...(hostName ? { host_name: hostName } : {}),
      }, undefined]);
    },
    async createInvitation(ttlMs = 10 * 60_000) {
      return await mutate((state) => {
        const invitation: LinkInvitationRecord = {
          version: 1,
          relay_url: state.relay_url,
          host_id: state.host_id,
          host_name: state.host_name,
          invite_id: randomUUID(),
          secret: randomLinkSecret(),
          expires_at: new Date(now().getTime() + ttlMs).toISOString(),
        };
        return [{ ...state, invitations: [...state.invitations, invitation] }, invitation];
      }, true);
    },
    async invitation(inviteId) {
      const state = await read();
      return state.invitations.find((invite) => invite.invite_id === inviteId);
    },
    async pair(inviteId, device) {
      await mutate((state) => {
        const invitation = state.invitations.find((invite) => invite.invite_id === inviteId);
        if (invitation == null || invitation.used_at != null || Date.parse(invitation.expires_at) <= now().getTime()) {
          throw new Error("pairing invitation is absent, expired, or already used");
        }
        const paired: LinkDeviceRecord = {
          ...device,
          paired_at: now().toISOString(),
          revoked: false,
          nonces: [],
        };
        return [{
          ...state,
          invitations: state.invitations.map((invite) => invite.invite_id === inviteId
            ? { ...invite, used_at: now().toISOString() }
            : invite),
          devices: [...state.devices.filter((entry) => entry.device_id !== device.device_id), paired],
        }, undefined];
      }, true);
    },
    async device(deviceId) {
      return (await read()).devices.find((device) => device.device_id === deviceId && !device.revoked);
    },
    async devices() {
      return (await read()).devices.map(({ device_id, device_name, paired_at, revoked }) => ({
        device_id,
        device_name,
        paired_at,
        revoked,
      }));
    },
    async revoke(deviceId) {
      // Revocation republishes the status projection: the paired-device count
      // is exactly the number this operation changes.
      return await mutate((state) => {
        const live = state.devices.find((entry) => entry.device_id === deviceId && !entry.revoked);
        if (live == null) return [state, false];
        return [{
          ...state,
          devices: state.devices.map((entry) => entry.device_id === deviceId
            ? { ...entry, revoked: true }
            : entry),
        }, true];
      }, true);
    },
    async acceptNonce(deviceId, nonce) {
      return await mutate((state) => {
        const device = state.devices.find((entry) => entry.device_id === deviceId && !entry.revoked);
        if (device == null) throw new Error("device is not paired or was revoked");
        if (device.nonces.includes(nonce)) throw new Error("replayed redskilled-link request");
        const next = { ...device, nonces: [...device.nonces.slice(-63), nonce] };
        return [{
          ...state,
          devices: state.devices.map((entry) => entry.device_id === deviceId ? next : entry),
        }, next];
      });
    },
  };
}

async function writePublicStatus(path: string, state: LinkState): Promise<void> {
  const status: RedskilledLinkPublicStatus = {
    version: 1,
    active_paired_device_count: state.devices.filter((device) => !device.revoked).length,
  };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(status)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function isLinkState(value: unknown): value is LinkState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && typeof state.host_id === "string" && typeof state.host_name === "string" &&
    typeof state.relay_url === "string" && Array.isArray(state.invitations) &&
    state.invitations.every(isLinkInvitationRecord) && Array.isArray(state.devices) &&
    state.devices.every(isLinkDeviceRecord);
}

function isLinkInvitationRecord(value: unknown): value is LinkInvitationRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const invitation = value as Record<string, unknown>;
  return invitation.version === 1 && typeof invitation.relay_url === "string" &&
    typeof invitation.host_id === "string" && typeof invitation.host_name === "string" &&
    typeof invitation.invite_id === "string" && typeof invitation.secret === "string" &&
    typeof invitation.expires_at === "string" &&
    (invitation.used_at === undefined || typeof invitation.used_at === "string");
}

function isLinkDeviceRecord(value: unknown): value is LinkDeviceRecord {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const device = value as Record<string, unknown>;
  return typeof device.device_id === "string" && typeof device.device_name === "string" &&
    typeof device.secret === "string" && typeof device.paired_at === "string" &&
    typeof device.revoked === "boolean" && Array.isArray(device.nonces) &&
    device.nonces.every((nonce) => typeof nonce === "string");
}
