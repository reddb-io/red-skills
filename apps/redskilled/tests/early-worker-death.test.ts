// A Worker that leaves before its first heartbeat still has two witnesses: the
// host event lane records what the daemon observed, and the shared payload makes
// that loss visible instead of rendering the newly-free host as merely idle.
import type { ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  REDSKILLED_DASHBOARD_DEFAULTS,
  REDSKILLED_STATUSLINE_DEFAULTS,
  renderRedskilledDashboard,
  renderRedskilledStatusline,
} from "@reddb-io/redskilled-render";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { LaunchedWorker, LaunchWorkerOptions, RedskilledWorkerSpec } from "../src/worker-launch.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths() {
  const root = await mkdtemp(join(tmpdir(), "redskilled-early-death-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
}

function earlyExitLaunch(state: { exit?: (code: number) => void }) {
  return (options: LaunchWorkerOptions): LaunchedWorker => {
    const workerId = options.spec.worker_id ?? "w-early";
    const worker: RedskilledWorkerView = {
      worker_id: workerId,
      project_label: options.spec.project_label,
      pid: 4_242,
      started_at: "2026-08-03T16:47:00.000Z",
      workspace_path: options.spec.workspace_path,
      isolated: false,
      warnings: [],
    };
    state.exit = (code) => options.onExit?.(workerId, code, null);
    return {
      worker,
      admission: options.admission,
      warnings: [],
      plan: {
        isolated: false,
        backend: "none",
        command: options.spec.command,
        args: [],
        budget: {},
        environment: {},
      },
      child: { pid: worker.pid } as ChildProcess,
    };
  };
}

function spec(): RedskilledWorkerSpec {
  return {
    worker_id: "w-early",
    project_label: "acme/widgets",
    workspace_path: "/tmp/acme/w-early",
    command: process.execPath,
  };
}

describe("a Worker that exits before its first write", () => {
  it("leaves a host-written death and renders as a loss, not quiet idleness", async () => {
    const paths = await sessionPaths();
    const launched: { exit?: (code: number) => void } = {};
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      clock: () => "2026-08-03T16:47:09.000Z",
      launch: earlyExitLaunch(launched),
      unitInventory: () => [],
    });
    running.push(daemon);

    daemon.startWorker(spec());
    launched.exit?.(70);
    await daemon.flushEvents();

    const events = await readRedskilledEvents(paths.eventLanePath);
    expect(events.map((event) => event.event)).toEqual(["worker-birth", "worker-death"]);
    expect(events[1]).toMatchObject({ worker_id: "w-early", pid: 4_242, exit_code: 70, signal: null });

    const payload = daemon.statuslinePayload();
    expect(payload.deaths?.latest).toMatchObject({
      id: "w-early",
      pid: 4_242,
      sender_class: "unknown",
      confidence: "none",
      last_phase: "unreported",
    });

    const line = renderRedskilledStatusline(payload, {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(line.line).toContain("†1 unknown");
    const dashboard = renderRedskilledDashboard(payload, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      mode: "local",
      project: "acme/widgets",
    });
    expect(dashboard.lines.some((entry) => entry.includes("w-early"))).toBe(true);
  });

  it("remains visible when a successor daemon replays the host event lane", async () => {
    const paths = await sessionPaths();
    const launched: { exit?: (code: number) => void } = {};
    const first = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      clock: () => "2026-08-03T16:47:09.000Z",
      launch: earlyExitLaunch(launched),
      unitInventory: () => [],
    });
    running.push(first);
    first.startWorker(spec());
    launched.exit?.(70);
    await first.flushEvents();
    await first.stop();

    const successor = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      clock: () => "2026-08-03T16:48:00.000Z",
      unitInventory: () => [],
    });
    running.push(successor);

    expect(successor.statuslinePayload().deaths?.latest).toMatchObject({
      id: "w-early",
      pid: 4_242,
      sender_class: "unknown",
      confidence: "none",
    });
  });
});
