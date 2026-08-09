import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRecords } from "@reddb-io/toon";
import {
  DEATH_PHASE_UNSTARTED,
  PROCESS_DEATH_LANE_RETENTION_MS,
  activeDeathRecorder,
  appendProcessDeathRecord,
  buildProcessDeathRecord,
  decodeProcessDeathRecords,
  deathLaneFile,
  deathLaneFileIn,
  installDeathRecorder,
  markDeathPhase,
  UNSCOPED_PROCESS,
  readProcessDeathLane,
  sampleProcessResources,
  type DeathRecorder,
  type DeathRecorderHost,
} from "./death-record.js";
import { WORKER_SCOPE_CEILING_ENV, WORKER_SCOPE_ENV } from "./worker-scope.js";

/**
 * A posed process: it delivers signals and exits the way the kernel would, so a
 * death is exercised end to end without a real kill (Spec #3022's testing rule).
 */
function poseHost(pid = 4242): DeathRecorderHost & {
  deliver(event: string, arg?: unknown): void;
  listenerCount(event: string): number;
  reraised: string[];
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
    reraised: [],
    kill(target, signal) {
      expect(target).toBe(pid);
      this.reraised.push(signal);
      return true;
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return this;
    },
    off(event, listener) {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l !== listener));
      return this;
    },
    uptime: () => 12.4,
    memoryUsage: () => ({ rss: 512 * 1024 }),
    resourceUsage: () => ({
      userCPUTime: 111,
      systemCPUTime: 222,
      maxRSS: 333,
      minorPageFault: 4,
      majorPageFault: 5,
      voluntaryContextSwitches: 6,
      involuntaryContextSwitches: 7,
    }),
    deliver(event, arg) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(arg);
    },
    listenerCount: (event) => (listeners.get(event) ?? []).length,
  };
}

describe("death-record", () => {
  let dir: string;
  let lanePath: string;
  let installed: DeathRecorder | null = null;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "death-record-"));
    lanePath = join(dir, "deaths.toonl");
  });

  afterEach(() => {
    installed?.uninstall();
    installed = null;
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the signal, the exit path and the last phase when a worker is SIGTERMed", () => {
    const host = poseHost(9001);
    installed = installDeathRecorder({ lanePath, kind: "worker", id: "wQYGX", host });
    installed.phase("post-agent:landing-start");

    host.deliver("SIGTERM");

    const [record, ...rest] = readProcessDeathLane(lanePath);
    expect(rest).toEqual([]);
    expect(record).toMatchObject({
      kind: "worker",
      id: "wQYGX",
      pid: 9001,
      exit_path: "signal",
      signal: "SIGTERM",
      exit_code: null,
      last_phase: "post-agent:landing-start",
    });
  });

  it("names the scope that contained the worker and the ceiling it carried", () => {
    const host = poseHost(9002);
    installed = installDeathRecorder({
      lanePath,
      kind: "worker",
      id: "wSCOPE",
      host,
      scope: {
        scope: "red-worker-red-skills-wscope.service",
        memory_ceiling: "4294967296",
        scope_degradation: null,
      },
    });

    host.deliver("SIGTERM");

    expect(readProcessDeathLane(lanePath)[0]).toMatchObject({
      id: "wSCOPE",
      scope: "red-worker-red-skills-wscope.service",
      memory_ceiling: "4294967296",
      scope_degradation: null,
    });
  });

  it("reads its scope from the environment the host handed it at birth", () => {
    // The path a real Worker takes: the host stated the placement at birth and
    // the process never chose it, so no call site has to remember to forward it.
    process.env[WORKER_SCOPE_ENV] = "red-worker-red-skills-wenv.service";
    process.env[WORKER_SCOPE_CEILING_ENV] = "4294967296";
    try {
      const host = poseHost(9004);
      installed = installDeathRecorder({ lanePath, kind: "worker", id: "wENV", host });
      host.deliver("SIGTERM");
    } finally {
      delete process.env[WORKER_SCOPE_ENV];
      delete process.env[WORKER_SCOPE_CEILING_ENV];
    }

    expect(readProcessDeathLane(lanePath)[0]).toMatchObject({
      id: "wENV",
      scope: "red-worker-red-skills-wenv.service",
      memory_ceiling: "4294967296",
    });
  });

  it("names the degradation when the host could not scope the worker at all", () => {
    const host = poseHost(9003);
    installed = installDeathRecorder({
      lanePath,
      kind: "worker",
      id: "wBARE",
      host,
      scope: {
        scope: null,
        memory_ceiling: null,
        scope_degradation: "transient-unit placement unavailable: systemd-run is not on PATH",
      },
    });

    host.deliver("exit", 0);

    const [record] = readProcessDeathLane(lanePath);
    expect(record?.scope).toBeNull();
    expect(record?.scope_degradation).toContain("systemd-run is not on PATH");
  });

  it("reads a lane written before the scope facts existed as unscoped, not as broken", () => {
    const legacy =
      "[]{version,ts,kind,id,pid,exit_path,signal,exit_code,last_phase,detail,uptime_s,rss_kb,max_rss_kb," +
      "user_cpu_us,system_cpu_us,minor_page_faults,major_page_faults,voluntary_ctx_switches,involuntary_ctx_switches}:\n" +
      "1,2026-08-01T20:00:00.000Z,worker,wOLD,4242,exit,null,0,boot,null,12,512,333,111,222,4,5,6,7\n";

    const [record] = decodeProcessDeathRecords(legacy);
    expect(record).toMatchObject({ id: "wOLD", exit_path: "exit", scope: null, memory_ceiling: null });
  });

  it("distinguishes a clean exit from a killed one", () => {
    const clean = poseHost();
    const cleanLane = join(dir, "clean.toonl");
    const cleanRecorder = installDeathRecorder({
      lanePath: cleanLane,
      kind: "worker",
      id: "w-clean",
      host: clean,
      setActive: false,
    });
    clean.deliver("exit", 0);
    cleanRecorder.uninstall();

    const killed = poseHost();
    const killedLane = join(dir, "killed.toonl");
    const killedRecorder = installDeathRecorder({
      lanePath: killedLane,
      kind: "worker",
      id: "w-killed",
      host: killed,
      setActive: false,
    });
    killed.deliver("SIGTERM");
    killed.deliver("exit", 143);
    killedRecorder.uninstall();

    expect(readProcessDeathLane(cleanLane)[0]).toMatchObject({
      exit_path: "exit",
      exit_code: 0,
      signal: null,
    });
    // The signal latches: the exit that follows a delivered signal must not
    // overwrite the reason with the code the runtime happened to reach.
    expect(readProcessDeathLane(killedLane)[0]).toMatchObject({
      exit_path: "signal",
      signal: "SIGTERM",
      exit_code: null,
    });
  });

  it("round-trips through the TOONL decoder and carries rusage", () => {
    const host = poseHost();
    installed = installDeathRecorder({
      lanePath,
      kind: "daemon",
      id: "daemon:4242",
      host,
      clock: () => "2026-08-01T20:00:00.000Z",
      // Stated rather than inherited: this suite itself runs inside a Worker
      // whose own scope is in the environment, and a record that read it would
      // pin the machine that happened to run the test.
      scope: UNSCOPED_PROCESS,
    });
    host.deliver("SIGINT");

    const raw = readFileSync(lanePath, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    // Decodable by the plain TOON reader, not only by this module's own decoder.
    expect(parseRecords(raw)).toHaveLength(1);
    expect(decodeProcessDeathRecords(raw)[0]).toEqual({
      version: 1,
      ts: "2026-08-01T20:00:00.000Z",
      kind: "daemon",
      id: "daemon:4242",
      pid: 4242,
      exit_path: "signal",
      signal: "SIGINT",
      exit_code: null,
      last_phase: DEATH_PHASE_UNSTARTED,
      detail: null,
      scope: null,
      memory_ceiling: null,
      scope_degradation: null,
      uptime_s: 12,
      rss_kb: 512,
      max_rss_kb: 333,
      user_cpu_us: 111,
      system_cpu_us: 222,
      minor_page_faults: 4,
      major_page_faults: 5,
      voluntary_ctx_switches: 6,
      involuntary_ctx_switches: 7,
    });
  });

  it("hands a signal it alone traps back to the default disposition", () => {
    const host = poseHost();
    installed = installDeathRecorder({ lanePath, kind: "daemon", id: "d", host });

    host.deliver("SIGHUP");

    // Recorded, then re-raised with no listener left: the process dies of SIGHUP
    // exactly as it did before anything watched for it.
    expect(readProcessDeathLane(lanePath)[0]).toMatchObject({ signal: "SIGHUP" });
    expect(host.reraised).toEqual(["SIGHUP"]);
    expect(host.listenerCount("SIGHUP")).toBe(0);
  });

  it("leaves a signal another handler owns to that handler", () => {
    const host = poseHost();
    host.on("SIGTERM", () => undefined);
    installed = installDeathRecorder({ lanePath, kind: "daemon", id: "d", host });

    host.deliver("SIGTERM");

    expect(readProcessDeathLane(lanePath)[0]).toMatchObject({ signal: "SIGTERM" });
    expect(host.reraised).toEqual([]);
    expect(host.listenerCount("SIGTERM")).toBe(2);
  });

  it("records an uncaught exception with its description", () => {
    const host = poseHost();
    installed = installDeathRecorder({ lanePath, kind: "launcher", id: "mcp", host });
    host.deliver("uncaughtException", new TypeError("boom"));

    expect(readProcessDeathLane(lanePath)[0]).toMatchObject({
      kind: "launcher",
      exit_path: "uncaught-exception",
      detail: "TypeError: boom",
    });
  });

  it("appends every writer's record to one lane, closing a crash-cut tail", () => {
    appendProcessDeathRecord(
      lanePath,
      buildProcessDeathRecord(
        {
          ts: "2026-08-01T20:00:00.000Z",
          kind: "launcher",
          id: "mcp",
          pid: 1,
          exit_path: "exit",
          exit_code: 0,
          last_phase: "serving",
        },
        sampleProcessResources(poseHost()),
      ),
    );
    // Pose a writer that died mid-encode: its line never got its newline. The
    // next writer must close the line rather than fuse its own record onto it.
    truncateSync(lanePath, statSync(lanePath).size - 1);

    appendProcessDeathRecord(
      lanePath,
      buildProcessDeathRecord(
        {
          ts: "2026-08-01T20:00:01.000Z",
          kind: "worker",
          id: "w1",
          pid: 2,
          exit_path: "signal",
          signal: "SIGHUP",
          last_phase: "boot",
        },
        sampleProcessResources(poseHost()),
      ),
    );

    const records = readProcessDeathLane(lanePath);
    expect(records.map((r) => r.id)).toEqual(["mcp", "w1"]);
    expect(records.map((r) => r.kind)).toEqual(["launcher", "worker"]);
  });

  it("keeps fourteen days of deaths and drops older history when the lane advances", () => {
    const now = Date.parse("2026-08-08T20:00:00.000Z");
    const recordAt = (id: string, at: number) =>
      buildProcessDeathRecord(
        {
          ts: new Date(at).toISOString(),
          kind: "worker",
          id,
          pid: at,
          exit_path: "exit",
          exit_code: 0,
          last_phase: "done",
        },
        sampleProcessResources(poseHost()),
      );

    appendProcessDeathRecord(lanePath, recordAt("too-old", now - PROCESS_DEATH_LANE_RETENTION_MS - 1));
    appendProcessDeathRecord(lanePath, recordAt("cutoff", now - PROCESS_DEATH_LANE_RETENTION_MS));
    appendProcessDeathRecord(lanePath, recordAt("recent", now));

    expect(readProcessDeathLane(lanePath).map((record) => record.id)).toEqual(["cutoff", "recent"]);
  });

  it("answers the process-wide phase marker and lets go on uninstall", () => {
    const host = poseHost();
    installed = installDeathRecorder({ lanePath, kind: "worker", id: "w2", host });
    markDeathPhase("gate:running");
    expect(activeDeathRecorder()?.currentPhase()).toBe("gate:running");

    installed.uninstall();
    installed = null;
    expect(activeDeathRecorder()).toBeNull();
    expect(host.listenerCount("SIGTERM")).toBe(0);
    // A phase announced with nothing installed is a no-op, never a throw.
    expect(() => markDeathPhase("after")).not.toThrow();
  });

  it("hangs the lane off the durable state root, one name for every writer", () => {
    expect(deathLaneFile("/repo")).toBe("/repo/.red/state/deaths/deaths.toonl");
    expect(deathLaneFileIn("/home/op/.red/redskilled/state")).toBe(
      "/home/op/.red/redskilled/state/deaths/deaths.toonl",
    );
  });
});
