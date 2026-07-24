import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  buildReasoningReplay,
  jaccardSimilarity,
  mapStatusToOutcome,
  parseWorkerStatusFromEnvelope,
} from "../src/reasoning/reasoning-replay.js";
import { recordReasoningWorker } from "../src/reasoning/worker-writer.js";

const TIMEOUT = 30_000;
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-reasoning-replay-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("reasoning replay", () => {
  test("returns the stable schema with empty results when no attempts exist", async () => {
    const store = await openStore();
    const report = await buildReasoningReplay(store, "rebuild ingest pipeline", {
      now: 1_700_000_000_000,
    });
    expect(report).toMatchObject({
      schema_version: "memory.reasoning_replay.v1",
      read_only: true,
      task: "rebuild ingest pipeline",
      total_workers: 0,
      results: [],
      gaps: [],
    });
    expect(report.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
  }, TIMEOUT);

  test("ranks attempts deterministically by similarity and returns top-K with the documented shape", async () => {
    const store = await openStore();
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 1,
      attemptNumber: 1,
      status: "done",
      summary: "rebuild ingest pipeline for markdown notes",
      touchedFiles: ["plugins/memory/src/ingest.ts"],
    });
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 2,
      attemptNumber: 1,
      status: "blocked",
      summary: "wire vector projection diagnostics",
      touchedFiles: ["plugins/memory/src/vector-search.ts"],
    });
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 3,
      attemptNumber: 1,
      status: "done",
      summary: "extend ingest pipeline with code symbols",
      touchedFiles: ["plugins/memory/src/extract-code.ts"],
    });

    const first = await buildReasoningReplay(store, "rebuild ingest pipeline", {
      limit: 2,
    });
    expect(first.results).toHaveLength(2);
    expect(first.results[0]?.worker_id).toBe(
      "worker:reddb-io/red-skills#1/1",
    );
    expect(first.results[1]?.worker_id).toBe(
      "worker:reddb-io/red-skills#3/1",
    );
    expect(first.results[0]?.similarity).toBeGreaterThan(first.results[1]?.similarity ?? 0);
    expect(first.results[1]?.similarity).toBeGreaterThan(0);
    expect(first.total_workers).toBe(3);
    for (const result of first.results) {
      expect(result).toEqual(
        expect.objectContaining({
          worker_id: expect.any(String),
          similarity: expect.any(Number),
          when: expect.any(String),
          summary: expect.any(String),
          outcome: expect.stringMatching(/^(done|blocked|no-sentinel|unknown)$/),
        }),
      );
      expect(result.similarity).toBeGreaterThanOrEqual(0);
      expect(result.similarity).toBeLessThanOrEqual(1);
      expect(() => new Date(result.when).toISOString()).not.toThrow();
    }
    expect(first.results[0]?.outcome).toBe("done");

    // Determinism: a second call yields the same ranking and similarities.
    const second = await buildReasoningReplay(store, "rebuild ingest pipeline", {
      limit: 2,
    });
    expect(second.results.map((r) => [r.worker_id, r.similarity])).toEqual(
      first.results.map((r) => [r.worker_id, r.similarity]),
    );
  }, TIMEOUT);

  test("attaches outcome derived from the attempt status", async () => {
    const store = await openStore();
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 10,
      attemptNumber: 1,
      status: "done",
      summary: "rebuild ingest pipeline",
      touchedFiles: [],
    });
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 11,
      attemptNumber: 1,
      status: "blocked",
      summary: "rebuild ingest pipeline diagnostics",
      touchedFiles: [],
    });

    const report = await buildReasoningReplay(store, "rebuild ingest pipeline", { limit: 5 });
    const byIssue = Object.fromEntries(
      report.results.map((r) => [r.worker_id, r.outcome]),
    );
    expect(byIssue["worker:reddb-io/red-skills#10/1"]).toBe("done");
    expect(byIssue["worker:reddb-io/red-skills#11/1"]).toBe("blocked");
  }, TIMEOUT);

  test("populates gaps from learning-debt repeated-failure patterns scoped to matched attempts", async () => {
    const store = await openStore();
    // Two blocked attempts on the same issue with the same error class → a
    // repeated-failure pattern without a durable lesson.
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 99,
      attemptNumber: 1,
      status: "blocked",
      summary: "vector projection diagnostics",
      errorClass: "ProjectionMissing",
      touchedFiles: ["plugins/memory/src/vector-search.ts"],
    });
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 99,
      attemptNumber: 2,
      status: "blocked",
      summary: "vector projection diagnostics retry",
      errorClass: "ProjectionMissing",
      touchedFiles: ["plugins/memory/src/vector-search.ts"],
    });

    const report = await buildReasoningReplay(store, "vector projection diagnostics", {
      limit: 5,
    });
    expect(report.results.length).toBeGreaterThan(0);
    expect(report.gaps.length).toBeGreaterThan(0);
    expect(report.gaps.some((gap) => gap.includes("issue:99"))).toBe(true);
  }, TIMEOUT);

  test("parseWorkerStatusFromEnvelope extracts data-attempt-status from AFK envelopes", () => {
    expect(parseWorkerStatusFromEnvelope(null)).toBeNull();
    expect(parseWorkerStatusFromEnvelope("")).toBeNull();
    expect(parseWorkerStatusFromEnvelope("plain comment")).toBeNull();
    expect(
      parseWorkerStatusFromEnvelope(
        '<details data-attempt-status="done"><summary>foo</summary>body</details>',
      ),
    ).toBe("done");
    expect(
      parseWorkerStatusFromEnvelope(
        '<details class="x" data-attempt-status="blocked"><summary>x</summary></details>',
      ),
    ).toBe("blocked");
  });

  test("mapStatusToOutcome bounds the outcome vocabulary", () => {
    expect(mapStatusToOutcome("done")).toBe("done");
    expect(mapStatusToOutcome("BLOCKED")).toBe("blocked");
    expect(mapStatusToOutcome("no-sentinel")).toBe("no-sentinel");
    expect(mapStatusToOutcome("retrying")).toBe("unknown");
    expect(mapStatusToOutcome(undefined)).toBe("unknown");
    expect(mapStatusToOutcome(null)).toBe("unknown");
  });

  test("jaccardSimilarity is symmetric and well-bounded", () => {
    expect(jaccardSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["c"])).toBe(0);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 5);
  });
});
