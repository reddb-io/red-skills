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

export interface RedskilledLinkStateStore {
  identity(): Promise<Pick<LinkState, "host_id" | "host_name" | "relay_url">>;
  createInvitation(ttlMs?: number): Promise<RedskilledLinkInvitation>;
  invitation(inviteId: string): Promise<LinkInvitationRecord | undefined>;
  pair(inviteId: string, device: Omit<LinkDeviceRecord, "paired_at" | "revoked" | "nonces">): Promise<void>;
  device(deviceId: string): Promise<LinkDeviceRecord | undefined>;
  acceptNonce(deviceId: string, nonce: string): Promise<LinkDeviceRecord>;
}

export function defaultLinkStatePath(homeDir = homedir()): string {
  return join(redskilledHomeDir(homeDir), "link", "state.toon");
}

export function createRedskilledLinkStateStore(options: {
  readonly path?: string;
  readonly relayUrl: string;
  readonly hostName?: string;
  readonly now?: () => Date;
}): RedskilledLinkStateStore {
  const path = options.path ?? defaultLinkStatePath();
  const now = options.now ?? (() => new Date());
  const initial = (): LinkState => ({
    version: 1,
    host_id: randomUUID(),
    host_name: options.hostName?.trim() || hostname(),
    relay_url: options.relayUrl,
    invitations: [],
    devices: [],
  });
  const read = async (): Promise<LinkState> => {
    try {
      const parsed = decodeWireFrame(await readFile(path, "utf8"));
      return isLinkState(parsed) ? parsed : initial();
    } catch {
      return initial();
    }
  };
  const mutate = async <T>(operation: (state: LinkState) => readonly [LinkState, T]): Promise<T> => {
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
      return answer;
    } finally {
      await held.close();
      await rm(lock, { force: true });
    }
  };
  return {
    async identity() {
      const state = await mutate((current) => [current, current]);
      return { host_id: state.host_id, host_name: state.host_name, relay_url: state.relay_url };
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
      });
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
      });
    },
    async device(deviceId) {
      return (await read()).devices.find((device) => device.device_id === deviceId && !device.revoked);
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

function isLinkState(value: unknown): value is LinkState {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  return state.version === 1 && typeof state.host_id === "string" && typeof state.host_name === "string" &&
    typeof state.relay_url === "string" && Array.isArray(state.invitations) && Array.isArray(state.devices);
}
