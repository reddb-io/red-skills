import { afterEach, describe, expect, it } from "vitest";
import { createWatcher } from "../src/watch/watcher.js";
import { readHostSnapshot, type HostSnapshot } from "../src/model/snapshot.js";
import { createRedskilledReadClient } from "../src/redskilled/client.js";
import { buildWorkersTree } from "../src/model/nodes.js";
import { DEFAULT_NOTIFICATION_PREFERENCES, type Signal } from "../src/watch/signals.js";
import { resolveExtensionPaths } from "../src/redskilled/paths.js";
import { startFakeDaemon, type FakeDaemon } from "./fake-daemon.js";
import { statuslinePayload, worker } from "./fixtures.js";

let daemon: FakeDaemon | null = null;

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
});

describe("the poll loop against a fake daemon", () => {
  it("carries a Worker through a whole life: born, seen, killed over budget", async () => {
    let workers = [worker({ worker_id: "wLIVE", used_fraction: 0.2 })];
    daemon = await startFakeDaemon({ payload: () => statuslinePayload({ workers }) });

    const frames: HostSnapshot[] = [];
    const announced: Signal[] = [];
    const watcher = createWatcher({
      read: async () =>
        await readHostSnapshot({
          client: createRedskilledReadClient({ socketPath: daemon!.socketPath }),
          eventLanePath: daemon!.eventLanePath,
          source: "a test",
        }),
      preferences: () => ({ ...DEFAULT_NOTIFICATION_PREFERENCES, workerBirth: true }),
      renotifyMs: () => 0,
      onSnapshot: (snapshot) => frames.push(snapshot),
      onSignals: (signals) => announced.push(...signals),
    });

    // First read: a baseline, and deliberately silent.
    await watcher.tick();
    expect(announced).toEqual([]);
    expect(buildWorkersTree(frames[0]!)[1]!.label).toBe("wLIVE");

    // A second Worker joins.
    workers = [...workers, worker({ worker_id: "wNEW2", used_fraction: 0.1 })];
    await watcher.tick();
    expect(announced.map((signal) => signal.key)).toEqual(["worker-birth:wNEW2"]);

    // The first one is killed over its ceiling; the lane says so.
    announced.length = 0;
    workers = workers.filter((entry) => entry.worker_id !== "wLIVE");
    await daemon.record({
      event: "worker-budget-kill",
      ts: new Date().toISOString(),
      detail: "tree RSS 2.4G over the declared MemoryMax of 2G",
      worker: {
        worker_id: "wLIVE",
        project_label: "reddb-io/red-skills",
        pid: 4242,
        started_at: "2026-08-01T09:00:00.000Z",
        workspace_path: "/workspaces/wLIVE",
        isolated: true,
        warnings: [],
      },
    });
    await watcher.tick();

    expect(announced.map((signal) => signal.kind)).toEqual(["worker-budget-kill"]);
    expect(announced[0]!.body).toContain("over the declared MemoryMax");
    expect(watcher.latest()!.payload!.workers.map((entry) => entry.worker_id)).toEqual(["wNEW2"]);
  });

  it("keeps rendering when the daemon goes away mid-session, and says it is gone", async () => {
    daemon = await startFakeDaemon();
    const socketPath = daemon.socketPath;
    const eventLanePath = daemon.eventLanePath;

    const announced: Signal[] = [];
    const watcher = createWatcher({
      read: async () =>
        await readHostSnapshot({
          client: createRedskilledReadClient({ socketPath, timeoutMs: 500 }),
          eventLanePath,
          source: "a test",
        }),
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      renotifyMs: () => 0,
      onSnapshot: () => {},
      onSignals: (signals) => announced.push(...signals),
    });

    await watcher.tick();
    await daemon.stop();
    daemon = null;

    const frame = await watcher.tick();
    expect(frame.reachable).toBe(false);
    expect(announced.map((signal) => signal.key)).toEqual(["daemon-reach:down"]);
    // The tree renders the absence rather than emptying itself.
    expect(buildWorkersTree(frame)[0]!.label).toBe("redskilled is not answering");
  });

  it("joins an in-flight read instead of starting a competing one", async () => {
    daemon = await startFakeDaemon();
    let reads = 0;
    const watcher = createWatcher({
      read: async () => {
        reads += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return await readHostSnapshot({
          client: createRedskilledReadClient({ socketPath: daemon!.socketPath }),
          eventLanePath: daemon!.eventLanePath,
          source: "a test",
        });
      },
      preferences: () => DEFAULT_NOTIFICATION_PREFERENCES,
      renotifyMs: () => 0,
      onSnapshot: () => {},
      onSignals: () => {},
    });

    await Promise.all([watcher.tick(), watcher.tick(), watcher.tick()]);
    expect(reads).toBe(1);
  });
});

describe("finding the socket", () => {
  it("prefers the setting, then the env pin, then the daemon's own derivation", () => {
    const env = { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv;

    const derived = resolveExtensionPaths({ env });
    expect(derived.socketPath).toContain("/run/user/1000");
    expect(derived.source).toBe("derived from XDG_RUNTIME_DIR");

    const pinnedByEnv = resolveExtensionPaths({ env: { ...env, REDSKILLED_SOCKET: "/tmp/pinned/d.sock" } });
    expect(pinnedByEnv.socketPath).toBe("/tmp/pinned/d.sock");
    expect(pinnedByEnv.source).toBe("derived from REDSKILLED_SOCKET");

    const pinnedBySetting = resolveExtensionPaths({
      env: { ...env, REDSKILLED_SOCKET: "/tmp/pinned/d.sock" },
      settingSocketPath: "/tmp/chosen/d.sock",
    });
    expect(pinnedBySetting.socketPath).toBe("/tmp/chosen/d.sock");
    expect(pinnedBySetting.source).toBe("the redskilled.socketPath setting");
  });

  it("moves the event lane with a pinned socket, so the two reads name one daemon", () => {
    const pinned = resolveExtensionPaths({
      env: { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv,
      settingSocketPath: "/tmp/chosen/d.sock",
    });
    expect(pinned.eventLanePath).toBe("/tmp/chosen/redskilled.log.toonl");
    // The derivation is still reported, so a doctor can say what it would have used.
    expect(pinned.derivedSocketPath).toContain("/run/user/1000");
  });
});
