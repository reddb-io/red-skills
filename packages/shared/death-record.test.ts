import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseRecords } from "@reddb-io/toon";
import {
  DEATH_PHASE_UNSTARTED,
  activeDeathRecorder,
  appendProcessDeathRecord,
  buildProcessDeathRecord,
  decodeProcessDeathRecords,
  deathLaneFile,
  deathLaneFileIn,
  installDeathRecorder,
  markDeathPhase,
  readProcessDeathLane,
  sampleProcessResources,
  type DeathRecorder,
  type DeathRecorderHost,
} from "./death-record.js";

/**
 * A posed process: it delivers signals and exits the way the kernel would, so a
 * death is exercised end to end without a real kill (Spec #3022's testing rule).
 */
function poseHost(pid = 4242): DeathRecorderHost & {
  deliver(event: string, arg?: unknown): void;
  listenerCount(event: string): number;
} {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    pid,
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
