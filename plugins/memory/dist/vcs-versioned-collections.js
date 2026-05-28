import { COLLECTIONS } from "./schema.js";
export const MEMORY_COLLECTION_VERSIONING = [
    { name: COLLECTIONS.nodes, model: "graph", tiers: ["durable", "reasoning"] },
    { name: COLLECTIONS.edges, model: "graph", tiers: ["durable", "reasoning"] },
    { name: COLLECTIONS.docs, model: "document", tiers: ["durable"] },
    { name: COLLECTIONS.events, model: "event-log", tiers: ["ephemeral"] },
    { name: COLLECTIONS.kv, model: "kv", tiers: ["ephemeral"] },
];
export async function applyTierVersioning(memoryStore) {
    const versioned = [];
    const skipped = [];
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
function shouldVersion(collection) {
    return collection.tiers.some((tier) => tier === "durable" || tier === "reasoning");
}
async function ensureCollection(memoryStore, collection) {
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
            await memoryStore.raw.execute(`CREATE TABLE IF NOT EXISTS ${collection.name} (id TEXT, occurred_at TEXT, event_kind TEXT, source JSON, actor JSON, scope JSON, subject JSON, payload JSON, provenance JSON) APPEND ONLY`);
            return;
    }
}
async function collectionIsVersioned(memoryStore, collection) {
    try {
        await memoryStore.raw.query(`SELECT * FROM ${collection} AS OF SNAPSHOT 0`);
        return true;
    }
    catch (err) {
        const message = String(err.message ?? err);
        if (message.includes("AS OF requires a versioned collection"))
            return false;
        throw err;
    }
}
async function setCollectionVersioned(memoryStore, collection, versioned) {
    await memoryStore.raw.execute(`ALTER COLLECTION ${collection} SET VERSIONED = ${versioned}`);
}
