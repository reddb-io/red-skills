import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RedskilledProcessCensusRow } from "@reddb-io/redskilled/orphan-reaper";
import {
  OPERATIONAL_PROBES,
  runOperationalProbes,
} from "../src/core/operational-probes.js";
import {
  collectProcessCensusProbeInput,
  runProcessCensusProbe,
} from "../src/core/operational-probes/process-census.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function processRow(overrides: Partial<RedskilledProcessCensusRow> = {}): RedskilledProcessCensusRow {
  return {
    pid: 4_242,
    ppid: 1,
    pgid: 4_242,
    sid: 4_242,
    starttime: "1200",
    age_ms: 10 * 60_000,
    worker_id: "hLOST",
    born_at: "2026-08-11T10:00:00.000Z",
    cwd: "/repo/.red/tmp/workers/wLOST/3598/worktree",
    under_workers_lane: true,
    ...overrides,
  };
}

describe("process census operational probe", () => {
  it("counts every host-process class on the host-prerequisites template", async () => {
    const report = await runOperationalProbes({
      remoteUrls: [],
      hostPrerequisites: {
        commands: { bash: true, git: true, jq: true, gh: true, node: true, timeout: true, ps: true },
        bashVersion: "GNU bash, version 5.2.15(1)-release",
      },
      processCensus: {
        processes: [
          processRow({ worker_id: "hHELD" }),
          processRow(),
          processRow({ worker_id: undefined, born_at: undefined, pid: 5_000, pgid: 5_000, age_ms: 30 * 60_000 }),
        ],
        active_worker_units: ["red-worker-acme-wHELD.service"],
        held_worker_ids: new Set(["hHELD"]),
        live_birth_ids: new Set(),
        dump_files: [".red/tmp/workers/wLOST/3598/worktree/core.4242"],
      },
    });

    expect(report.findings).toContainEqual(expect.objectContaining({
      id: "runtime.process-census",
      verdict: "red",
      data: {
        version: 1,
        active_worker_units: 1,
        daemon_held_workers: 1,
        stamped_orphans: 1,
        unstamped_suspects: 1,
        dump_files: 1,
      },
    }));
    expect(report.findings.find((finding) => finding.id === "runtime.process-census")?.evidence)
      .toBe("active-worker-units=1; daemon-held-workers=1; stamped-orphans=1; unstamped-suspects=1; dump-files=1");
  });

  it("stays detection-only and names the canonical reap report invocation", () => {
    const result = runProcessCensusProbe({
      processes: [processRow()],
      active_worker_units: [],
      held_worker_ids: new Set(),
      live_birth_ids: new Set(),
      dump_files: [],
    });

    expect(result.fix).toBeUndefined();
    expect(result.canonicalFix).toContain("red-skills-redskilled reap --report");
  });

  it("discovers project dump files without mutating them", async () => {
    const root = await mkdtemp(join(tmpdir(), "process-census-"));
    roots.push(root);
    const worker = join(root, ".red", "tmp", "workers", "wLOST", "3598", "worktree");
    const dump = join(worker, "core.4242");
    await mkdir(worker, { recursive: true });
    await writeFile(dump, "incident evidence", "utf8");

    const input = await collectProcessCensusProbeInput({
      projectRoot: root,
      processes: () => [processRow()],
      activeWorkerUnits: () => [],
      heldWorkerIds: () => [],
      liveBirthIds: () => [],
    });

    expect(input.dump_files).toEqual([dump]);
    await expect(writeFile(dump, "still present", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("is reachable through the shared operational probe registry", () => {
    expect(OPERATIONAL_PROBES.map((probe) => probe.id)).toContain("runtime.process-census");
  });
});
