// The pairing registry is operable: an operator can SEE every device that
// ever paired (revoked kept and marked — vanished and cut-off are different
// histories) and can revoke one, which the wire-side lookups then refuse.
// Secrets never leave the store's view.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { renderDeviceRegistry } from "../src/cli.js";
import { createRedskilledLinkStateStore, readPublicLinkStatus } from "../src/state.js";

describe("the device registry", () => {
  let dir: string;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  async function storeWithDevice() {
    dir = await mkdtemp(join(tmpdir(), "link-devices-"));
    const store = createRedskilledLinkStateStore({
      path: join(dir, "state.toon"),
      relayUrl: "wss://relay.example",
      hostName: "test-host",
    });
    const invitation = await store.createInvitation();
    await store.pair(invitation.invite_id, {
      device_id: "D1",
      device_name: "Pixel",
      secret: "s".repeat(32),
    });
    return store;
  }

  it("lists every paired device without its secret", async () => {
    const store = await storeWithDevice();

    const devices = await store.devices();
    expect(devices).toHaveLength(1);
    expect(devices[0]).toMatchObject({ device_id: "D1", device_name: "Pixel", revoked: false });
    expect(JSON.stringify(devices)).not.toContain("s".repeat(32));
  });

  it("revoking cuts the device off the wire, keeps its history, and republishes the count", async () => {
    const store = await storeWithDevice();

    await expect(store.revoke("D1")).resolves.toBe(true);
    // The wire-side lookup refuses the revoked device...
    await expect(store.device("D1")).resolves.toBeUndefined();
    await expect(store.acceptNonce("D1", "n-1")).rejects.toThrow();
    // ...the registry keeps it, marked...
    const devices = await store.devices();
    expect(devices[0]).toMatchObject({ device_id: "D1", revoked: true });
    // ...and the published projection counts zero live devices.
    await expect(readPublicLinkStatus(join(dir, "status.json"))).resolves.toEqual({
      version: 1,
      active_paired_device_count: 0,
    });
  });

  it("revoking a device that is not live answers false, not success", async () => {
    const store = await storeWithDevice();

    await expect(store.revoke("D-unknown")).resolves.toBe(false);
    await expect(store.revoke("D1")).resolves.toBe(true);
    // A second revocation has nothing live to cut off.
    await expect(store.revoke("D1")).resolves.toBe(false);
  });
});

describe("the registry rendering", () => {
  it("marks revoked beside paired and prints no secret column", () => {
    const rendered = renderDeviceRegistry([
      { device_id: "D1", device_name: "Pixel", paired_at: "2026-08-24T12:00:00.000Z", revoked: false },
      { device_id: "D2", device_name: "Old phone", paired_at: "2026-08-01T09:00:00.000Z", revoked: true },
    ]);

    expect(rendered).toContain("paired   D1  Pixel  since 2026-08-24T12:00:00.000Z");
    expect(rendered).toContain("revoked  D2  Old phone  since 2026-08-01T09:00:00.000Z");
  });

  it("an empty registry points at the invitation flow instead of drawing a blank", () => {
    expect(renderDeviceRegistry([])).toContain("Create an invitation with `invite`");
  });
});
