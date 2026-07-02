import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { parseCli } from "../src/cli.js";
import { parseStopArgs, stopCommand, type StopIO } from "../src/commands/stop.js";

// ---------- helpers ----------

function capture(): { stream: Writable; text: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, text: () => buf };
}

function captureStderr(): { restore: () => void; text: () => string } {
  let buf = "";
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString();
    return true;
  };
  return { restore: () => { process.stderr.write = orig; }, text: () => buf };
}

function nullStream(): Writable {
  return new Writable({ write(_c, _e, cb) { cb(); } });
}

type FleetStatus = "stopped" | "none" | "stale" | "timeout";

function fakeIO(opts: {
  fleetStatus?: FleetStatus;
  fleetPid?: number;
  staleClaims?: string[];
  workerPid?: number | null;
  workerLive?: boolean;
  workerKillResult?: boolean;
} = {}): StopIO & { stopFleetCalled: boolean; removedDirs: string[]; workerKillCalled: boolean } {
  let stopFleetCalled = false;
  const removedDirs: string[] = [];
  let workerKillCalled = false;

  const io: StopIO & { stopFleetCalled: boolean; removedDirs: string[]; workerKillCalled: boolean } = {
    get stopFleetCalled() { return stopFleetCalled; },
    get removedDirs() { return removedDirs; },
    get workerKillCalled() { return workerKillCalled; },

    async stopFleet(_root, _out) {
      stopFleetCalled = true;
      return { status: opts.fleetStatus ?? "none", pid: opts.fleetPid };
    },
    async listStaleClaimDirs(_tmpDir) {
      return (opts.staleClaims ?? []).map((p) => ({ path: p }));
    },
    async removeDir(path) {
      removedDirs.push(path);
    },
    async readWorkerPid(_pidFile) {
      return opts.workerPid ?? null;
    },
    isLivePid(_pid) {
      return opts.workerLive ?? false;
    },
    async killTreeAndWait(_pid) {
      workerKillCalled = true;
      return opts.workerKillResult ?? true;
    },
  };
  return io;
}

// ---------- CLI routing ----------

describe("cli routing — stop", () => {
  it("routes 'stop' with no args", () => {
    expect(parseCli(["stop"])).toEqual({ command: "stop", args: [] });
  });

  it("routes 'stop --worker wXXXX' preserving the flag", () => {
    expect(parseCli(["stop", "--worker", "wBZ43"])).toEqual({
      command: "stop",
      args: ["--worker", "wBZ43"],
    });
  });
});

// ---------- parseStopArgs ----------

describe("parseStopArgs", () => {
  it("returns worker=null for bare stop", () => {
    expect(parseStopArgs([])).toEqual({ worker: null });
  });

  it("parses --worker <wid>", () => {
    expect(parseStopArgs(["--worker", "wBZ43"])).toEqual({ worker: "wBZ43" });
  });

  it("parses --worker=<wid> (= form)", () => {
    expect(parseStopArgs(["--worker=wQYIB"])).toEqual({ worker: "wQYIB" });
  });

  it("parses -w <wid> short flag", () => {
    expect(parseStopArgs(["-w", "wABC1"])).toEqual({ worker: "wABC1" });
  });
});

// ---------- fleet stop path ----------

describe("stopCommand — fleet stop", () => {
  it("targets the supervisor from afk-supervisor.pid, not individual workers", async () => {
    // In fleet mode stopCommand delegates entirely to io.stopFleet (which reads
    // afk-supervisor.pid). Worker-level kill (io.killTreeAndWait) must NOT fire.
    const io = fakeIO({ fleetStatus: "none" });
    const { stream } = capture();
    await stopCommand([], "/repo", stream, io);

    expect(io.stopFleetCalled).toBe(true);
    expect(io.workerKillCalled).toBe(false);
  });

  it("emits TOON with status=none when no fleet is running", async () => {
    const io = fakeIO({ fleetStatus: "none" });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("op: stop");
    expect(out).toContain("supervisor_status: none");
    expect(out).toContain("claims_released: 0");
  });

  it("emits TOON with status=stopped and supervisor_pid after clean shutdown", async () => {
    const io = fakeIO({ fleetStatus: "stopped", fleetPid: 1234 });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("op: stop");
    expect(out).toContain("supervisor_pid: 1234");
    expect(out).toContain("supervisor_status: stopped");
  });

  it("reconciles stale claim dirs after stop and reports the count", async () => {
    const staleDirs = ["/repo/.red/tmp/claims/42", "/repo/.red/tmp/claims/77"];
    const io = fakeIO({ fleetStatus: "stopped", fleetPid: 5678, staleClaims: staleDirs });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    // All stale dirs removed.
    expect(io.removedDirs).toEqual(staleDirs);
    expect(text()).toContain("claims_released: 2");
  });

  it("reconciles zero claims when none are stale", async () => {
    const io = fakeIO({ fleetStatus: "stale", fleetPid: 9999 });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    expect(io.removedDirs).toHaveLength(0);
    expect(text()).toContain("claims_released: 0");
  });

  it("returns exit code 1 and timeout status when supervisor survives SIGKILL", async () => {
    const io = fakeIO({ fleetStatus: "timeout", fleetPid: 4321 });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(1);
    expect(text()).toContain("supervisor_status: timeout");
  });

  it("output is valid TOON (no JSON braces)", async () => {
    const io = fakeIO({ fleetStatus: "stopped", fleetPid: 1, staleClaims: ["/c/1"] });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    const out = text();
    // TOON must not contain JSON delimiters.
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
    expect(out).not.toContain("[{");
  });
});

// ---------- --worker recycle path ----------

describe("stopCommand — --worker recycle", () => {
  it("SIGTERMs exactly one worker and does NOT stop the fleet", async () => {
    const io = fakeIO({ workerPid: 9000, workerLive: true, workerKillResult: true });
    const { stream } = capture();
    await stopCommand(["--worker", "wBZ43"], "/repo", stream, io);

    expect(io.workerKillCalled).toBe(true);
    expect(io.stopFleetCalled).toBe(false);
  });

  it("emits TOON with op=stop-worker and worker_status=stopped on success", async () => {
    const io = fakeIO({ workerPid: 9000, workerLive: true, workerKillResult: true });
    const { stream, text } = capture();
    const code = await stopCommand(["--worker", "wBZ43"], "/repo", stream, io);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("op: stop-worker");
    expect(out).toContain("worker: wBZ43");
    expect(out).toContain("worker_pid: 9000");
    expect(out).toContain("worker_status: stopped");
  });

  it("reports worker_status=none when the worker has no pid file", async () => {
    const io = fakeIO({ workerPid: null });
    const { stream, text } = capture();
    const code = await stopCommand(["--worker", "wXXXX"], "/repo", stream, io);

    expect(code).toBe(0);
    expect(text()).toContain("worker_status: none");
    expect(io.workerKillCalled).toBe(false);
  });

  it("reports worker_status=stale when the worker pid is not live", async () => {
    const io = fakeIO({ workerPid: 7777, workerLive: false });
    const { stream, text } = capture();
    const code = await stopCommand(["--worker", "wSTAL"], "/repo", stream, io);

    expect(code).toBe(0);
    expect(text()).toContain("worker_status: stale");
    expect(io.workerKillCalled).toBe(false);
  });

  it("returns exit code 1 and worker_status=timeout when the worker survives SIGKILL", async () => {
    const io = fakeIO({ workerPid: 3333, workerLive: true, workerKillResult: false });
    const { stream, text } = capture();
    const code = await stopCommand(["--worker", "wHANG"], "/repo", stream, io);

    expect(code).toBe(1);
    expect(text()).toContain("worker_status: timeout");
  });

  it("rejects an invalid worker id and returns exit code 1", async () => {
    const io = fakeIO();
    const { stream } = capture();
    const { restore, text: stderrText } = captureStderr();
    const code = await stopCommand(["--worker", "bad id!"], "/repo", stream, io);
    restore();

    expect(code).toBe(1);
    expect(stderrText()).toContain("invalid worker id");
  });

  it("output is valid TOON for the worker path (no JSON braces)", async () => {
    const io = fakeIO({ workerPid: 5555, workerLive: true, workerKillResult: true });
    const { stream, text } = capture();
    await stopCommand(["--worker", "wBZ43"], "/repo", stream, io);

    const out = text();
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
  });
});
