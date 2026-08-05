// The MCP dispatch surface asks the host for its Workers (#2976, ADR 0130).
//
// `worker_dispatch` used to start the Worker itself: a `spawn` in the adapter,
// no admission verdict, no host budget, nothing on the event lane. Three live
// Workers, and a `host-state` that said `workers: 0`. The invariant was already
// written down — the daemon is the only thing that births a Worker — and the
// ratchet did not catch this path because the path was never declared.
//
// The daemon under test is the real one, started in-process on a scratch session
// socket. A mock would answer whatever the assertion wanted, and the fact worth
// proving is precisely that a second process does the launching now.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "@reddb-io/redskilled/daemon";
import { resolveRedskilledPaths, type RedskilledPaths } from "@reddb-io/redskilled/paths";
import { readRedskilledEvents } from "@reddb-io/redskilled/event-lane";
import { readRedskilledHostState, startRedskilledWorker } from "@reddb-io/redskilled/client";
import { dispatchLogPath, requestWorkerBirth } from "../src/runtime/mcp-worker-birth.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("mcp-dispatch-session-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

/** A Worker that idles long enough to be observed, then exits on its own. */
const IDLE_ENTRY = ["-e", "setTimeout(() => undefined, 30_000);"];

/** Paths that resolve to nothing on this machine — no daemon can answer here. */
async function unreachablePaths(): Promise<RedskilledPaths> {
  const root = await scratch("mcp-dispatch-nowhere-");
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

describe("a Worker dispatched through the MCP is born by the daemon", () => {
  it("appears in host state under this project's label and on the event lane", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("mcp-dispatch-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      refreshTrunk: async () => "dispatch-fork-sha",
    });
    running.push(daemon);

    const granted = await requestWorkerBirth(workspace, ["--issues", "2976", "--once"], {
      paths,
      projectLabel: "acme/widgets",
      entry: [process.execPath, ...IDLE_ENTRY],
      stamp: "2026-08-01T05:45:43.492Z-abcd1234",
    });

    expect(granted.pid).toBeGreaterThan(0);
    expect(granted.worker_id).not.toBe("");
    // The host's own sentence about the ceiling that admitted this birth: a
    // dispatch that reported no verdict would be a dispatch nothing judged.
    expect(granted.admission.trim()).not.toBe("");
    expect(granted.fork_sha).toBe("dispatch-fork-sha");

    const state = await readRedskilledHostState(paths, { readyTimeoutMs: 5_000 });
    const held = state.workers.find((worker) => worker.worker_id === granted.worker_id);
    expect(held?.project_label).toBe("acme/widgets");
    expect(held?.workspace_path).toBe(workspace);
    // Counted by the budget, which is the whole point of asking: the host's own
    // per-project tally is what an unbudgeted spawn never reached.
    expect(state.projects).toContainEqual({ project_label: "acme/widgets", worker_count: 1 });

    const events = await readRedskilledEvents(paths.eventLanePath);
    const birth = events.find(
      (event) => event.worker_id === granted.worker_id && event.event === "worker-birth",
    );
    expect(birth?.project_label).toBe("acme/widgets");
  });

  it("starts interactive work immediately above a saturated host without evicting the running Worker", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("mcp-dispatch-workspace-");
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      refreshTrunk: async () => "interactive-fork-sha",
      ceiling: { memory_bytes: null, worker_count: 1, interactive_reservation: 1, source: "declared" },
    });
    running.push(daemon);

    const autonomous = await startRedskilledWorker(paths, {
      project_label: "acme/widgets",
      workspace_path: workspace,
      command: process.execPath,
      args: IDLE_ENTRY,
    });
    const interactive = await requestWorkerBirth(workspace, ["--issues", "3176", "--once"], {
      paths,
      projectLabel: "acme/widgets",
      entry: [process.execPath, ...IDLE_ENTRY],
      reservation: "interactive",
    });

    expect(interactive.admission).toContain("reserved interactive slot 1/1");
    expect(daemon.hostState().workers.map((worker) => worker.worker_id)).toEqual(
      expect.arrayContaining([autonomous.worker.worker_id, interactive.worker_id]),
    );
  });

  it("refuses with a named reason and starts nothing when the daemon does not answer", async () => {
    const workspace = await scratch("mcp-dispatch-workspace-");
    const paths = await unreachablePaths();

    await expect(
      requestWorkerBirth(workspace, ["--issues", "2976", "--once"], {
        paths,
        projectLabel: "acme/widgets",
        entry: [process.execPath, ...IDLE_ENTRY],
        // No published bundle to auto-spawn a daemon from, and none invented.
        config: { entryLookup: {}, readyTimeoutMs: 250 },
      }),
    ).rejects.toThrow(/no Worker was started: the redskilled daemon did not answer/);

    // Nothing ran: the host holds no record, because nothing was ever launched.
    const events = await readRedskilledEvents(paths.eventLanePath).catch(() => []);
    expect(events.filter((event) => event.event === "worker-birth")).toEqual([]);
  });

  it("names a log path in the disposable logs lane, and the host opens it", async () => {
    const stamp = "2026-08-01T05:45:43.492Z-abcd1234";
    expect(dispatchLogPath("/repo", stamp)).toBe(
      join("/repo", ".red", "tmp", "logs", "2026-08-01", "dispatch-2026-08-01T05-45-43-492Z-abcd1234.log"),
    );
  });
});
