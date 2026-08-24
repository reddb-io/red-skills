// The private link state carries host and device secrets; the public status
// file exists so host-side surfaces can show "is anything paired?" without
// ever being handed that state. These tests close the dead end where the
// projection leaks private material or where a broken projection path breaks
// pairing itself.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRedskilledLinkStateStore,
  defaultLinkStatusPath,
  type RedskilledLinkPublicStatus,
} from "../src/state.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("public link status", () => {
  it("uses the public status path beside the default private state", () => {
    expect(defaultLinkStatusPath("/home/tester")).toBe("/home/tester/.red/redskilled/link/status.json");
  });

  it("atomically projects only the active paired-device count with owner-only permissions", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-status-"));
    roots.push(root);
    const statePath = join(root, "private-state.toon");
    const statusPath = join(root, "status.json");
    const state = createRedskilledLinkStateStore({
      path: statePath,
      relayUrl: "wss://relay.example/private",
      hostName: "Sensitive Host Name",
    });

    await state.identity();
    const initial: RedskilledLinkPublicStatus = JSON.parse(await readFile(statusPath, "utf8"));
    expect(initial).toEqual({ version: 1, active_paired_device_count: 0 });
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);

    const invitation = await state.createInvitation();
    await state.pair(invitation.invite_id, {
      device_id: "private-device-id",
      device_name: "Private Phone Name",
      secret: "private-device-secret",
    });

    const rendered = await readFile(statusPath, "utf8");
    expect(JSON.parse(rendered)).toEqual({ version: 1, active_paired_device_count: 1 });
    expect(rendered).not.toContain("private");
    expect(Object.keys(JSON.parse(rendered))).toEqual(["version", "active_paired_device_count"]);

    const statusStat = await stat(statusPath);
    await state.acceptNonce("private-device-id", "nonce-1");
    const statusAfterNonce = await stat(statusPath);
    expect(statusAfterNonce.ino).toBe(statusStat.ino);
    expect(statusAfterNonce.mtimeMs).toBe(statusStat.mtimeMs);
  });

  it("replaces malformed private state with a non-sensitive initial snapshot", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-malformed-status-"));
    roots.push(root);
    const statePath = join(root, "state.toon");
    await writeFile(statePath, JSON.stringify({
      version: 1,
      host_id: "private-host-id",
      host_name: "Private Host",
      relay_url: "wss://private.example",
      invitations: [],
      devices: [{ revoked: false, secret: "malformed private secret material" }],
    }), { mode: 0o600 });
    const state = createRedskilledLinkStateStore({
      path: statePath,
      relayUrl: "wss://replacement.example",
      hostName: "Replacement Host",
    });

    await state.identity();
    const rendered = await readFile(join(root, "status.json"), "utf8");
    expect(JSON.parse(rendered)).toEqual({ version: 1, active_paired_device_count: 0 });
    expect(rendered).not.toContain("secret");
  });

  it("does not let an unavailable status path break pairing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-link-status-failure-"));
    roots.push(root);
    const blocked = join(root, "not-a-directory");
    await writeFile(blocked, "blocked");
    const state = createRedskilledLinkStateStore({
      path: join(root, "state.toon"),
      statusPath: join(blocked, "status.json"),
      relayUrl: "wss://relay.example",
    });

    const invitation = await state.createInvitation();
    await expect(state.pair(invitation.invite_id, {
      device_id: "device-id",
      device_name: "Phone",
      secret: "device-secret",
    })).resolves.toBeUndefined();
    await expect(state.device("device-id")).resolves.toMatchObject({ revoked: false });
  });
});
