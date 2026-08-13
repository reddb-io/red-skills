import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS,
  DEFAULT_RESIDENT_IDLE_MS,
  IncompatibleResidentProtocolError,
  ResidentActivity,
  ensureVersionedResident,
  readResidentRegistryDocument,
  readVersionedResidentRegistry,
  removeVersionedResidentRegistry,
  writeVersionedResidentRegistry,
  writeResidentRegistryDocument,
} from "./resident-lifecycle.js";

describe("versioned resident lifecycle", () => {
  it("round-trips a daemon-neutral registry entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "resident-registry-"));
    const path = join(root, "resident.toon");
    await writeVersionedResidentRegistry(path, {
      kind: "castle",
      pid: 42,
      socketPath: join(root, "resident.sock"),
      residentVersion: "3.18.6",
      protocolVersion: "1.0.0",
      startedAt: "2026-08-13T00:00:00.000Z",
      metadata: { project: "owner/project" },
    });

    expect(await readVersionedResidentRegistry(path)).toMatchObject({
      schema: "red.shared.resident_registry.v1",
      kind: "castle",
      pid: 42,
      resident_version: "3.18.6",
      protocol_version: "1.0.0",
      metadata: { project: "owner/project" },
    });
    await removeVersionedResidentRegistry(path, 42);
    expect(await readVersionedResidentRegistry(path)).toBeNull();
  });

  it("preserves a daemon's established registry payload through the generic atomic store", async () => {
    const root = mkdtempSync(join(tmpdir(), "resident-registry-compat-"));
    const path = join(root, "rsp-resident.toon");
    const rspEntry = {
      version: 1,
      pid: 42,
      socket_path: join(root, "rsp.sock"),
      store_uri: "file:///store.rdb",
      resident_version: "3.18.6",
      started_at: "2026-08-13T00:00:00.000Z",
    };

    await writeResidentRegistryDocument(path, rspEntry);
    expect(await readResidentRegistryDocument(path)).toEqual(rspEntry);
  });

  it("lets concurrent first clients spawn exactly one resident", async () => {
    const root = mkdtempSync(join(tmpdir(), "resident-spawn-"));
    let ready = false;
    let spawns = 0;
    const options = {
      lockPath: join(root, "resident.lock"),
      clientVersion: "3.18.6",
      protocolVersion: "1.0.0",
      probe: async () => ready ? { residentVersion: "3.18.6", protocolVersion: "1.0.0" } : null,
      spawn: async () => {
        spawns += 1;
        await new Promise((resolve) => setTimeout(resolve, 10));
        ready = true;
      },
      readyTimeoutMs: 1_000,
    };

    await Promise.all([
      ensureVersionedResident(options),
      ensureVersionedResident(options),
      ensureVersionedResident(options),
    ]);
    expect(spawns).toBe(1);
  });

  it("returns a typed protocol error without spawning an in-process fallback", async () => {
    const spawn = vi.fn(async () => undefined);
    await expect(ensureVersionedResident({
      lockPath: join(mkdtempSync(join(tmpdir(), "resident-protocol-")), "resident.lock"),
      clientVersion: "3.18.6",
      protocolVersion: "2.0.0",
      probe: async () => ({ residentVersion: "3.18.5", protocolVersion: "1.0.0" }),
      spawn,
    })).rejects.toBeInstanceOf(IncompatibleResidentProtocolError);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("drains completed calls and reports every call still pending at handover", async () => {
    expect(DEFAULT_RESIDENT_HANDOVER_TIMEOUT_MS).toBe(30_000);
    const activity = new ResidentActivity({ now: () => 0 });
    const finishFast = activity.beginCall("fast");
    activity.beginCall("stalled");
    finishFast();

    const result = await activity.beginHandover({ timeoutMs: 5 });
    expect(result).toEqual({ drained: false, completed: ["fast"], pending: ["stalled"] });
    expect(() => activity.beginCall("late")).toThrow(/draining/i);
  });

  it("exits after five idle minutes only with no clients, Workers, obligations, or calls", () => {
    expect(DEFAULT_RESIDENT_IDLE_MS).toBe(5 * 60_000);
    let now = 0;
    const activity = new ResidentActivity({ now: () => now });
    now = DEFAULT_RESIDENT_IDLE_MS;
    expect(activity.canExitIdle()).toBe(true);

    for (const [arm, disarm] of [
      [() => activity.addClient("client"), () => activity.removeClient("client")],
      [() => activity.addWorker("worker"), () => activity.removeWorker("worker")],
      [() => activity.armObligation("curator"), () => activity.disarmObligation("curator")],
    ] as const) {
      arm();
      now += DEFAULT_RESIDENT_IDLE_MS;
      expect(activity.canExitIdle()).toBe(false);
      disarm();
    }

    const finish = activity.beginCall("call");
    now += DEFAULT_RESIDENT_IDLE_MS;
    expect(activity.canExitIdle()).toBe(false);
    finish();
    expect(activity.canExitIdle()).toBe(false);
    now += DEFAULT_RESIDENT_IDLE_MS;
    expect(activity.canExitIdle()).toBe(true);
  });
});
