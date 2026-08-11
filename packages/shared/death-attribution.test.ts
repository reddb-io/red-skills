// The boot reaper, proven on a POSED host (Spec #3022, slice #3028).
//
// Every case here kills nothing and reboots nothing. The host is posed the way
// WSL2 was posed: a `/proc` tree that is walked for real, journal files that are
// read for real, and a presence anchor left behind exactly as an un-trap-able
// death leaves one. So the collector under test is the SHIPPED one — no fake
// evidence object stands in for the code an operator actually runs.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  attributeDeath,
  buildProcessPresence,
  collectHostDeathEvidence,
  decodeDeathAttributions,
  encodeDeathAttributions,
  formatDeathAttributions,
  readProcessPresences,
  runBootDeathReaper,
  writeProcessPresence,
  type DeathAttribution,
  type ProcessPresence,
} from "./death-attribution.js";
import {
  PROCESS_DEATH_LANE_MAX_BYTES,
  PROCESS_DEATH_LANE_RETENTION_MS,
  appendProcessDeathRecord,
  buildProcessDeathRecord,
  deathLaneFileIn,
  installDeathRecorder,
  readProcessDeathLane,
  type DeathRecorderHost,
  type ProcessResourceSample,
} from "./death-record.js";
import { deathAttributionFileIn, deathPresenceDirIn } from "./red-paths.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "death-attribution-"));
  roots.push(root);
  return root;
}

/**
 * A `/proc` tree with exactly the two things the reaper reads: the boot id, and
 * one directory per live pid. Walked for real by the shipped collector.
 */
function poseProc(bootId: string, livePids: readonly number[]): string {
  const procRoot = join(scratch(), "proc");
  mkdirSync(join(procRoot, "sys", "kernel", "random"), { recursive: true });
  writeFileSync(join(procRoot, "sys", "kernel", "random", "boot_id"), `${bootId}\n`);
  for (const pid of livePids) mkdirSync(join(procRoot, String(pid)), { recursive: true });
  // A non-numeric entry the kernel really has; the collector must not read it as a pid.
  mkdirSync(join(procRoot, "self"), { recursive: true });
  return procRoot;
}

function poseJournal(lines: readonly string[]): string {
  const path = join(scratch(), "kern.log");
  writeFileSync(path, `${lines.join("\n")}\n`);
  return path;
}

function presence(overrides: Partial<ProcessPresence> = {}): ProcessPresence {
  return {
    version: 1,
    ts: "2026-08-01T10:00:00.000Z",
    kind: "worker",
    id: "wOLFU",
    pid: 4242,
    ppid: 4200,
    boot_id: "boot-a",
    cgroup: "/user.slice/user-1000.slice/session-3.scope",
    last_phase: "gate",
    ...overrides,
  };
}

function laneAttribution(overrides: Partial<DeathAttribution> = {}): DeathAttribution {
  return {
    version: 1,
    ts: "2026-08-08T20:00:00.000Z",
    kind: "worker",
    id: "retained",
    pid: 4242,
    last_seen: "2026-08-08T19:59:00.000Z",
    last_phase: "gate",
    sender_class: "unknown",
    confidence: "none",
    signal: null,
    host_boot_changed: false,
    evidence: [],
    checked: [],
    ...overrides,
  };
}

const SAMPLE: ProcessResourceSample = {
  uptime_s: 1,
  rss_kb: 2,
  max_rss_kb: 3,
  user_cpu_us: 4,
  system_cpu_us: 5,
  minor_page_faults: 6,
  major_page_faults: 7,
  voluntary_ctx_switches: 8,
  involuntary_ctx_switches: 9,
};

describe("evidence collection", () => {
  it("reads the boot id and the live pid set from a posed /proc", () => {
    const procRoot = poseProc("boot-b", [1, 4242]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [] });
    expect(evidence.boot_id).toBe("boot-b");
    expect([...evidence.live_pids].sort((a, b) => a - b)).toEqual([1, 4242]);
  });

  it("names every source it consulted, including the ones it could not read", () => {
    const procRoot = poseProc("boot-b", []);
    const evidence = collectHostDeathEvidence({
      procRoot,
      journalPaths: [join(procRoot, "no-such-journal.log")],
    });
    const journalProbe = evidence.probes.find((probe) => probe.source.endsWith("no-such-journal.log"));
    expect(journalProbe?.result).toBe("absent");
  });
});

describe("attribution", () => {
  it("attributes a posed SIGKILL to oomd, naming the kernel line it used", () => {
    const procRoot = poseProc("boot-a", [1]);
    const journal = poseJournal([
      "Aug  1 10:00:00 host kernel: Out of memory: Killed process 4242 (node) total-vm:9GB",
    ]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("oomd");
    expect(attribution.confidence).toBe("high");
    expect(attribution.signal).toBe("SIGKILL");
    expect(attribution.evidence.join(" ")).toContain("Killed process 4242");
  });

  it("attributes a cgroup-scoped oomd kill the kernel never named by pid", () => {
    const procRoot = poseProc("boot-a", [1]);
    const journal = poseJournal([
      "Aug  1 10:00:00 host systemd-oomd[9]: Killed /user.slice/user-1000.slice/session-3.scope" +
        " due to memory pressure for /user.slice with pressure 62%",
    ]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("oomd");
    expect(attribution.evidence.join(" ")).toContain("session-3.scope");
  });

  it("attributes a user signal to its sender uid from an audit line", () => {
    const procRoot = poseProc("boot-a", [1]);
    const journal = poseJournal([
      "Aug  1 10:00:00 host audispd: type=OBJ_PID msg=audit(1): opid=4242 sig=9 uid=1000 ocomm=node",
    ]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("user-signal");
    expect(attribution.signal).toBe("SIGKILL");
    expect(attribution.evidence.join(" ")).toContain("uid=1000");
  });

  it("attributes a child to its parent's recorded death when nothing else names it", () => {
    const procRoot = poseProc("boot-a", [1]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [] });
    const parentDeath = buildProcessDeathRecord(
      {
        ts: "2026-08-01T10:00:01.000Z",
        kind: "launcher",
        id: "launcher-1",
        pid: 4200,
        exit_path: "signal",
        signal: "SIGTERM",
        last_phase: "serving",
      },
      SAMPLE,
    );

    const attribution = attributeDeath(presence(), evidence, [parentDeath], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("parent-death");
    expect(attribution.evidence.join(" ")).toContain("4200");
  });

  it("attributes a death during a freeze from the boot boundary alone, unclean", () => {
    // No watcher was alive and no journal survived: the host simply came back
    // under a different boot id. That absence IS the evidence.
    const procRoot = poseProc("boot-b", [1]);
    const journal = poseJournal(["Aug  1 10:30:00 host kernel: Linux version 7.0.0 booting"]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("teardown");
    expect(attribution.host_boot_changed).toBe(true);
    expect(attribution.confidence).toBe("medium");
    expect(attribution.evidence.join(" ")).toMatch(/no shutdown record/i);
    expect(attribution.last_phase).toBe("gate");
  });

  it("raises a clean teardown to high confidence when the host announced it", () => {
    const procRoot = poseProc("boot-b", [1]);
    const journal = poseJournal([
      "Aug  1 10:29:00 host systemd-shutdown[1]: Powering off.",
    ]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("teardown");
    expect(attribution.confidence).toBe("high");
  });

  it("reports an honestly unknown cause as unknown, with what was checked", () => {
    const procRoot = poseProc("boot-a", [1]);
    const missing = join(procRoot, "absent-journal.log");
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [missing] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("unknown");
    expect(attribution.confidence).toBe("none");
    expect(attribution.signal).toBeNull();
    expect(attribution.evidence).toEqual([]);
    expect(attribution.checked.join(" ")).toContain("absent-journal.log");
    expect(attribution.checked.join(" ")).toMatch(/boot id/i);
    expect(attribution.checked.join(" ")).toMatch(/parent/i);
  });

  it("downgrades a pid-matched kernel line across a boot boundary", () => {
    // The pid the old journal names may belong to a different process now.
    const procRoot = poseProc("boot-b", [1]);
    const journal = poseJournal([
      "Aug  1 10:00:00 host kernel: Out of memory: Killed process 4242 (node)",
    ]);
    const evidence = collectHostDeathEvidence({ procRoot, journalPaths: [journal] });

    const attribution = attributeDeath(presence(), evidence, [], "2026-08-01T11:00:00.000Z");

    expect(attribution.sender_class).toBe("oomd");
    expect(attribution.confidence).toBe("medium");
    expect(attribution.evidence.join(" ")).toMatch(/boot/i);
  });
});

describe("the presence anchor", () => {
  it("round-trips through the lane directory", () => {
    const dir = join(scratch(), "live");
    const anchor = presence();
    writeProcessPresence(dir, anchor);
    expect(readProcessPresences(dir)).toEqual([anchor]);
  });

  it("a recorder writes its anchor on install and clears it on a recorded death", () => {
    const stateRoot = scratch();
    const host = poseHost(7777);
    const recorder = installDeathRecorder({
      lanePath: deathLaneFileIn(stateRoot),
      kind: "worker",
      id: "wLIVE",
      host,
      setActive: false,
    });
    const dir = deathPresenceDirIn(stateRoot);
    expect(readProcessPresences(dir).map((p) => p.pid)).toEqual([7777]);

    recorder.phase("landing");
    expect(readProcessPresences(dir)[0]?.last_phase).toBe("landing");

    recorder.handlers.exit(0);
    expect(readProcessPresences(dir)).toEqual([]);
    recorder.uninstall();
  });
});

describe("the boot reaper", () => {
  it("retains attribution history for fourteen days and one MiB, preserving unknown timestamps", () => {
    const stateRoot = scratch();
    const now = Date.parse("2026-08-15T20:00:00.000Z");
    const recent = Array.from({ length: 1_200 }, (_, index) =>
      laneAttribution({
        id: `recent-${index}`,
        ts: new Date(now - 1_000 + index).toISOString(),
        checked: [`source-${index}-${"x".repeat(1_000)}`],
      }),
    );
    const attributionPath = deathAttributionFileIn(stateRoot);
    mkdirSync(dirname(attributionPath), { recursive: true });
    writeFileSync(
      attributionPath,
      encodeDeathAttributions([
        laneAttribution({ id: "too-old", ts: "2026-07-01T00:00:00.000Z" }),
        laneAttribution({ id: "unknown-age", ts: "not-a-timestamp" }),
        ...recent,
      ]),
    );
    writeProcessPresence(deathPresenceDirIn(stateRoot), presence());

    const result = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot: poseProc("boot-a", [1]), journalPaths: [] }),
      now: () => new Date(now).toISOString(),
    });
    const retained = decodeDeathAttributions(result.laneText());

    expect(retained.map((entry) => entry.id)).not.toContain("too-old");
    expect(retained.map((entry) => entry.id)).toContain("unknown-age");
    expect(retained.map((entry) => entry.id)).not.toContain("recent-0");
    expect(retained.map((entry) => entry.id)).toContain("recent-1199");
    expect(retained.map((entry) => entry.id)).toContain("wOLFU");
    expect(Buffer.byteLength(result.laneText())).toBeLessThanOrEqual(1024 * 1024);
  });

  it("compacts an oversized death lane before serve boot returns", () => {
    const stateRoot = scratch();
    const lanePath = deathLaneFileIn(stateRoot);
    const record = buildProcessDeathRecord(
      {
        ts: "2026-08-08T20:00:00.000Z",
        kind: "worker",
        id: "oversized-at-boot",
        pid: 4242,
        exit_path: "exit",
        exit_code: 0,
        last_phase: "done",
        detail: "x".repeat(1_000),
      },
      SAMPLE,
    );
    appendProcessDeathRecord(lanePath, record);
    const segment = readFileSync(lanePath, "utf8");
    writeFileSync(
      lanePath,
      segment.repeat(Math.ceil((PROCESS_DEATH_LANE_MAX_BYTES + 1) / Buffer.byteLength(segment))),
    );

    runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot: poseProc("boot-a", [1]), journalPaths: [] }),
      now: () => "2026-08-08T20:00:00.000Z",
    });

    expect(statSync(lanePath).size).toBeLessThanOrEqual(PROCESS_DEATH_LANE_MAX_BYTES / 2);
  });

  it("attributes the absent-but-expected record and clears its anchor", () => {
    const stateRoot = scratch();
    const dir = deathPresenceDirIn(stateRoot);
    writeProcessPresence(dir, presence());
    const procRoot = poseProc("boot-a", [1]);
    const journal = poseJournal([
      "Aug  1 10:00:00 host kernel: Out of memory: Killed process 4242 (node)",
    ]);

    const result = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot, journalPaths: [journal] }),
      now: () => "2026-08-01T11:00:00.000Z",
    });

    expect(result.attributions).toHaveLength(1);
    expect(result.attributions[0]?.sender_class).toBe("oomd");
    expect(readProcessPresences(dir)).toEqual([]);
    expect(decodeDeathAttributions(result.laneText())).toEqual(result.attributions);
  });

  it("leaves a still-running process alone", () => {
    const stateRoot = scratch();
    const dir = deathPresenceDirIn(stateRoot);
    writeProcessPresence(dir, presence());
    const procRoot = poseProc("boot-a", [1, 4242]);

    const result = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot, journalPaths: [] }),
      now: () => "2026-08-01T11:00:00.000Z",
    });

    expect(result.attributions).toEqual([]);
    expect(result.alive.map((p) => p.pid)).toEqual([4242]);
    expect(readProcessPresences(dir)).toHaveLength(1);
  });

  it("never re-attributes a death whose own record already explains it", () => {
    const stateRoot = scratch();
    const dir = deathPresenceDirIn(stateRoot);
    writeProcessPresence(dir, presence());
    appendProcessDeathRecord(
      deathLaneFileIn(stateRoot),
      buildProcessDeathRecord(
        {
          ts: "2026-08-01T10:00:05.000Z",
          kind: "worker",
          id: "wOLFU",
          pid: 4242,
          exit_path: "signal",
          signal: "SIGTERM",
          last_phase: "gate",
        },
        SAMPLE,
      ),
    );
    const procRoot = poseProc("boot-a", [1]);

    const result = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot, journalPaths: [] }),
      now: () => "2026-08-01T11:00:00.000Z",
    });

    expect(result.attributions).toEqual([]);
    expect(result.self_recorded.map((p) => p.pid)).toEqual([4242]);
    // The stale anchor still goes: the death it stood for is explained.
    expect(readProcessPresences(dir)).toEqual([]);
  });

  it("attributes anchors before removing deaths outside the retention window", () => {
    const stateRoot = scratch();
    const dir = deathPresenceDirIn(stateRoot);
    const reapedAt = Date.parse("2026-08-08T20:00:00.000Z");
    writeProcessPresence(dir, presence());
    appendProcessDeathRecord(
      deathLaneFileIn(stateRoot),
      buildProcessDeathRecord(
        {
          ts: new Date(reapedAt - PROCESS_DEATH_LANE_RETENTION_MS - 1).toISOString(),
          kind: "worker",
          id: "wOLFU",
          pid: 4242,
          exit_path: "signal",
          signal: "SIGTERM",
          last_phase: "gate",
        },
        SAMPLE,
      ),
    );

    const result = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot: poseProc("boot-a", [1]), journalPaths: [] }),
      now: () => new Date(reapedAt).toISOString(),
    });

    expect(result.attributions).toEqual([]);
    expect(result.self_recorded.map((anchor) => anchor.pid)).toEqual([4242]);
    expect(readProcessDeathLane(deathLaneFileIn(stateRoot))).toEqual([]);
  });

  it("reports its verdicts on one line, and says so when there are none", () => {
    const stateRoot = scratch();
    const procRoot = poseProc("boot-b", [1]);
    const quiet = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot, journalPaths: [] }),
      now: () => "2026-08-01T11:00:00.000Z",
    });
    expect(formatDeathAttributions(quiet)).toContain("no un-recorded deaths");

    writeProcessPresence(deathPresenceDirIn(stateRoot), presence());
    const loud = runBootDeathReaper({
      stateRoot,
      evidence: collectHostDeathEvidence({ procRoot, journalPaths: [] }),
      now: () => "2026-08-01T11:00:00.000Z",
    });
    expect(formatDeathAttributions(loud)).toContain("teardown/medium");
    expect(formatDeathAttributions(loud)).toContain("phase=gate");
  });

  it("builds a presence from a live host without being told its pid", () => {
    const built = buildProcessPresence(
      { kind: "daemon", id: "redskilled", last_phase: "serving" },
      { procRoot: poseProc("boot-c", []), now: () => "2026-08-01T11:00:00.000Z" },
    );
    expect(built.pid).toBe(process.pid);
    expect(built.ppid).toBe(process.ppid);
    expect(built.boot_id).toBe("boot-c");
  });
});

/** The same posed process the death-record suite uses, minus its assertions. */
function poseHost(pid: number): DeathRecorderHost & { deliver(event: string, arg?: unknown): void } {
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
    listenerCount: (event) => (listeners.get(event) ?? []).length,
    kill: () => true,
    uptime: () => 1,
    memoryUsage: () => ({ rss: 1024 }),
    resourceUsage: () => ({
      userCPUTime: 1,
      systemCPUTime: 1,
      maxRSS: 1,
      minorPageFault: 1,
      majorPageFault: 1,
      voluntaryContextSwitches: 1,
      involuntaryContextSwitches: 1,
    }),
    deliver(event, arg) {
      for (const listener of [...(listeners.get(event) ?? [])]) listener(arg);
    },
  };
}
