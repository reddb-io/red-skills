import { MemoryStore } from "./graph-store.js";
import { COLLECTIONS, type CollectionName, type Tier } from "./schema.js";

export interface MemoryCollectionVersioning {
  name: CollectionName;
  model: "graph" | "document" | "kv" | "event-log";
  tiers: readonly Tier[];
}

export interface TierVersioningReport {
  versioned: string[];
  skipped: string[];
}

export const MEMORY_COLLECTION_VERSIONING: readonly MemoryCollectionVersioning[] = [
  { name: COLLECTIONS.nodes, model: "graph", tiers: ["durable", "reasoning"] },
  { name: COLLECTIONS.edges, model: "graph", tiers: ["durable", "reasoning"] },
  { name: COLLECTIONS.docs, model: "document", tiers: ["durable"] },
  { name: COLLECTIONS.events, model: "event-log", tiers: ["ephemeral"] },
  { name: COLLECTIONS.kv, model: "kv", tiers: ["ephemeral"] },
] as const;

export async function applyTierVersioning(
  memoryStore: MemoryStore,
): Promise<TierVersioningReport> {
  const versioned: string[] = [];
  const skipped: string[] = [];

  for (const collection of MEMORY_COLLECTION_VERSIONING) {
    await ensureCollection(memoryStore, collection);

    if (shouldVersion(collection)) {
      if (!(await collectionIsVersioned(memoryStore, collection.name))) {
        await setCollectionVersioned(memoryStore, collection.name, true);
      }
      if (!(await collectionIsVersioned(memoryStore, collection.name))) {
        throw new Error(`collection ${collection.name} did not become versioned`);
      }
      versioned.push(collection.name);
      continue;
    }

    if (await collectionIsVersioned(memoryStore, collection.name)) {
      await setCollectionVersioned(memoryStore, collection.name, false);
    }
    if (await collectionIsVersioned(memoryStore, collection.name)) {
      throw new Error(`collection ${collection.name} should not be versioned`);
    }
    skipped.push(collection.name);
  }

  return { versioned, skipped };
}

function shouldVersion(collection: MemoryCollectionVersioning): boolean {
  return collection.tiers.some((tier) => tier === "durable" || tier === "reasoning");
}

async function ensureCollection(
  memoryStore: MemoryStore,
  collection: MemoryCollectionVersioning,
): Promise<void> {
  switch (collection.model) {
    case "graph":
      await memoryStore.raw.execute(`CREATE GRAPH IF NOT EXISTS ${collection.name}`);
      return;
    case "document":
      await memoryStore.raw.execute(`CREATE DOCUMENT IF NOT EXISTS ${collection.name}`);
      return;
    case "kv":
      await memoryStore.raw.execute(`CREATE KV IF NOT EXISTS ${collection.name}`);
      return;
    case "event-log":
      await memoryStore.raw.execute(
        `CREATE TABLE IF NOT EXISTS ${collection.name} (id TEXT, occurred_at TEXT, event_kind TEXT, source JSON, actor JSON, scope JSON, subject JSON, payload JSON, provenance JSON) APPEND ONLY`,
      );
      return;
  }
}

async function collectionIsVersioned(
  memoryStore: MemoryStore,
  collection: CollectionName,
): Promise<boolean> {
  try {
    await memoryStore.raw.query(`SELECT * FROM ${collection} AS OF SNAPSHOT 0`);
    return true;
  } catch (err) {
    const message = String((err as Error).message ?? err);
    if (message.includes("AS OF requires a versioned collection")) return false;
    throw err;
  }
}

async function setCollectionVersioned(
  memoryStore: MemoryStore,
  collection: CollectionName,
  versioned: boolean,
): Promise<void> {
  await memoryStore.raw.execute(`ALTER COLLECTION ${collection} SET VERSIONED = ${versioned}`);
}
