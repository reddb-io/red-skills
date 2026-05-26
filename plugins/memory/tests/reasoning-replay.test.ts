import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  buildReasoningReplay,
  jaccardSimilarity,
} from "../src/reasoning/reasoning-replay.js";
import { recordReasoningAttempt } from "../src/reasoning/attempt-writer.js";

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
      total_attempts: 0,
      results: [],
      gaps: [],
    });
    expect(report.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
  }, TIMEOUT);

  test("ranks attempts deterministically by similarity and returns top-K with the documented shape", async () => {
    const store = await openStore();
    await recordReasoningAttempt(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 1,
      attemptNumber: 1,
      status: "done",
      summary: "rebuild ingest pipeline for markdown notes",
      touchedFiles: ["plugins/memory/src/ingest.ts"],
    });
    await recordReasoningAttempt(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 2,
      attemptNumber: 1,
      status: "blocked",
      summary: "wire vector projection diagnostics",
      touchedFiles: ["plugins/memory/src/vector-search.ts"],
    });
    await recordReasoningAttempt(store, {
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
    expect(first.results[0]?.attempt_id).toBe(
      "attempt:reddb-io/red-skills#1/1",
    );
    expect(first.results[1]?.attempt_id).toBe(
      "attempt:reddb-io/red-skills#3/1",
    );
    expect(first.results[0]?.similarity).toBeGreaterThan(first.results[1]?.similarity ?? 0);
    expect(first.results[1]?.similarity).toBeGreaterThan(0);
    expect(first.total_attempts).toBe(3);
    for (const result of first.results) {
      expect(result).toEqual(
        expect.objectContaining({
          attempt_id: expect.any(String),
          similarity: expect.any(Number),
          when: expect.any(String),
          summary: expect.any(String),
        }),
      );
      expect(result.similarity).toBeGreaterThanOrEqual(0);
      expect(result.similarity).toBeLessThanOrEqual(1);
      expect(() => new Date(result.when).toISOString()).not.toThrow();
    }

    // Determinism: a second call yields the same ranking and similarities.
    const second = await buildReasoningReplay(store, "rebuild ingest pipeline", {
      limit: 2,
    });
    expect(second.results.map((r) => [r.attempt_id, r.similarity])).toEqual(
      first.results.map((r) => [r.attempt_id, r.similarity]),
    );
  }, TIMEOUT);

  test("jaccardSimilarity is symmetric and well-bounded", () => {
    expect(jaccardSimilarity(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["b", "a"])).toBe(1);
    expect(jaccardSimilarity(["a", "b"], ["c"])).toBe(0);
    expect(jaccardSimilarity([], ["a"])).toBe(0);
    expect(jaccardSimilarity(["a", "b", "c"], ["b", "c", "d"])).toBeCloseTo(0.5, 5);
  });
});
