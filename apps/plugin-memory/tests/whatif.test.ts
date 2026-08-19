import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { recordReasoningWorker } from "../src/reasoning/worker-writer.js";
import { buildWhatifReport, parseWhatifChange } from "../src/whatif.js";

const TIMEOUT = 30_000;
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-whatif-"));
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

describe("memory.whatif.v1", () => {
  test("returns the documented shape with zeros when no evidence is available", async () => {
    const store = await openStore();
    const report = await buildWhatifReport(
      store,
      [{ kind: "edit", symbol: "totallyUnknownSymbol", description: "edit totallyUnknownSymbol" }],
      { now: 1_700_000_000_000 },
    );
    expect(report).toMatchObject({
      schema_version: "memory.whatif.v1",
      read_only: true,
      affected: { files: [], symbols: [], tests: [] },
      historical_attempts: [],
      breakage_likelihood: 0,
      self_confidence: 0,
    });
    expect(report.generated_at).toBe(new Date(1_700_000_000_000).toISOString());
    expect(report.changes).toHaveLength(1);
    expect(report.changes[0]?.description).toBe("edit totallyUnknownSymbol");
  }, TIMEOUT);

  test("surfaces historical attempts and a non-zero breakage_likelihood when a similar blocked attempt exists", async () => {
    const store = await openStore();
    await recordReasoningWorker(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 172,
      attemptNumber: 1,
      status: "blocked",
      summary: "rename legacyHandler to handler — broke downstream callers",
      touchedFiles: ["plugins/memory/src/whatif.ts"],
    });
    const report = await buildWhatifReport(store, [
      {
        kind: "rename",
        symbol: "legacyHandler",
        with: "handler",
        description: "rename legacyHandler to handler",
      },
    ]);
    expect(report.historical_attempts.length).toBeGreaterThan(0);
    expect(report.historical_attempts[0]?.outcome).toBe("blocked");
    expect(report.breakage_likelihood).toBeGreaterThan(0);
    expect(report.self_confidence).toBeGreaterThan(0);
  }, TIMEOUT);

  test("breakage_likelihood and self_confidence stay bounded in [0, 1]", async () => {
    const store = await openStore();
    // Many blocked attempts on the same descriptor should still cap at 1.
    for (let i = 1; i <= 20; i++) {
      await recordReasoningWorker(store, {
        repository: "reddb-io/red-skills",
        issueNumber: 500 + i,
        attemptNumber: 1,
        status: "blocked",
        summary: `rename bigFanOut to small (attempt ${i})`,
        touchedFiles: [],
      });
    }
    const report = await buildWhatifReport(store, [
      {
        kind: "rename",
        symbol: "bigFanOut",
        with: "small",
        description: "rename bigFanOut to small",
      },
    ]);
    expect(report.breakage_likelihood).toBeGreaterThan(0);
    expect(report.breakage_likelihood).toBeLessThanOrEqual(1);
    expect(report.self_confidence).toBeGreaterThan(0);
    expect(report.self_confidence).toBeLessThanOrEqual(1);
  }, TIMEOUT);
});

describe("parseWhatifChange", () => {
  test("parses rename X to Y", () => {
    expect(parseWhatifChange("rename oldName to newName")).toMatchObject({
      kind: "rename",
      symbol: "oldName",
      with: "newName",
    });
  });

  test("parses delete file path", () => {
    expect(parseWhatifChange("delete src/foo.ts")).toMatchObject({
      kind: "delete",
      file: "src/foo.ts",
    });
  });

  test("parses edit file#symbol", () => {
    expect(parseWhatifChange("edit src/foo.ts#bar")).toMatchObject({
      kind: "edit",
      file: "src/foo.ts",
      symbol: "bar",
    });
  });

  test("defaults bare descriptors to edit", () => {
    const change = parseWhatifChange("doSomething");
    expect(change.kind).toBe("edit");
    expect(change.symbol).toBe("doSomething");
  });

  test("rejects empty input", () => {
    expect(() => parseWhatifChange("  ")).toThrow();
  });
});
