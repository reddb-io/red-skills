// A client reaches the daemon over the socket and gets a well-formed, EMPTY
// host state. Empty is the whole assertion at this slice: no Worker is born
// yet, and a client must still be able to tell "up and idle" from "not there".
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState } from "../src/client.js";
import { buildHostState, isRedskilledHostState } from "../src/host-state.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveHostCeiling } from "../src/admission.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A tracked Worker view; placement fields are part of the total shape. */
function view(worker_id: string, project_label: string, pid: number) {
  return {
    worker_id,
    project_label,
    pid,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: `/workspaces/${project_label}`,
    isolated: true,
    unit: `red-worker-${project_label}-${worker_id}.service`,
    warnings: [] as string[],
  };
}

describe("redskilled host state", () => {
  it("answers a client over the socket with an empty, well-formed host state", async () => {
    const paths = await sessionPaths();
    const ceiling = resolveHostCeiling({}, 16_000_000_000, { config: { workerCeiling: "6" } });
    const daemon = await startRedskilledDaemon({ paths, daemonVersion: "1.2.3", ceiling });
    running.push(daemon);

    const state = await readRedskilledHostState(paths, { readyTimeoutMs: 5_000 });

    expect(isRedskilledHostState(state)).toBe(true);
    expect(state.workers).toEqual([]);
    expect(state.projects).toEqual([]);
    expect(state.daemon_version).toBe("1.2.3");
    expect(state.machine_id_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(state.session_key_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(state.protocol_version).toBe(1);
    expect(state.pid).toBe(process.pid);
    expect(state.ceiling).toMatchObject({
      worker_count: 6,
      worker_source: "home-config",
      memory_source: "derived-default",
    });
  });

  it("reports the daemon's WSL topology as an explicit host-state fact", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      hostTopology: { platform: "linux", environment: "wsl" },
    });
    running.push(daemon);

    const state = await readRedskilledHostState(paths, { readyTimeoutMs: 5_000 });

    expect(state.topology).toEqual({ platform: "linux", environment: "wsl" });
    expect(isRedskilledHostState(state)).toBe(true);
  });

  it("carries the host identity as a label, never as the socket's key", async () => {
    // Two sessions on the same host share the machine id and differ in socket.
    const first = await sessionPaths();
    const second = await sessionPaths();
    expect(first.machineIdHash).toBe(second.machineIdHash);
    expect(first.socketPath).not.toBe(second.socketPath);
    expect(first.sessionKeyHash).not.toBe(second.sessionKeyHash);
  });

  it("counts projects from the workers it holds, never from a second record", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths });
    running.push(daemon);

    daemon.trackWorker(view("w1", "beta", 1));
    daemon.trackWorker(view("w2", "alpha", 2));
    daemon.trackWorker(view("w3", "alpha", 3));

    expect(daemon.hostState().projects).toEqual([
      { project_label: "alpha", worker_count: 2 },
      { project_label: "beta", worker_count: 1 },
    ]);
  });

  it("carries the daemon's last demand refusal on the socket-local host state", () => {
    const demand = {
      version: 1 as const,
      at: "2026-08-04T18:05:00.000Z",
      requested: 1,
      granted: [],
      shortfall: 1,
      refusal: "host ceiling is temporarily full",
      retry_after: "2026-08-04T18:05:30.000Z",
      projects: [],
    };
    const state = buildHostState({
      daemonVersion: "3.4.2",
      machineIdHash: "machine",
      sessionKeyHash: "session",
      pid: 42,
      startedAt: "2026-08-04T18:00:00.000Z",
      demand,
    });

    expect(state.demand).toBe(demand);
    expect(isRedskilledHostState(state)).toBe(true);
  });
});
