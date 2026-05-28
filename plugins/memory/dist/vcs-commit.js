import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveStoreUri } from "./config.js";
import { MemoryStore } from "./graph-store.js";
import { COLLECTIONS } from "./schema.js";
import { applyTierVersioning } from "./vcs-versioned-collections.js";
const execFileAsync = promisify(execFile);
const LAST_COMMIT_KEY = "vcs:last-meaningful-commit";
export async function commitMemoryGraph(rootDir, config, opts = {}) {
    if (config.mode !== "graph") {
        throw new Error(`memory commit needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`);
    }
    const message = opts.message ?? "memory graph checkpoint";
    const storeUri = resolveStoreUri(rootDir, config);
    const dbPath = fileURLToPath(storeUri);
    const store = await MemoryStore.open({ uri: storeUri });
    let included = [];
    let skipped = [];
    let fingerprint = "";
    let previous = null;
    try {
        const versioning = await applyTierVersioning(store);
        included = versioning.versioned;
        skipped = versioning.skipped;
        fingerprint = await memoryGraphFingerprint(store, included);
        previous = parseLastCommitMarker(await store.kvGet(LAST_COMMIT_KEY));
    }
    finally {
        await store.close();
    }
    if (previous?.fingerprint === fingerprint) {
        return {
            status: "unchanged",
            committed: false,
            message,
            included,
            skipped,
            fingerprint,
            previousCommit: previous.hash,
        };
    }
    const commit = await redVcsCommit(dbPath, message, opts);
    const marker = { fingerprint, hash: commit.hash };
    const after = await MemoryStore.open({ uri: storeUri });
    try {
        await after.kvPut(LAST_COMMIT_KEY, marker);
    }
    finally {
        await after.close();
    }
    return {
        status: "committed",
        committed: true,
        message,
        included,
        skipped,
        fingerprint,
        commit,
    };
}
async function memoryGraphFingerprint(store, included) {
    const surface = {};
    for (const collection of included) {
        surface[collection] = await readIncludedCollection(store, collection);
    }
    return createHash("sha256").update(stableStringify(surface)).digest("hex");
}
async function readIncludedCollection(store, collection) {
    if (collection === COLLECTIONS.docs) {
        try {
            const { items } = await store.raw.documents.list(COLLECTIONS.docs, { limit: 100_000 });
            return stableRows(items);
        }
        catch {
            return [];
        }
    }
    const result = await store.raw.query(`SELECT * FROM ${collection}`);
    return stableRows(result.rows);
}
function stableRows(rows) {
    return [...rows].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}
function stableStringify(value) {
    return JSON.stringify(sortValue(value));
}
function parseLastCommitMarker(value) {
    let raw;
    try {
        raw = typeof value === "string" ? JSON.parse(value) : value;
    }
    catch {
        return null;
    }
    if (!raw || typeof raw !== "object")
        return null;
    const marker = raw;
    if (typeof marker.fingerprint !== "string" || typeof marker.hash !== "string") {
        return null;
    }
    return { fingerprint: marker.fingerprint, hash: marker.hash };
}
function sortValue(value) {
    if (Array.isArray(value))
        return value.map(sortValue);
    if (value && typeof value === "object") {
        const sorted = {};
        for (const key of Object.keys(value).sort()) {
            sorted[key] = sortValue(value[key]);
        }
        return sorted;
    }
    return value;
}
async function redVcsCommit(dbPath, message, opts) {
    const args = ["vcs", "commit", "--path", dbPath, "--message", message, "--json"];
    if (opts.author)
        args.push("--author", opts.author);
    if (opts.email)
        args.push("--email", opts.email);
    const { stdout } = await execFileAsync(resolveRedBinary(), args, {
        encoding: "utf8",
        maxBuffer: 1024 * 1024,
    });
    const envelope = JSON.parse(stdout);
    if (!envelope.ok || !envelope.data?.hash) {
        throw new Error(`red vcs commit failed${envelope.error ? `: ${envelope.error}` : ""}`);
    }
    return {
        hash: envelope.data.hash,
        height: Number(envelope.data.height ?? 0),
        parents: envelope.data.parents ?? [],
    };
}
function resolveRedBinary() {
    const bin = process.platform === "win32" ? "red.exe" : "red";
    const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
    const local = join(pluginRoot, "node_modules", "@reddb-io", "sdk", "bin", bin);
    if (existsSync(local))
        return local;
    const sdkEntry = fileURLToPath(import.meta.resolve("@reddb-io/sdk"));
    return join(dirname(dirname(sdkEntry)), "bin", bin);
}
