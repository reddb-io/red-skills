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

function fakeIO(opts: {
  deregistered?: boolean;
  workersStopped?: string[];
  refusal?: string;
  staleClaims?: string[];
  claimLabels?: Record<number, string[]>;
  workerPid?: number | null;
  workerLive?: boolean;
  workerKillResult?: boolean;
} = {}): StopIO & {
  releaseProjectCalled: boolean;
  removedDirs: string[];
  labelRestores: Array<{ issue: number; labels: string[] }>;
  workerKillCalled: boolean;
} {
  let releaseProjectCalled = false;
  const removedDirs: string[] = [];
  const labelRestores: Array<{ issue: number; labels: string[] }> = [];
  let workerKillCalled = false;

  const io: StopIO & {
    releaseProjectCalled: boolean;
    removedDirs: string[];
    labelRestores: Array<{ issue: number; labels: string[] }>;
    workerKillCalled: boolean;
  } = {
    get releaseProjectCalled() { return releaseProjectCalled; },
    get removedDirs() { return removedDirs; },
    get labelRestores() { return labelRestores; },
    get workerKillCalled() { return workerKillCalled; },

    async releaseProject(_root: string) {
      releaseProjectCalled = true;
      return {
        deregistered: opts.deregistered ?? false,
        workersStopped: opts.workersStopped ?? [],
        ...(opts.refusal === undefined ? {} : { refusal: opts.refusal }),
      };
    },
    async listStaleClaimDirs(_tmpDir) {
      return (opts.staleClaims ?? []).map((p) => {
        const name = p.split("/").filter(Boolean).at(-1) ?? "";
        const issue = /^[1-9][0-9]*$/.test(name) ? Number(name) : undefined;
        return issue === undefined ? { path: p } : { path: p, issue };
      });
    },
    async restoreClaimLabels(_root, issue) {
      const labels = opts.claimLabels?.[issue] ?? [];
      if (!labels.includes("running")) return false;
      if (labels.includes("ready-for-human") || labels.some((l) => l.startsWith("blocked:"))) return false;
      labelRestores.push({ issue, labels: ["ready-for-agent"] });
      return true;
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

// ---------- project stop path ----------

describe("stopCommand — project stop", () => {
  it("gives the registration back rather than killing a process of our own", async () => {
    // Since ADR 0130 Amendment 4 there is no per-project process (#2909): the
    // stop is a deregistration plus the host ending the Workers it named, so
    // worker-level kill (io.killTreeAndWait) must NOT fire.
    const io = fakeIO({ deregistered: true });
    const { stream } = capture();
    await stopCommand([], "/repo", stream, io);

    expect(io.releaseProjectCalled).toBe(true);
    expect(io.workerKillCalled).toBe(false);
  });

  it("emits TOON reporting an unheld registration as an answer, not a fault", async () => {
    const io = fakeIO({ deregistered: false });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("op: stop");
    expect(out).toContain("deregistered: false");
    expect(out).toContain("claims_released: 0");
  });

  it("emits TOON naming how many Workers the host ended for us", async () => {
    const io = fakeIO({ deregistered: true, workersStopped: ["wAAAA", "wBBBB"] });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(0);
    const out = text();
    expect(out).toContain("deregistered: true");
    expect(out).toContain("workers_stopped: 2");
  });

  it("reconciles stale claim dirs after stop and reports the count", async () => {
    const staleDirs = ["/repo/.red/tmp/claims/42", "/repo/.red/tmp/claims/77"];
    const io = fakeIO({
      deregistered: true,
      staleClaims: staleDirs,
      claimLabels: { 42: ["running"], 77: ["running", "blocked:validation"] },
    });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    // All stale dirs removed.
    expect(io.removedDirs).toEqual(staleDirs);
    expect(io.labelRestores).toEqual([{ issue: 42, labels: ["ready-for-agent"] }]);
    expect(text()).toContain("claims_released: 2");
    expect(text()).toContain("labels_restored: 1");
  });

  it("reconciles zero claims when none are stale", async () => {
    const io = fakeIO({ deregistered: true });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    expect(io.removedDirs).toHaveLength(0);
    expect(text()).toContain("claims_released: 0");
  });

  it("returns exit code 1 and names the refusal when the host does not answer", async () => {
    const io = fakeIO({ refusal: "redskilled daemon unreachable" });
    const { stream, text } = capture();
    const code = await stopCommand([], "/repo", stream, io);

    expect(code).toBe(1);
    expect(text()).toContain("redskilled daemon unreachable");
  });

  it("output is valid TOON (no JSON braces)", async () => {
    const io = fakeIO({ deregistered: true, staleClaims: ["/c/1"] });
    const { stream, text } = capture();
    await stopCommand([], "/repo", stream, io);

    const out = text();
    // TOON must not contain JSON delimiters.
    expect(out).not.toContain("{");
    expect(out).not.toContain("}");
  });
});

// ---------- --worker recycle path ----------

describe("stopCommand — --worker recycle", () => {
  it("SIGTERMs exactly one worker and does NOT stop the fleet", async () => {
    const io = fakeIO({ workerPid: 9000, workerLive: true, workerKillResult: true });
    const { stream } = capture();
    await stopCommand(["--worker", "wBZ43"], "/repo", stream, io);

    expect(io.workerKillCalled).toBe(true);
    expect(io.releaseProjectCalled).toBe(false);
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
