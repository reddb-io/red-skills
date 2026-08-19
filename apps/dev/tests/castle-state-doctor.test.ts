import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeToonlLines } from "@reddb-io/toon";
import {
  CASTLE_VALIDATION_SCHEMA_ID,
  appendCastleHistoryRecord,
  createEnginePaths,
  writeCastleStateSnapshot,
} from "@reddb-io/worker/engine";
import { describe, expect, it } from "vitest";
import { auditCastleStateLane } from "../src/core/castle-state-doctor.js";

async function repo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "castle-state-doctor-"));
}

describe("auditCastleStateLane", () => {
  it("passes cleanly for hosts without AFK or castle history", async () => {
    const root = await repo();

    await expect(auditCastleStateLane(root)).resolves.toEqual({
      status: "pass",
      findings: [],
      checked: { castleLanePresent: false, legacyLanePresent: false },
    });
  });

  it("validates castle TOONL lanes and state snapshots read-only", async () => {
    const root = await repo();
    const paths = createEnginePaths(join(root, ".red"));

    await appendCastleHistoryRecord(paths.castleHistory, {
      ts: "2026-07-17T00:00:00.000Z",
      epoch: 1784246400,
      worker: "wA",
      issue: 1963,
      event: "done",
      duration_s: 12,
      runner: "codex",
    });
    await mkdir(paths.castleStateRoot, { recursive: true });
    await writeFile(
      paths.castleValidation,
      encodeToonlLines().push({
        schema: CASTLE_VALIDATION_SCHEMA_ID,
        name: "test:apps/dev",
        status: "passed",
        durationMs: 42,
      }),
      "utf8",
    );
    await writeCastleStateSnapshot(join(paths.castleStateRoot, "workers", "wA", "state.toon"), {
      kind: "worker",
      id: "wA",
      version: 1,
      updated_at: "2026-07-17T00:00:00.000Z",
      pid: 123,
    });
    await writeCastleStateSnapshot(join(paths.castleStateRoot, "supervisors", "sA", "state.toon"), {
      kind: "supervisor",
      id: "sA",
      version: 1,
      updated_at: "2026-07-17T00:00:00.000Z",
      pid: 456,
    });

    await expect(auditCastleStateLane(root)).resolves.toMatchObject({
      status: "pass",
      findings: [],
      checked: { castleLanePresent: true, legacyLanePresent: false },
    });
  });

  it("reports malformed castle TOONL and snapshot directories", async () => {
    const root = await repo();
    const paths = createEnginePaths(join(root, ".red"));
    await mkdir(join(paths.castleStateRoot, "workers", "wBroken"), { recursive: true });
    await mkdir(paths.castleStateRoot, { recursive: true });
    await writeFile(paths.castleHistory, "not toonl\n", "utf8");
    await writeFile(
      paths.castleValidation,
      encodeToonlLines().push({ schema: "wrong.schema", name: "gate", status: "passed" }),
      "utf8",
    );

    const report = await auditCastleStateLane(root);

    expect(report.status).toBe("error");
    expect(report.findings.map((finding) => finding.kind).sort()).toEqual([
      "castle-history-invalid",
      "castle-snapshot-invalid",
      "castle-validation-invalid",
    ]);
    expect(report.findings.map((finding) => finding.path)).toEqual(
      expect.arrayContaining([
        ".red/state/castle/history.toonl",
        ".red/state/castle/validation.toonl",
        ".red/state/castle/workers/wBroken/state.toon",
      ]),
    );
  });

  it("flags legacy AFK state residue only alongside a live castle lane", async () => {
    const root = await repo();
    await mkdir(join(root, ".red", "state", "afk"), { recursive: true });
    await writeFile(join(root, ".red", "state", "afk", "afk-supervisor.pid"), "123\n", "utf8");

    await expect(auditCastleStateLane(root)).resolves.toMatchObject({
      status: "pass",
      findings: [],
      checked: { castleLanePresent: false, legacyLanePresent: true },
    });

    await mkdir(join(root, ".red", "state", "castle"), { recursive: true });
    await writeFile(join(root, ".red", "state", "castle", "history.toonl"), "", "utf8");

    const report = await auditCastleStateLane(root);

    expect(report.status).toBe("warn");
    expect(report.findings).toEqual([
      {
        path: ".red/state/afk",
        kind: "legacy-afk-residue",
        verdict: "warn",
        reason: "legacy .red/state/afk contains state alongside the live red-castle state lane",
        canonicalFix: "run the dev durable path migration entrypoint during boot (`red-path-migration`)",
        fixGate: "delegate",
      },
    ]);
  });

  it("rejects live supervisor artifacts in the durable red-castle state lane", async () => {
    const root = await repo();
    const castle = join(root, ".red", "state", "castle");
    await mkdir(castle, { recursive: true });
    await writeFile(join(castle, "history.toonl"), "", "utf8");
    await writeFile(join(castle, "afk-supervisor.pid"), "123\n", "utf8");
    await writeFile(join(castle, "afk-supervisor.log.toonl"), "[0]{ts,msg}:\n", "utf8");
    await writeFile(join(castle, "monitor-log-cursors.json"), "{}", "utf8");

    const report = await auditCastleStateLane(root);

    expect(report.status).toBe("error");
    expect(report.findings.map((finding) => [finding.path, finding.kind])).toEqual([
      [".red/state/castle/afk-supervisor.log.toonl", "castle-live-artifact"],
      [".red/state/castle/afk-supervisor.pid", "castle-live-artifact"],
      [".red/state/castle/monitor-log-cursors.json", "castle-live-artifact"],
    ]);
  });
});
