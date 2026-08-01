// Dispatch survives the dispatcher (#3027, Spec #3022 pillar 5).
//
// `/go` and `/go --scout` ran the engine IN-PROCESS, so the command was the work
// rather than the order: a UI stop, a session teardown or a closed terminal took
// the investigation with it — two scout dispatches died that way on 2026-08-01,
// leaving no record anywhere. Detachment is therefore not a flag to assert but a
// process fact to prove, which is why the second suite kills a real dispatcher.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startRedskilledDaemon, type RedskilledDaemon } from "@reddb-io/redskilled/daemon";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { goCommand, type GoRuntime } from "../src/commands/go.js";
import type { DispatchedWorkerBirth } from "../src/runtime/mcp-worker-birth.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];
const strays: number[] = [];

afterEach(async () => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Already gone is the state we wanted anyway.
    }
  }
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

/** Signal 0: does this pid exist? `EPERM` means it does, under another user. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const GRANTED: DispatchedWorkerBirth = {
  worker_id: "worker-3027",
  pid: 424_242,
  log: "/tmp/red/logs/2026-08-01/dispatch-3027.log",
  warnings: [],
  admission: "admitted: 1 of 3 workers",
};

interface RecordedRuntime {
  runtime: GoRuntime;
  born: string[][];
  attached: string[][];
  output: string[];
}

function recordingRuntime(overrides: Partial<GoRuntime> = {}): RecordedRuntime {
  const born: string[][] = [];
  const attached: string[][] = [];
  const output: string[] = [];
  const runtime: GoRuntime = {
    ensureLabel: async () => undefined,
    createGoIssue: async () => 3027,
    createScoutIssue: async () => 3027,
    birthWorker: async (args) => {
      born.push([...args]);
      return GRANTED;
    },
    runEngineAttached: async (args) => {
      attached.push([...args]);
      return 7;
    },
    hasHarness: false,
    write: (text) => output.push(text),
    ...overrides,
  };
  return { runtime, born, attached, output };
}

describe("a /go dispatch hands the work to the host instead of running it", () => {
  it("births a detached worker for a scout question and runs no engine here", async () => {
    const recorded = recordingRuntime();
    const code = await goCommand(["--scout", "why did it die?"], "/workspace", recorded.runtime);

    expect(code).toBe(0);
    expect(recorded.attached).toEqual([]);
    expect(recorded.born).toHaveLength(1);
    expect(recorded.born[0]).toContain("--run-mode");
    expect(recorded.born[0]).toContain("scout");
  });

  it("does the same for a standard demand dispatch", async () => {
    const recorded = recordingRuntime();
    const code = await goCommand(["fix the flaky login test"], "/workspace", recorded.runtime);

    expect(code).toBe(0);
    expect(recorded.attached).toEqual([]);
    expect(recorded.born).toHaveLength(1);
  });

  // The answer is the whole handover: once the launcher is gone, a line that
  // said only "dispatched" left an operator with nothing to follow.
  it("names the worker id and the log lane to watch it in", async () => {
    const recorded = recordingRuntime();
    await goCommand(["--scout", "why did it die?"], "/workspace", recorded.runtime);

    const answer = recorded.output.join("");
    expect(answer).toContain("worker-3027");
    expect(answer).toContain("/tmp/red/logs/2026-08-01/dispatch-3027.log");
    expect(answer).toContain("#3027");
  });

  it("reports the host's warnings rather than swallowing a degraded birth", async () => {
    const recorded = recordingRuntime({
      birthWorker: async () => ({ ...GRANTED, warnings: ["placement downgraded: no systemd"] }),
    });
    await goCommand(["--scout", "why did it die?"], "/workspace", recorded.runtime);

    expect(recorded.output.join("")).toContain("placement downgraded: no systemd");
  });

  // The opt-out stays reachable for a foreground debug session, and it is the
  // only way back into the in-process run.
  it("runs the engine in this process and returns its exit code under --attached", async () => {
    const recorded = recordingRuntime();
    const code = await goCommand(
      ["--scout", "--attached", "why did it die?"],
      "/workspace",
      recorded.runtime,
    );

    expect(code).toBe(7);
    expect(recorded.born).toEqual([]);
    expect(recorded.attached).toHaveLength(1);
    expect(recorded.output.join("")).toContain("attached");
  });

  it("refuses the dispatch when the host grants no worker, and starts nothing", async () => {
    const recorded = recordingRuntime({
      birthWorker: async () => {
        throw new Error("redskilled is not reachable on this socket");
      },
    });
    const code = await goCommand(["--scout", "why did it die?"], "/workspace", recorded.runtime);

    expect(code).toBe(1);
    expect(recorded.attached).toEqual([]);
  });
});

describe("killing the dispatcher leaves the dispatched worker running", () => {
  it("survives a SIGKILL of the process that dispatched it", async () => {
    const host = await scratch("go-dispatch-host-");
    const workspace = await scratch("go-dispatch-workspace-");
    const env = {
      ...process.env,
      REDSKILLED_SESSION: `test:${host}`,
      XDG_RUNTIME_DIR: host,
      REDSKILLED_MACHINE_DIR: host,
    };
    const paths = resolveRedskilledPaths({ env });
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const tsx = join(import.meta.dirname, "..", "node_modules", ".bin", "tsx");
    const dispatcher = spawn(
      tsx,
      [join(import.meta.dirname, "support", "go-dispatch-dispatcher.ts"), workspace],
      { cwd: join(import.meta.dirname, ".."), env, stdio: ["ignore", "pipe", "pipe"] },
    );
    strays.push(dispatcher.pid!);

    let answer = "";
    const workerPid = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`dispatcher never answered: ${answer}`)), 25_000);
      dispatcher.stderr.on("data", (chunk: Buffer) => { answer += chunk.toString(); });
      dispatcher.stdout.on("data", (chunk: Buffer) => {
        answer += chunk.toString();
        const match = /\(pid (\d+)\)/.exec(answer);
        if (match) {
          clearTimeout(timer);
          resolve(Number(match[1]));
        }
      });
    });
    strays.push(workerPid);

    // The dispatcher is still alive at the moment of the kill, so what follows
    // is a death it did not choose — a UI stop, in one signal.
    expect(isAlive(dispatcher.pid!)).toBe(true);
    dispatcher.kill("SIGKILL");
    await new Promise<void>((resolve) => dispatcher.once("exit", () => resolve()));

    expect(isAlive(dispatcher.pid!)).toBe(false);
    // Not merely alive at the instant of the kill: still there afterwards,
    // because it was never the dispatcher's child to begin with.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(isAlive(workerPid)).toBe(true);
  }, 60_000);
});
