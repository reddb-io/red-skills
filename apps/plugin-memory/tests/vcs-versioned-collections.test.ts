import { connect } from "@reddb-io/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { COLLECTIONS } from "../src/schema.js";
import {
  MEMORY_COLLECTION_VERSIONING,
  applyTierVersioning,
} from "../src/vcs-versioned-collections.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-vcs-"));
  roots.push(dir);
  return dir;
}

async function openStore(): Promise<{ store: MemoryStore; uri: string }> {
  const root = await tempRoot();
  const uri = `file://${join(root, "graph.rdb")}`;
  const store = await MemoryStore.open({ uri, project: "test" });
  stores.push(store);
  return { store, uri };
}

async function closeStore(store: MemoryStore): Promise<void> {
  const index = stores.indexOf(store);
  if (index >= 0) stores.splice(index, 1);
  await store.close();
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function collectionVersioned(uri: string, collection: string): Promise<boolean> {
  const db = await connect(uri);
  try {
    await db.query(`SELECT * FROM ${collection} AS OF SNAPSHOT 0`);
    return true;
  } catch (err) {
    const message = String((err as Error).message ?? err);
    if (message.includes("AS OF requires a versioned collection")) return false;
    throw err;
  } finally {
    await db.close();
  }
}

async function seedVersionedCollections(store: MemoryStore): Promise<void> {
  const first = await store.upsertNode({
    label: "versioned-node-a",
    node_type: "decision",
    properties: {
      title: "Versioned node A",
      content: "Fixture node for RedDB versioning probes.",
      confidence: "EXTRACTED",
    },
  });
  const second = await store.upsertNode({
    label: "versioned-node-b",
    node_type: "solution",
    properties: {
      title: "Versioned node B",
      content: "Second fixture node for edge versioning probes.",
      confidence: "EXTRACTED",
    },
  });
  await store.upsertEdge({
    label: "REFERENCES",
    from_rid: first,
    to_rid: second,
    properties: {
      confidence: "EXTRACTED",
      source: "test",
    },
  });
  await store.upsertDoc({
    path: "docs/versioned.md",
    title: "Versioned doc",
    body: "Fixture document for RedDB document versioning probes.",
    hash: "versioned-doc-hash",
    updated_at: Date.now(),
  });
}

describe("VCS versioned Memory collections (#105)", () => {
  test(
    "applies tier versioning and reports the actual RedDB store state",
    async () => {
      const { store, uri } = await openStore();
      await seedVersionedCollections(store);

      const report = await applyTierVersioning(store);

      const expectedVersioned = MEMORY_COLLECTION_VERSIONING.filter((c) =>
        c.tiers.some((tier) => tier === "durable" || tier === "reasoning"),
      ).map((c) => c.name);
      const expectedSkipped = MEMORY_COLLECTION_VERSIONING.filter((c) =>
        c.tiers.every((tier) => tier === "ephemeral"),
      ).map((c) => c.name);

      expect(report.versioned).toEqual(expectedVersioned);
      expect(report.skipped).toEqual(expectedSkipped);
      expect(report.skipped).toContain(COLLECTIONS.events);

      await closeStore(store);

      for (const collection of report.versioned) {
        expect(await collectionVersioned(uri, collection)).toBe(true);
      }
      for (const collection of report.skipped) {
        expect(await collectionVersioned(uri, collection)).toBe(false);
      }
    },
    TIMEOUT,
  );

  test(
    "is idempotent on an already-versioned store",
    async () => {
      const { store, uri } = await openStore();
      await seedVersionedCollections(store);

      const first = await applyTierVersioning(store);
      const second = await applyTierVersioning(store);

      expect(second).toEqual(first);
      await closeStore(store);

      for (const collection of second.versioned) {
        expect(await collectionVersioned(uri, collection)).toBe(true);
      }
      for (const collection of second.skipped) {
        expect(await collectionVersioned(uri, collection)).toBe(false);
      }
    },
    TIMEOUT,
  );
});
