import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import type { MemoryConfig } from "./config.js";
import { resolveStoreUri } from "./config.js";
import { MemoryStore } from "./graph-store.js";
import { COLLECTIONS, type CollectionName } from "./schema.js";
import { applyTierVersioning } from "./vcs-versioned-collections.js";

const execFileAsync = promisify(execFile);
const LAST_COMMIT_KEY = "vcs:last-meaningful-commit";

export interface MemoryGraphCommitOptions {
  message?: string;
  author?: string;
  email?: string;
}

export interface MemoryGraphCommitResult {
  status: "committed" | "unchanged";
  committed: boolean;
  message: string;
  included: string[];
  skipped: string[];
  fingerprint: string;
  commit?: {
    hash: string;
    height: number;
    parents: string[];
  };
  previousCommit?: string;
}

interface LastCommitMarker {
  fingerprint: string;
  hash: string;
}

interface RedCommitEnvelope {
  ok: boolean;
  data?: {
    hash?: string;
    height?: number;
    parents?: string[];
  };
  error?: string;
}

export async function commitMemoryGraph(
  rootDir: string,
  config: MemoryConfig,
  opts: MemoryGraphCommitOptions = {},
): Promise<MemoryGraphCommitResult> {
  if (config.mode !== "graph") {
    throw new Error(
      `memory commit needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const message = opts.message ?? "memory graph checkpoint";
  const storeUri = resolveStoreUri(rootDir, config);
  const dbPath = fileURLToPath(storeUri);
  const store = await MemoryStore.open({ uri: storeUri });
  let included: string[] = [];
  let skipped: string[] = [];
  let fingerprint = "";
  let previous: LastCommitMarker | null = null;
  try {
    const versioning = await applyTierVersioning(store);
    included = versioning.versioned;
    skipped = versioning.skipped;
    fingerprint = await memoryGraphFingerprint(store, included as CollectionName[]);
    previous = parseLastCommitMarker(await store.kvGet<unknown>(LAST_COMMIT_KEY));
  } finally {
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
  const marker: LastCommitMarker = { fingerprint, hash: commit.hash };
  const after = await MemoryStore.open({ uri: storeUri });
  try {
    await after.kvPut(LAST_COMMIT_KEY, marker);
  } finally {
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

async function memoryGraphFingerprint(
  store: MemoryStore,
  included: readonly CollectionName[],
): Promise<string> {
  const surface: Record<string, unknown> = {};
  for (const collection of included) {
    surface[collection] = await readIncludedCollection(store, collection);
  }
  return createHash("sha256").update(stableStringify(surface)).digest("hex");
}

async function readIncludedCollection(
  store: MemoryStore,
  collection: CollectionName,
): Promise<unknown[]> {
  if (collection === COLLECTIONS.docs) {
    try {
      const { items } = await store.raw.documents.list(COLLECTIONS.docs, { limit: 100_000 });
      return stableRows(items);
    } catch {
      return [];
    }
  }

  const result = await store.raw.query(`SELECT * FROM ${collection}`);
  return stableRows(result.rows);
}

function stableRows(rows: unknown[]): unknown[] {
  return [...rows].sort((a, b) => stableStringify(a).localeCompare(stableStringify(b)));
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function parseLastCommitMarker(value: unknown): LastCommitMarker | null {
  let raw: unknown;
  try {
    raw = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const marker = raw as Record<string, unknown>;
  if (typeof marker.fingerprint !== "string" || typeof marker.hash !== "string") {
    return null;
  }
  return { fingerprint: marker.fingerprint, hash: marker.hash };
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

async function redVcsCommit(
  dbPath: string,
  message: string,
  opts: MemoryGraphCommitOptions,
): Promise<NonNullable<MemoryGraphCommitResult["commit"]>> {
  const args = ["vcs", "commit", "--path", dbPath, "--message", message, "--json"];
  if (opts.author) args.push("--author", opts.author);
  if (opts.email) args.push("--email", opts.email);

  const { stdout } = await execFileAsync(resolveRedBinary(), args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const envelope = JSON.parse(stdout) as RedCommitEnvelope;
  if (!envelope.ok || !envelope.data?.hash) {
    throw new Error(`red vcs commit failed${envelope.error ? `: ${envelope.error}` : ""}`);
  }
  return {
    hash: envelope.data.hash,
    height: Number(envelope.data.height ?? 0),
    parents: envelope.data.parents ?? [],
  };
}

function resolveRedBinary(): string {
  // REDDB_BIN is the canonical override (SDK ADR 0006) and the path the bundled
  // runtime bootstrap always sets (ADR 0029).
  const override = process.env.REDDB_BIN;
  if (override && existsSync(override)) return override;
  // Dev/test fallback: the SDK binary in node_modules.
  const bin = process.platform === "win32" ? "red.exe" : "red";
  const pluginRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const local = join(pluginRoot, "node_modules", "@reddb-io", "sdk", "bin", bin);
  if (existsSync(local)) return local;
  throw new Error(
    `red binary not found — set REDDB_BIN or install @reddb-io/sdk (looked at ${local})`,
  );
}
