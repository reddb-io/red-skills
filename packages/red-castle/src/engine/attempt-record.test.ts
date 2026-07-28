// attempt-record.test.ts — the pinned contract for the resident-owned attempt
// record (ADR 0128, issue #2703).
//
// The fixture under `.red/contracts/fixtures/attempt-record/` is the schema:
// the writer must reproduce its bytes, the fold must reproduce its record, and
// every invalid entry beside it must be rejected before the lane is touched.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decode } from "@reddb-io/toon";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CASTLE_ATTEMPT_REQUIRED_FIELDS,
  CastleAttemptValidationError,
  castleAttemptId,
  createCastleAttemptRecorder,
  foldCastleAttemptRecords,
  readCastleAttemptEntries,
  readCastleAttemptRecords,
  validateCastleAttemptEntry,
  type CastleAttemptEventFields,
  type CastleAttemptLog,
} from "./attempt-record.js";
import {
  CASTLE_ATTEMPT_SCHEMA_ID,
  type CastleAttemptEntry,
} from "./contracts/index.js";
import { createEnginePaths } from "./paths.js";

const FIXTURE_ROOT = resolve(
  import.meta.dirname,
  "../../../..",
  ".red/contracts/fixtures/attempt-record",
);
const PINNED_LANE = join(FIXTURE_ROOT, "valid/attempt.toonl");
const PINNED_RECORD = join(FIXTURE_ROOT, "valid/attempt.record.toon");

const IDENTITY = { worker_id: "wP1FZ", issue: 2703, try: 1 } as const;

/** The narrative the resident writes, event by event — the fixture's script. */
const NARRATIVE: readonly [string, CastleAttemptEventFields][] = [
  [
    "attempt.claimed",
    {
      at: "2026-07-28T15:00:00.000Z",
      claim: { state: "claimed", by: "resident" },
    },
  ],
  [
    "attempt.routed",
    {
      at: "2026-07-28T15:00:01.000Z",
      routing: {
        runner: "claude",
        tier: "complex",
        model: "claude-opus-5",
        effort: "medium",
      },
    },
  ],
  [
    "attempt.progressed",
    { at: "2026-07-28T15:04:00.000Z", note: "iteration 1", payload: { tools: 12 } },
  ],
  [
    "attempt.committed",
    {
      at: "2026-07-28T15:12:00.000Z",
      branch: "afk/2703-attempt-record",
      commit: "1f2e3d4",
    },
  ],
  ["attempt.pr-opened", { at: "2026-07-28T15:14:00.000Z", pr: 2710 }],
  [
    "attempt.gated",
    {
      at: "2026-07-28T15:19:00.000Z",
      gate: { name: "test", status: "passed", summary: "412 passed" },
    },
  ],
  [
    "attempt.landing",
    {
      at: "2026-07-28T15:21:00.000Z",
      landing: { step: "merge", status: "done", detail: "squash" },
    },
  ],
  [
    "attempt.artifact",
    {
      at: "2026-07-28T15:21:30.000Z",
      artifact: {
        kind: "worktree",
        path: ".red/tmp/workers/wP1FZ/2703/worktree",
        reclaimable: true,
        reclaim_after: "2026-07-29T15:21:30.000Z",
        reason: "landed",
      },
    },
  ],
  [
    "attempt.closed",
    {
      at: "2026-07-28T15:21:40.000Z",
      claim: { state: "conceded", by: "resident", reason: "landed" },
      outcome: { kind: "done", detail: "merged as 9a8b7c6" },
      resources: { wall_clock_s: 1300, peak_rss_mb: 812, cost_usd: 1.42 },
    },
  ],
];

async function replayNarrative(log: CastleAttemptLog): Promise<void> {
  for (const [event, fields] of NARRATIVE) {
    const result = await log.record(event, fields);
    expect(result.ok, `${event} should append`).toBe(true);
  }
}

describe("resident-owned attempt record", () => {
  let redRoot: string;

  beforeEach(() => {
    redRoot = join(
      tmpdir(),
      `castle-attempt-record-${process.pid}-${Math.random().toString(36).slice(2)}`,
      ".red",
    );
  });

  afterEach(async () => {
    await rm(resolve(redRoot, ".."), { recursive: true, force: true });
  });

  it("lands the lane under state/castle, never under tmp", () => {
    const paths = createEnginePaths(redRoot);
    expect(paths.castleAttempts).toBe(
      join(redRoot, "state", "castle", "attempts.toonl"),
    );
    expect(paths.castleAttempts.includes(`${join(redRoot, "tmp")}`)).toBe(false);
  });

  it("writes exactly the bytes the pinned fixture defines", async () => {
    const recorder = createCastleAttemptRecorder(createEnginePaths(redRoot));
    await replayNarrative(recorder.attempt(IDENTITY));

    expect(await readFile(recorder.path, "utf8")).toBe(
      readFileSync(PINNED_LANE, "utf8"),
    );
  });

  it("folds the pinned lane into the pinned attempt record", async () => {
    const folded = await readCastleAttemptRecords(PINNED_LANE);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toEqual(decode(readFileSync(PINNED_RECORD, "utf8")));
    expect(folded[0]!.attempt_id).toBe(castleAttemptId(IDENTITY));
  });

  it("rejects an entry missing any required field, before touching the lane", async () => {
    const paths = createEnginePaths(redRoot);
    const recorder = createCastleAttemptRecorder(paths);
    const complete = (await readCastleAttemptEntries(PINNED_LANE))[0]!;

    for (const field of CASTLE_ATTEMPT_REQUIRED_FIELDS) {
      const incomplete = { ...complete };
      delete (incomplete as Record<string, unknown>)[field];
      expect(
        () => validateCastleAttemptEntry(incomplete as CastleAttemptEntry),
        `missing ${field} must be rejected`,
      ).toThrow(CastleAttemptValidationError);
    }

    // The writer degrades on the same rejection rather than throwing, and the
    // lane stays untouched.
    const result = await recorder
      .attempt(IDENTITY)
      .record("attempt.progressed", { at: "" });
    expect(result.ok).toBe(false);
    expect(result.diagnostic?.reason).toBe("validation");
    expect(existsSync(paths.castleAttempts)).toBe(false);
  });

  it("rejects every invalid entry the fixture pins", () => {
    for (const name of [
      "worker-written",
      "unknown-field",
      "attempt-id-mismatch",
    ]) {
      const entry = decode(
        readFileSync(join(FIXTURE_ROOT, `invalid/${name}.toon`), "utf8"),
      ) as unknown as CastleAttemptEntry;
      expect(
        () => validateCastleAttemptEntry(entry),
        `${name} must be rejected`,
      ).toThrow(CastleAttemptValidationError);
    }
  });

  it("keeps the record of an attempt whose worker was killed mid-flight", async () => {
    const paths = createEnginePaths(redRoot);
    const recorder = createCastleAttemptRecorder(paths);
    const log = recorder.attempt(IDENTITY);

    // A real worker process, killed with no chance to report on itself.
    const worker = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const exited = new Promise<void>((done) => worker.once("exit", () => done()));

    await log.record("attempt.claimed", {
      at: "2026-07-28T16:00:00.000Z",
      claim: { state: "claimed", by: "resident" },
    });
    await log.record("attempt.routed", {
      at: "2026-07-28T16:00:01.000Z",
      routing: { runner: "claude", tier: "complex" },
    });
    await log.record("attempt.committed", {
      at: "2026-07-28T16:10:00.000Z",
      branch: "afk/2703-attempt-record",
      commit: "deadbee",
    });
    await log.record("attempt.pr-opened", {
      at: "2026-07-28T16:11:00.000Z",
      pr: 2710,
    });

    worker.kill("SIGKILL");
    await exited;
    expect(worker.killed).toBe(true);

    // The resident outlives the worker and closes the narrative itself.
    await log.record("attempt.closed", {
      at: "2026-07-28T16:11:05.000Z",
      outcome: { kind: "killed", detail: "SIGKILL, worker gone" },
      resources: { wall_clock_s: 665 },
      artifact: {
        kind: "pull-request",
        ref: "2710",
        reclaimable: false,
        reason: "open PR carries complete work",
      },
    });

    const record = await log.read();
    expect(record).toBeDefined();
    expect(record!.branch).toBe("afk/2703-attempt-record");
    expect(record!.commits).toEqual(["deadbee"]);
    expect(record!.pr).toBe(2710);
    expect(record!.routing).toEqual({ runner: "claude", tier: "complex" });
    expect(record!.outcome).toEqual({
      kind: "killed",
      detail: "SIGKILL, worker gone",
    });
    expect(record!.artifacts[0]?.reclaimable).toBe(false);
    expect(record!.closed).toBe(true);
    expect(record!.events.map((entry) => entry.event)).toEqual([
      "attempt.claimed",
      "attempt.routed",
      "attempt.committed",
      "attempt.pr-opened",
      "attempt.closed",
    ]);
  });

  it("surfaces an unwritable lane as a diagnostic, leaving the attempt running", async () => {
    const paths = createEnginePaths(redRoot);
    // A directory where the lane file belongs: every append fails, for any uid.
    await mkdir(paths.castleAttempts, { recursive: true });

    const seen: string[] = [];
    const recorder = createCastleAttemptRecorder(paths, {
      clock: () => "2026-07-28T17:00:00.000Z",
      onDiagnostic: (diagnostic) => seen.push(diagnostic.reason),
    });
    const log = recorder.attempt(IDENTITY);

    // The attempt's own control flow: it must reach the end regardless.
    const steps: string[] = [];
    for (const [event, fields] of NARRATIVE) {
      const result = await log.record(event, fields);
      expect(result.ok).toBe(false);
      steps.push(event);
    }

    expect(steps).toEqual(NARRATIVE.map(([event]) => event));
    expect(seen).toEqual(NARRATIVE.map(() => "write"));
    expect(recorder.diagnostics()).toHaveLength(NARRATIVE.length);
    expect(recorder.diagnostics()[0]).toMatchObject({
      at: "2026-07-28T17:00:00.000Z",
      reason: "write",
      attempt_id: "wP1FZ:2703:1",
      event: "attempt.claimed",
    });
  });

  it("is append-only: a later attempt never rewrites a prior attempt's record", async () => {
    const paths = createEnginePaths(redRoot);
    const recorder = createCastleAttemptRecorder(paths);
    const first = recorder.attempt(IDENTITY);
    const second = recorder.attempt({ ...IDENTITY, try: 2 });

    const snapshots: string[] = [];
    const appends: [CastleAttemptLog, string, CastleAttemptEventFields][] = [
      [first, "attempt.claimed", { at: "2026-07-28T18:00:00.000Z" }],
      [first, "attempt.committed", { at: "2026-07-28T18:05:00.000Z", commit: "aaa1111" }],
      [second, "attempt.claimed", { at: "2026-07-28T18:06:00.000Z" }],
      [
        first,
        "attempt.closed",
        { at: "2026-07-28T18:07:00.000Z", outcome: { kind: "blocked" } },
      ],
      [second, "attempt.committed", { at: "2026-07-28T18:09:00.000Z", commit: "bbb2222" }],
    ];

    for (const [log, event, fields] of appends) {
      expect((await log.record(event, fields)).ok).toBe(true);
      snapshots.push(await readFile(paths.castleAttempts, "utf8"));
    }

    // Every earlier state of the lane is a strict PREFIX of every later one —
    // the only shape an in-place rewrite cannot survive.
    for (let index = 1; index < snapshots.length; index += 1) {
      expect(snapshots[index]!.startsWith(snapshots[index - 1]!)).toBe(true);
      expect(snapshots[index]!.length).toBeGreaterThan(
        snapshots[index - 1]!.length,
      );
    }

    const records = await recorder.read();
    expect(records.map((record) => record.attempt_id)).toEqual([
      "wP1FZ:2703:1",
      "wP1FZ:2703:2",
    ]);
    expect(records[0]!.commits).toEqual(["aaa1111"]);
    expect(records[0]!.outcome).toEqual({ kind: "blocked" });
    expect(records[1]!.commits).toEqual(["bbb2222"]);
    expect(records[1]!.closed).toBe(false);
  });

  it("reads every complete entry when the lane's tail is torn by a kill", async () => {
    const paths = createEnginePaths(redRoot);
    const recorder = createCastleAttemptRecorder(paths);
    await replayNarrative(recorder.attempt(IDENTITY));

    const whole = await readFile(paths.castleAttempts, "utf8");
    await writeFile(paths.castleAttempts, `${whole}[]{schema,attempt_`, "utf8");

    const records = await readCastleAttemptRecords(paths.castleAttempts);
    expect(records).toHaveLength(1);
    expect(records[0]!.events).toHaveLength(NARRATIVE.length);
    expect(records[0]!.pr).toBe(2710);
  });

  it("folds a ticket's attempts and a worker's attempts from the one lane", () => {
    const entry = (
      worker_id: string,
      issue: number,
      tryNumber: number,
    ): CastleAttemptEntry => ({
      schema: CASTLE_ATTEMPT_SCHEMA_ID,
      attempt_id: castleAttemptId({ worker_id, issue, try: tryNumber }),
      worker_id,
      issue,
      try: tryNumber,
      at: "2026-07-28T19:00:00.000Z",
      event: "attempt.claimed",
      writer: "resident",
    });

    const records = foldCastleAttemptRecords([
      entry("wAAA1", 2703, 1),
      entry("wBBB2", 2703, 2),
      entry("wAAA1", 2704, 1),
    ]);

    expect(records.filter((record) => record.issue === 2703)).toHaveLength(2);
    expect(
      records.filter((record) => record.worker_id === "wAAA1"),
    ).toHaveLength(2);
  });
});
