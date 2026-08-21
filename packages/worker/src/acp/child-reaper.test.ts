/**
 * The child Agent dies with its Worker — and so does the process IT spawned.
 *
 * Issue #4241: every dead codex Worker left a live `codex-acp` pair behind, the
 * `npx` wrapper and the platform binary under it, re-parented onto the systemd
 * user manager. The bug was never visible in a unit test of the kill call,
 * because the pid the Worker held was not the process that survived. So the
 * fixture here is a WRAPPER: it spawns a grandchild that sleeps forever, and
 * the assertion is about the grandchild.
 */
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AgentConnection } from "@agentclientprotocol/sdk";
import { isLivePid } from "@reddb-io/shared/kill-tree.js";
import { afterEach, describe, expect, it } from "vitest";

import { WorkflowChildAgent } from "./child-agent.js";
import {
  forgetChildAgentProcess,
  liveChildAgentProcesses,
  reapChildAgentProcesses,
  registerChildAgentProcess,
} from "./child-reaper.js";

const orphanFixture = resolve(__dirname, "fixtures", "orphan-child.mjs");
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** A pid stops answering `kill -0` within `deadlineMs`, or the wait says so. */
async function goneWithin(pid: number, deadlineMs = 5_000): Promise<boolean> {
  const until = Date.now() + deadlineMs;
  while (Date.now() < until) {
    if (!isLivePid(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isLivePid(pid);
}

const silentParent = {
  notify: async () => undefined,
  request: async () => ({}),
} as unknown as AgentConnection["client"];

describe("a Worker closing its child Agent (#4241)", () => {
  it("kills the child AND the process the child spawned", async () => {
    const root = await mkdtemp(join(tmpdir(), "worker-orphan-reap-"));
    roots.push(root);
    const pidFile = join(root, "pids.json");
    const child = new WorkflowChildAgent({
      endpoint: {
        agent: "redcode",
        transport: "stdio",
        command: process.execPath,
        args: [orphanFixture, pidFile],
      },
      cwd: root,
      mcpServers: [],
      publicSessionId: "public-session",
      parent: silentParent,
    });

    const response = await child.prompt({
      sessionId: "public-session",
      prompt: [{ type: "text", text: "delegate" }],
    });
    expect(response.stopReason).toBe("end_turn");

    const pids = JSON.parse(await readFile(pidFile, "utf8")) as {
      child: number;
      grandchild: number;
    };
    // The premise: both are running, and the grandchild is a process the Worker
    // never saw. A test that skipped this would pass on a fixture that died on
    // its own.
    expect(isLivePid(pids.child), "the child Agent never started").toBe(true);
    expect(isLivePid(pids.grandchild), "the fixture spawned no grandchild").toBe(true);

    await child.close();

    expect(await goneWithin(pids.child), `child ${pids.child} outlived close()`).toBe(true);
    expect(
      await goneWithin(pids.grandchild),
      `grandchild ${pids.grandchild} outlived close() — the orphan #4241 is about`,
    ).toBe(true);
    expect(liveChildAgentProcesses()).not.toContain(pids.child);
  }, 30_000);
});

describe("the reap the process edge performs (#4241)", () => {
  it("signals every registered group synchronously, which is all an exit hook may do", async () => {
    // The same act `process.on("exit")` performs, proved without ending this
    // process: a detached leader with a child of its own, one synchronous
    // signal, both gone.
    const leader = spawn(
      process.execPath,
      [
        "-e",
        "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000)",
      ],
      { detached: true, stdio: "ignore" },
    );
    const pid = leader.pid;
    expect(pid).toBeTypeOf("number");
    registerChildAgentProcess(pid!);

    try {
      expect(liveChildAgentProcesses()).toContain(pid);
      expect(reapChildAgentProcesses("SIGKILL")).toBeGreaterThanOrEqual(1);
      expect(await goneWithin(pid!)).toBe(true);
    } finally {
      forgetChildAgentProcess(pid!);
    }
  }, 20_000);
});
