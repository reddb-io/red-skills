// The statusline's `loc=` cell, end to end, from a real Worktree to the row.
//
// PR #4286 rebuilt the v3 Worker row and deliberately left `loc=` off it: the
// daemon can only answer it from something the project publishes, and deriving
// it daemon-side would be a git walk PER RENDER against a checkout the daemon
// only knows the path of. That is right about the render path and wrong about
// where the measurement belongs — the Worker is standing in the Worktree.
//
// So the Worker measures its own diff ONCE PER STAGE TRANSITION and the pair
// rides the route `phase` and `step` already take: the `_meta.redskills.
// ticketStage` object → the daemon's parse → the pulse → the Worker display →
// the row. Every link is exercised here against a REAL git repository, because
// the one thing a fixture pair could not prove is that git was ever asked.
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { measureWorktreeDiff } from "@reddb-io/worker/acp";
import { stripAnsi } from "@reddb-io/redskilled-render";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { createDemandTurnRunner, type DemandTurnAdmission } from "../src/acp-demand-turn.js";
import type { ActiveWorkflowWorker } from "../src/acp-worker-lifecycle.js";
import {
  publishRedskilledWorkerLogLine,
  readRedskilledDashboardRender,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import { applyWorkerPulse, type RedskilledWorkerPulse } from "../src/worker-display.js";

const run = promisify(execFile);
const running: RedskilledDaemon[] = [];
const roots: string[] = [];

const PROJECT = "acme/widgets";
const NOW = "2026-08-21T12:10:00.000Z";

afterAll(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A Worktree on a Ticket branch: one round committed, one round still open. */
async function ticketWorktree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "worker-loc-worktree-"));
  roots.push(root);
  const git = (...args: string[]): Promise<unknown> => run("git", args, { cwd: root });
  await git("init", "--initial-branch=main");
  await git("config", "user.email", "worker@example.invalid");
  await git("config", "user.name", "Worker");
  await writeFile(join(root, "trunk.ts"), "one\ntwo\nthree\nfour\n");
  await git("add", "--all");
  await git("commit", "-m", "trunk");
  await git("checkout", "-b", "afk/4286-worker-loc");
  await writeFile(join(root, "feature.ts"), Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") + "\n");
  await writeFile(join(root, "trunk.ts"), "one\nfour\n");
  await git("add", "--all");
  await git("commit", "-m", "round one");
  // Round two, uncommitted: exactly the state a `loc=` that only read commits
  // would render as "this Worker has stopped producing".
  await writeFile(join(root, "trunk.ts"), "one\n");
  return root;
}

/** The daemon's own parse of a stage notification — the `sessionUpdateStage` seam. */
async function pulseFor(stage: Record<string, unknown>): Promise<RedskilledWorkerPulse> {
  const pulses: RedskilledWorkerPulse[] = [];
  let notify: ((method: string, params?: unknown) => Promise<void>) | null = null;
  const turn = createDemandTurnRunner({
    paths: {} as never,
    startWorker: (() => { throw new Error("injected admission owns the birth"); }) as never,
    hostState: () => ({ workers: [] }),
    sessionJournal: { create: async () => {} } as never,
    admit: async (input: DemandTurnAdmission) => {
      notify = input.notify as never;
      return {
        workerId: "w-loc",
        downstreamSessionId: "down",
        connection: {
          agent: { request: vi.fn(async () => ({ stopReason: "end_turn", _meta: {} })), notify: vi.fn() },
          close: vi.fn(),
        },
        socket: { destroy: vi.fn(), destroyed: false },
        endpoint: "/tmp/w-loc.sock",
        publicSessionId: "",
        notify: vi.fn(async () => {}),
        cancelled: false,
        cleaned: false,
      } as unknown as ActiveWorkflowWorker;
    },
    pulse: (pulse) => void pulses.push(pulse),
  });
  await turn({
    project: { projectId: "github:1", projectLabel: PROJECT, workspacePath: "/tmp/p" } as never,
    prompt: "p",
    workItem: "4286",
  });
  // The exact frame `notifyTicketStage` writes in packages/worker.
  await notify!("session/update", {
    sessionId: "s",
    update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "" } },
    _meta: { redskills: { ticketStage: stage } },
  });
  return pulses.at(-1)!;
}

describe("the Worker measures its own diff and the row prints it", () => {
  let worktree = "";
  let measured: { added: number; removed: number } | null = null;

  beforeAll(async () => {
    worktree = await ticketWorktree();
    measured = await measureWorktreeDiff({ worktree, base: "main" });
  }, 30_000);

  it("measures committed and uncommitted work in the Worktree it is standing in", () => {
    // 30 lines of a new committed file, plus three lines removed from trunk.ts
    // across a commit and an uncommitted edit — each line counted exactly once.
    expect(measured).toEqual({ added: 30, removed: 3 });
  });

  it("carries the pair through the stage notification the daemon already parses", async () => {
    const pulse = await pulseFor({ stage: "implement", ok: true, round: 1, ...measured });
    expect(pulse).toEqual({
      workerId: "w-loc", phase: "implement", step: "round 1", added: 30, removed: 3,
    });
  });

  it("folds the pair onto the display without disturbing what the Worker published", async () => {
    const pulse = await pulseFor({ stage: "gate", ok: true, ...measured });
    const display = applyWorkerPulse(
      { runner: "claude", model: "claude-opus-5", issue: "#4286" } as never,
      pulse,
    );
    expect(display).toMatchObject({ runner: "claude", issue: "#4286", added: 30, removed: 3 });
  });

  it("draws `loc=+30 -3` on the row the operator reads", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-loc-daemon-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const daemon = await startRedskilledDaemon({
      paths,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      clock: () => NOW,
    });
    running.push(daemon);
    daemon.trackWorker({
      worker_id: "w-loc",
      project_label: PROJECT,
      pid: 4242,
      started_at: "2026-08-21T12:00:00.000Z",
      workspace_path: worktree,
      isolated: true,
      warnings: [],
    });

    const pulse = await pulseFor({ stage: "gate", ok: true, round: 1, ...measured });
    const ack = await publishRedskilledWorkerLogLine(paths, {
      worker_id: "w-loc",
      line: "running the gate",
      display: applyWorkerPulse(
        { runner: "claude", model: "claude-opus-5", effort: "high", origin: "afk", issue: "#4286" } as never,
        pulse,
      )!,
      session_project: PROJECT,
    });
    expect(ack.accepted, ack.detail).toBe(true);

    const dashboard = await readRedskilledDashboardRender(
      paths,
      { project: PROJECT, maxWidth: 300 },
      { sessionProject: PROJECT },
    );
    const row = dashboard.rows.find((candidate) => candidate.worker_id === "w-loc");
    expect(row?.cells.loc).toBe("loc=+30 -3");
    expect(stripAnsi(row?.line ?? "")).toContain("loc=+30 -3");
    // Beside the cells #4286 already rebuilt, in the v3 order: after the phase
    // and its clocks, never in place of them.
    const line = stripAnsi(row?.line ?? "");
    expect(line.indexOf("loc=")).toBeGreaterThan(line.indexOf("gate"));
    expect(line).toContain("iss=#4286");
  }, 30_000);

  it("leaves the cell absent for a Worker nobody measured — never `loc=0`", async () => {
    const pulse = await pulseFor({ stage: "claim", ok: true });
    expect(pulse).toEqual({ workerId: "w-loc", phase: "claim" });
    expect(applyWorkerPulse(undefined, pulse)?.added).toBeNull();
    expect(applyWorkerPulse(undefined, pulse)?.removed).toBeNull();
  });
});
