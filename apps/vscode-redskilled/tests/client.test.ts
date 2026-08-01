import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRedskilledReadClient, RedskilledRefusedError, RedskilledUnreachableError } from "../src/redskilled/client.js";
import { readHostSnapshot } from "../src/model/snapshot.js";
import { startFakeDaemon, type FakeDaemon } from "./fake-daemon.js";
import { statuslinePayload, worker } from "./fixtures.js";

let daemon: FakeDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

describe("the read client", () => {
  it("reads the host over the TOON wire, never by parsing JSON off the frame", async () => {
    daemon = await startFakeDaemon();
    const client = createRedskilledReadClient({ socketPath: daemon.socketPath });

    const pong = await client.ping();
    expect(pong.pong).toBe(true);
    expect(pong.protocol_version).toBe(1);

    const payload = await client.statuslinePayload();
    expect(payload.workers.map((entry) => entry.worker_id)).toEqual(["wA1B2"]);
    expect(payload.host.worker_count).toBe(1);
  });

  it("reports an absent daemon as unreachable rather than as an idle host", async () => {
    const client = createRedskilledReadClient({
      socketPath: join("/tmp", "rsk-nothing-here", "d.sock"),
      timeoutMs: 500,
    });

    await expect(client.statuslinePayload()).rejects.toBeInstanceOf(RedskilledUnreachableError);
  });

  it("carries the daemon's own sentence when the daemon answers and refuses", async () => {
    daemon = await startFakeDaemon({ refuse: ["host-state"] });
    const client = createRedskilledReadClient({ socketPath: daemon.socketPath });

    await expect(client.hostState()).rejects.toThrow(/does not serve host-state/);
    await expect(client.hostState()).rejects.toBeInstanceOf(RedskilledRefusedError);
  });

  it("refuses a payload whose shape this view cannot read, instead of rendering it", async () => {
    daemon = await startFakeDaemon({ payload: () => ({ version: 1, workers: "not a list" }) });
    const client = createRedskilledReadClient({ socketPath: daemon.socketPath });

    await expect(client.statuslinePayload()).rejects.toThrow(/shape this view cannot read/);
  });

  it("never sends a writing op — the whole surface is three reads", async () => {
    daemon = await startFakeDaemon();
    const client = createRedskilledReadClient({ socketPath: daemon.socketPath });

    await client.ping();
    await client.hostState();
    await client.statuslinePayload();

    expect([...daemon.served.keys()].sort()).toEqual(["host-state", "ping", "statusline-payload"]);
  });
});

describe("one snapshot of everything", () => {
  it("is a total answer: an unreachable host is a frame, not a throw", async () => {
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: "/tmp/rsk-absent/d.sock", timeoutMs: 300 }),
      eventLanePath: "/tmp/rsk-absent/redskilled.events.toonl",
      source: "a test",
      now: () => "2026-08-01T10:00:00.000Z",
    });

    expect(snapshot.reachable).toBe(false);
    expect(snapshot.payload).toBeNull();
    expect(snapshot.error?.message).toMatch(/not reachable/);
    expect(snapshot.lane.exists).toBe(false);
  });

  it("still yields a usable frame when the daemon serves the payload and refuses host-state", async () => {
    daemon = await startFakeDaemon({ refuse: ["host-state"] });
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "a test",
    });

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.hostState).toBeNull();
    expect(snapshot.payload?.workers).toHaveLength(1);
  });

  it("reads the event lane beside the socket, so the frame says both now and how", async () => {
    daemon = await startFakeDaemon({
      payload: () => statuslinePayload({ workers: [worker({ worker_id: "wZZZZ" })] }),
    });
    await daemon.record({
      event: "worker-birth",
      ts: "2026-08-01T09:00:00.000Z",
      worker: {
        worker_id: "wZZZZ",
        project_label: "reddb-io/red-skills",
        pid: 4242,
        started_at: "2026-08-01T09:00:00.000Z",
        workspace_path: "/workspaces/red-skills",
        isolated: true,
        unit: "redskilled-wZZZZ.service",
        warnings: [],
      },
    });

    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "a test",
    });

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.lane.events.map((event) => event.event)).toEqual(["worker-birth"]);
    expect(snapshot.lane.events[0]!.worker_id).toBe("wZZZZ");
  });

  it("survives a lane it cannot read at all — the socket answer still lands", async () => {
    daemon = await startFakeDaemon();
    // A directory where a file is expected: the read fails, the frame does not.
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.runtimeDir,
      source: "a test",
    });

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.lane.events).toEqual([]);
    await rm(join(daemon.runtimeDir, "nothing"), { force: true });
  });
});
