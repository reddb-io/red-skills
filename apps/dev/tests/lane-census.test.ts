import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectLaneCensusProbeInput,
  runLaneCensusProbe,
} from "../src/core/operational-probes/lane-census.js";
import {
  OPERATIONAL_PROBES,
  runOperationalProbes,
} from "../src/core/operational-probes.js";

describe("lane census operational probe", () => {
  it("reports registered lane bytes and lines against the declared ceiling", () => {
    const below = runLaneCensusProbe({
      lanes: [
        {
          id: "process-deaths",
          tier: "project",
          path: ".red/state/deaths/deaths.toonl",
          bytes: 99,
          lines: 3,
          maxBytes: 100,
        },
      ],
      unregisteredToonl: [],
      temps: [],
    });
    const above = runLaneCensusProbe({
      lanes: [
        {
          id: "process-deaths",
          tier: "project",
          path: ".red/state/deaths/deaths.toonl",
          bytes: 101,
          lines: 4,
          maxBytes: 100,
        },
      ],
      unregisteredToonl: [],
      temps: [],
    });

    expect(below).toMatchObject({ verdict: "ok" });
    expect(below.evidence).toContain("process-deaths(project)=99/100 bytes, 3 lines");
    expect(above).toMatchObject({ verdict: "red" });
    expect(above.evidence).toContain("process-deaths(project)=101/100 bytes, 4 lines [over]");
  });

  it("flags an unregistered TOONL lane and a dead-pid replacement temp", () => {
    const result = runLaneCensusProbe({
      lanes: [],
      unregisteredToonl: [".red/state/unknown/events.toonl"],
      temps: [
        { path: ".red/state/deaths/deaths.toonl.rotate-42", pid: 42, pidAlive: false },
        { path: "[host]/redskilled.log.toonl.retaining-43", pid: 43, pidAlive: true },
      ],
    });

    expect(result).toMatchObject({ verdict: "red" });
    expect(result.evidence).toContain("unregistered=.red/state/unknown/events.toonl");
    expect(result.evidence).toContain(
      "dead-pid-temps=.red/state/deaths/deaths.toonl.rotate-42(pid=42)",
    );
    expect(result.evidence).not.toContain("retaining-43");
  });

  it("walks registered project and host lanes while discovering unknown lanes and temps", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-census-"));
    const projectRoot = join(root, "project");
    const hostRoot = join(root, "host");
    try {
      const projectDeaths = join(projectRoot, ".red", "state", "deaths", "deaths.toonl");
      const workerLog = join(projectRoot, ".red", "tmp", "workers", "wTEST", "worker.log.toonl");
      const unknown = join(projectRoot, ".red", "state", "unknown", "events.toonl");
      const deadTemp = `${projectDeaths}.rotate-42`;
      const hostEvents = join(hostRoot, "redskilled.log.toonl");
      await Promise.all([
        mkdir(join(projectRoot, ".red", "state", "deaths"), { recursive: true }),
        mkdir(join(projectRoot, ".red", "tmp", "workers", "wTEST"), { recursive: true }),
        mkdir(join(projectRoot, ".red", "state", "unknown"), { recursive: true }),
        mkdir(hostRoot, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(projectDeaths, "header\nrecord\n"),
        writeFile(workerLog, "[3]{msg}:\none\ntwo\nthree\n"),
        writeFile(unknown, "mystery\n"),
        writeFile(deadTemp, "partial"),
        writeFile(hostEvents, "host-event\n"),
      ]);

      const input = await collectLaneCensusProbeInput({
        projectRoot,
        hostRoot,
        isPidAlive: (pid) => pid !== 42,
      });

      expect(input.lanes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "process-deaths",
          tier: "project",
          path: ".red/state/deaths/deaths.toonl",
          bytes: 14,
          lines: 2,
        }),
        expect.objectContaining({
          id: "worker-log",
          tier: "project",
          path: ".red/tmp/workers/wTEST/worker.log.toonl",
          lines: 3,
          maxLines: 50_000,
        }),
        expect.objectContaining({
          id: "redskilled-events",
          tier: "host",
          path: "[host]/redskilled.log.toonl",
          lines: 1,
        }),
      ]));
      expect(input.unregisteredToonl).toEqual([".red/state/unknown/events.toonl"]);
      expect(input.temps).toContainEqual({
        path: ".red/state/deaths/deaths.toonl.rotate-42",
        pid: 42,
        pidAlive: false,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports a live Worker log over 256 MiB as red with its path and size", async () => {
    const root = await mkdtemp(join(tmpdir(), "lane-census-live-log-"));
    const projectRoot = join(root, "project");
    const hostRoot = join(root, "host");
    const workerRoot = join(projectRoot, ".red", "tmp", "workers", "wLIVE");
    const workerLog = join(workerRoot, "worker.log.toonl");
    const warningBytes = 256 * 1024 * 1024;
    try {
      await mkdir(workerRoot, { recursive: true });
      await writeFile(join(workerRoot, "worker.pid"), String(process.pid));
      await writeFile(workerLog, "oversized\n");

      const input = await collectLaneCensusProbeInput({
        projectRoot,
        hostRoot,
        isPidAlive: (pid) => pid === process.pid,
        readStat: async (path) => path === workerLog
          ? { size: warningBytes + 1 }
          : stat(path),
      });
      const result = runLaneCensusProbe(input);

      expect(result).toMatchObject({ verdict: "red" });
      expect(result.evidence).toContain(
        ".red/tmp/workers/wLIVE/worker.log.toonl",
      );
      expect(result.evidence).toContain("268435457/268435456 bytes");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("is reachable through the shared operational probe registry", async () => {
    expect(OPERATIONAL_PROBES.map((probe) => probe.id)).toContain("runtime.lane-census");

    const report = await runOperationalProbes({
      remoteUrls: [],
      laneCensus: {
        lanes: [],
        unregisteredToonl: [".red/state/unknown/events.toonl"],
        temps: [],
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({ id: "runtime.lane-census" }));
  });
});
