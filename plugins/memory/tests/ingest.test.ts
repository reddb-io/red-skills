import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { graphRecall } from "../src/graph-recall.js";
import { MemoryStore } from "../src/graph-store.js";
import { ingestProject } from "../src/ingest.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_REPO = join(HERE, "fixtures/repo");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-ingest-"));
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

describe("ingestProject over a TS+MD fixture repo", () => {
  test(
    "indexes code symbols and markdown concepts into the graph",
    async () => {
      const store = await openStore();
      const report = await ingestProject(store, { cwd: FIXTURE_REPO });

      // 1 TS file + 1 MD file.
      expect(report.files).toBe(2);
      expect(report.docs).toBe(1);
      // file + 5 symbols, root concept + 3 heading concepts.
      expect(report.nodes).toBeGreaterThanOrEqual(6 + 4);

      const { nodes } = await store.stats();
      expect(nodes).toBe(report.nodes);
    },
    TIMEOUT,
  );

  test(
    "recall finds an ingested code symbol",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const hits = await graphRecall(store, "issueToken");
      const titles = hits.map((h) => h.label);
      expect(titles.some((l) => l.includes("issueToken"))).toBe(true);
    },
    TIMEOUT,
  );

  test(
    "recall finds an ingested markdown concept",
    async () => {
      const store = await openStore();
      await ingestProject(store, { cwd: FIXTURE_REPO });

      const hits = await graphRecall(store, "token rotation");
      expect(hits.some((h) => /rotation/i.test(h.label) || /rotation/i.test(h.excerpt))).toBe(
        true,
      );
    },
    TIMEOUT,
  );

  test(
    "re-ingesting the same tree is idempotent (dedupe by hash)",
    async () => {
      const store = await openStore();
      const first = await ingestProject(store, { cwd: FIXTURE_REPO });
      const before = await store.stats();
      await ingestProject(store, { cwd: FIXTURE_REPO });
      const after = await store.stats();

      expect(after.nodes).toBe(before.nodes);
      expect(after.nodes).toBe(first.nodes);
    },
    TIMEOUT,
  );
});
