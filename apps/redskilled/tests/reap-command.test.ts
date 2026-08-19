import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import { runReap } from "../src/cli.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import type { RedskilledProcessCensusRow } from "../src/orphan-reaper.js";
import { resolveRedskilledPaths } from "../src/paths.js";

import { permitUnitDiscoveryForThisSuite } from "./support/test-host-isolation.js";

// The sweep is what this suite tests, so the sandbox default that refuses it
// would turn every assertion into "found nothing, expected nothing". Every
// verdict below rests on a process fixture this file builds, never on what
// the machine running it happens to hold.
permitUnitDiscoveryForThisSuite();


const roots: string[] = [];
const daemons: RedskilledDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function orphan(overrides: Partial<RedskilledProcessCensusRow> = {}): RedskilledProcessCensusRow {
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

describe("redskilled reap --report", () => {
  it("round-trips the process census over the protocol and signals nothing", async () => {
    const root = await mkdtemp(join(tmpdir(), "redskilled-reap-report-"));
    roots.push(root);
    const paths = resolveRedskilledPaths({
      env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
      runtimeDir: root,
    });
    const signalled: number[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      orphanReaperMs: 0,
      unitInventory: () => ["red-worker-acme-wHELD.service"],
      orphanCensus: () => [
        orphan(),
        orphan({ worker_id: undefined, born_at: undefined, pid: 5_000, pgid: 5_000, age_ms: 30 * 60_000 }),
      ],
      orphanDumpFiles: () => ["/repo/.red/tmp/workers/wLOST/3598/worktree/core.4242"],
      orphanKillGroup: async (pgid) => {
        signalled.push(pgid);
        return true;
      },
    });
    daemons.push(daemon);
    let output = "";

    await expect(runReap(["--report"], { paths, write: (text) => { output += text; } })).resolves.toBe(0);

    expect(decode(output)).toEqual({
      version: 1,
      mode: "report",
      census: {
        version: 1,
        active_worker_units: 1,
        daemon_held_workers: 1,
        stamped_orphans: 1,
        unstamped_suspects: 1,
        dump_files: 1,
      },
      actions: { adopted: 0, reaped: 0, suspects: 2 },
    });
    expect(signalled).toEqual([]);
  });
});
