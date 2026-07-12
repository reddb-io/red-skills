import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect, type RedDB } from "@reddb-io/sdk";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "./config.js";

export const RSP_ELISION_COLLECTION = "rsp_elisions_v1";

export { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS };

export type RspLossLevel = "lossless" | "brief" | "terse" | (string & {});

export interface RspLossMeta {
  level: RspLossLevel;
  bytes_elided: number;
}

export interface RspMintMeta {
  command: string;
  loss: RspLossMeta;
}

export interface RspElisionRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original: Buffer;
  command: string;
  created_at: string;
  loss: RspLossMeta;
}

export interface RspExpiredHandle {
  status: "expired";
  expired_at: string;
  command: string;
  original?: undefined;
}

export interface RspStoreStats {
  records: number;
  bytes: number;
  oldest: string | null;
  budget: number;
}

export interface RspElisionStoreOptions {
  uri: string;
  ttlDays?: number;
  byteBudget?: number;
  now?: () => Date;
  allowResidentOpen?: boolean;
}

interface StoredRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original: string;
  original_encoding: "base64";
  original_bytes: number;
  command: string;
  created_at: string;
  expires_at: string;
  loss: RspLossMeta;
}

interface IndexEntry {
  handle: `el:${string}`;
  key: string;
  bytes: number;
  command: string;
  created_at: string;
  expires_at: string;
}

interface IndexDocument {
  version: 1;
  records: IndexEntry[];
}

interface StoreDocument {
  version: 1;
  records: Record<string, StoredRecord>;
  tombstones: Record<string, RspExpiredHandle>;
  index: IndexDocument;
}

export class RspElisionStore {
  private document!: StoreDocument;
  private db?: RedDB;
  private readonly path: string;

  private constructor(path: string, private readonly opts: Omit<RspElisionStoreOptions, "ttlDays" | "byteBudget"> & {
    uri: string;
    now: () => Date;
    ttlDays: number;
    byteBudget: number;
  }) {
    this.path = path;
  }

  static async open(opts: RspElisionStoreOptions): Promise<RspElisionStore> {
    if (process.env.RSP_FAIL_IF_STORE_OPEN === "1" && !opts.allowResidentOpen) {
      throw new Error("RSP_FAIL_IF_STORE_OPEN blocked store open");
    }
    const requestedPath = fileStorePath(opts.uri);
    const path = await writableStorePath(requestedPath);
    const store = new RspElisionStore(path, {
      uri: opts.uri,
      ttlDays: positiveNumber(opts.ttlDays, DEFAULT_RSP_TTL_DAYS),
      byteBudget: positiveNumber(opts.byteBudget, DEFAULT_RSP_BYTE_BUDGET),
      now: opts.now ?? (() => new Date()),
    });
    if (usesEmbeddedRedDb(path)) {
      await ensureReddbBinaryFromWarmCache();
      store.db = await connect(`file://${path}`);
      await store.ensureRedDbStore();
    } else {
      store.document = await readStoreDocument(store.path);
    }
    return store;
  }

  async close(): Promise<void> {
    await this.db?.close();
  }

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    if (this.db) return await this.mintRedDb(original, meta);
    const bytes = Buffer.from(original);
    const now = this.opts.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const handle = contentHandle(bytes, meta);
    const key = recordKey(handle);

    const record: StoredRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle,
      original: bytes.toString("base64"),
      original_encoding: "base64",
      original_bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      loss: meta.loss,
    };

    delete this.document.tombstones[tombstoneKey(handle)];
    this.document.records[key] = record;
    this.upsertIndex({
      handle,
      key,
      bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    this.prune();
    await this.flush();
    return handle;
  }

  async get(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    if (this.db) return await this.getRedDb(handle);
    if (!isHandle(handle)) return null;
    const tombstone = this.tombstone(handle);
    if (tombstone) return tombstone;

    const raw = this.document.records[recordKey(handle)];
    if (!isStoredRecord(raw)) return null;

    if (Date.parse(raw.expires_at) <= this.opts.now().getTime()) {
      const expired = { status: "expired" as const, expired_at: raw.expires_at, command: raw.command };
      this.expireEntry({
        handle: raw.handle,
        key: recordKey(raw.handle),
        bytes: raw.original_bytes,
        command: raw.command,
        created_at: raw.created_at,
        expires_at: raw.expires_at,
      }, raw.expires_at);
      await this.flush();
      return expired;
    }

    const original = this.readOriginal(raw);
    if (!original) return null;

    return {
      collection: RSP_ELISION_COLLECTION,
      handle: raw.handle,
      original,
      command: raw.command,
      created_at: raw.created_at,
      loss: raw.loss,
    };
  }

  async stats(): Promise<RspStoreStats> {
    if (this.db) return await this.statsRedDb();
    this.prune();
    await this.flush();
    const index = this.readIndex();
    const records = index.records;
    return {
      records: records.length,
      bytes: records.reduce((sum, entry) => sum + entry.bytes, 0),
      oldest: records.reduce<string | null>((oldest, entry) => {
        if (oldest == null) return entry.created_at;
        return entry.created_at < oldest ? entry.created_at : oldest;
      }, null),
      budget: this.opts.byteBudget,
    };
  }

  private readIndex(): IndexDocument {
    return this.document.index;
  }

  private writeIndex(index: IndexDocument): void {
    this.document.index = index;
  }

  private upsertIndex(entry: IndexEntry): void {
    const index = this.readIndex();
    const withoutExisting = index.records.filter((record) => record.handle !== entry.handle);
    withoutExisting.push(entry);
    this.writeIndex({ version: 1, records: withoutExisting });
  }

  private prune(): void {
    const nowMs = this.opts.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const index = this.readIndex();
    const live: IndexEntry[] = [];

    for (const entry of index.records) {
      if (Date.parse(entry.expires_at) <= nowMs) {
        this.expireEntry(entry, entry.expires_at);
      } else {
        live.push(entry);
      }
    }

    let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      bytes -= evicted.bytes;
      this.expireEntry(evicted, nowIso);
    }

    this.writeIndex({ version: 1, records: live });
  }

  private expireEntry(entry: IndexEntry, expiredAt: string): void {
    delete this.document.records[entry.key];
    this.document.tombstones[tombstoneKey(entry.handle)] = {
      status: "expired",
      expired_at: expiredAt,
      command: entry.command,
    };
  }

  private tombstone(handle: `el:${string}`): RspExpiredHandle | null {
    const raw = this.document.tombstones[tombstoneKey(handle)];
    return isExpiredHandle(raw) ? raw : null;
  }

  private readOriginal(record: StoredRecord): Buffer | null {
    if (record.original) return Buffer.from(record.original, "base64");
    return null;
  }

  private async flush(): Promise<void> {
    await writeStoreDocument(this.path, this.document);
  }

  private kv() {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    return this.db.kv(RSP_ELISION_COLLECTION);
  }

  /**
   * The SDK's kv().get hands back the stored value as a JSON string rather
   * than a parsed object. Normalize on read; main never noticed because the
   * legacy-store redirect kept elisions off the RedDB path entirely.
   */
  private async kvGet(key: string): Promise<unknown> {
    const raw = await this.kv().get(key);
    if (typeof raw !== "string") return raw;
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return raw;
    }
  }

  private async ensureRedDbStore(): Promise<void> {
    const index = await this.readRedDbIndex();
    await this.writeRedDbIndex(index);
  }

  private async mintRedDb(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const bytes = Buffer.from(original);
    const now = this.opts.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const handle = contentHandle(bytes, meta);
    const key = recordKey(handle);
    const record: StoredRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle,
      original: bytes.toString("base64"),
      original_encoding: "base64",
      original_bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      loss: meta.loss,
    };
    await this.kv().delete(tombstoneKey(handle));
    await this.kv().put(key, record);
    const index = await this.readRedDbIndex();
    const withoutExisting = index.records.filter((entry) => entry.handle !== handle);
    withoutExisting.push({ handle, key, bytes: bytes.length, command: meta.command, created_at: createdAt, expires_at: expiresAt });
    await this.pruneRedDb({ version: 1, records: withoutExisting });
    await this.assertRedDbMintPersisted(handle, bytes.length);
    return handle;
  }

  private async getRedDb(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    if (!isHandle(handle)) return null;
    const tombstone = await this.kvGet(tombstoneKey(handle));
    if (isExpiredHandle(tombstone)) return tombstone;
    const raw = await this.kvGet(recordKey(handle));
    if (!isStoredRecord(raw)) return null;
    if (Date.parse(raw.expires_at) <= this.opts.now().getTime()) {
      const expired = { status: "expired" as const, expired_at: raw.expires_at, command: raw.command };
      await this.expireRedDbEntry({
        handle: raw.handle,
        key: recordKey(raw.handle),
        bytes: raw.original_bytes,
        command: raw.command,
        created_at: raw.created_at,
        expires_at: raw.expires_at,
      }, raw.expires_at);
      return expired;
    }
    const original = this.readOriginal(raw);
    if (!original) return null;
    return {
      collection: RSP_ELISION_COLLECTION,
      handle: raw.handle,
      original,
      command: raw.command,
      created_at: raw.created_at,
      loss: raw.loss,
    };
  }

  private async statsRedDb(): Promise<RspStoreStats> {
    const index = await this.pruneRedDb(await this.readRedDbIndex());
    return {
      records: index.records.length,
      bytes: index.records.reduce((sum, entry) => sum + entry.bytes, 0),
      oldest: index.records.reduce<string | null>((oldest, entry) => {
        if (oldest == null) return entry.created_at;
        return entry.created_at < oldest ? entry.created_at : oldest;
      }, null),
      budget: this.opts.byteBudget,
    };
  }

  async memory(action: "recall" | "ingest", payload: unknown): Promise<unknown> {
    if (!this.db) throw new Error("resident memory operations require the shared RedDB store");
    await this.ensureMemoryGraphStore();
    if (action === "recall") {
      const request = parseMemoryRecallPayload(payload);
      return await this.memoryRecallRedDb(request.query, request.limit);
    }
    if (action === "ingest") {
      const request = parseMemoryIngestPayload(payload);
      return await this.memoryIngestRedDb(request);
    }
    throw new Error(`unsupported memory action: ${action}`);
  }

  private async ensureMemoryGraphStore(): Promise<void> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    await this.db.execute("CREATE GRAPH IF NOT EXISTS memory_nodes");
    await this.db.execute("CREATE GRAPH IF NOT EXISTS memory_edges");
  }

  private async memoryIngestRedDb(request: { cwd: string; maxFiles?: number; ignore?: string[] }): Promise<unknown> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    const files = await collectMemoryFiles(request.cwd, request.maxFiles ?? 200, request.ignore ?? []);
    let nodes = 0;
    for (const file of files) {
      const body = await readFile(file, "utf8").catch(() => "");
      const text = body.trim();
      if (!text) continue;
      const label = basename(file);
      const hash = createHash("sha256").update("resident-memory-v1\0").update(file).update("\0").update(text).digest("hex");
      if (await this.db.kv("memory_kv").get(`resident-node-hash:${hash}`) != null) continue;
      const now = Date.now();
      const properties = {
        title: label,
        content: text,
        source: file,
        confidence: "EXTRACTED",
        hash,
        project: "default",
        scope: "project",
        importance: 1,
        tier: "durable",
        provenance_tier: "oracle",
        created_at: now,
        updated_at: now,
        accessed_at: now,
        access_count: 0,
        provenance: {
          source_kind: "system",
          writer: "rsp-resident",
          confidence: "EXTRACTED",
          evidence: [file],
          created_at: now,
          updated_at: now,
        },
      };
      const r = await this.db.query(
        "INSERT INTO memory_nodes NODE (label, node_type, hash, properties) VALUES ($1, $2, $3, $4) RETURNING *",
        label,
        "concept",
        hash,
        properties,
      );
      const rid = Number(r.rows[0]?.red_entity_id ?? r.rows[0]?.rid);
      if (Number.isFinite(rid)) await this.db.kv("memory_kv").put(`resident-node-hash:${hash}`, rid);
      nodes += 1;
    }
    return {
      files: files.length,
      nodes,
      edges: 0,
      docs: files.length,
      added: nodes,
      updated: 0,
      skipped: files.length - nodes,
      stale: 0,
      semantic: {
        enabled: false,
        nodes: 0,
        edges: 0,
        token_cost: { input: 0, output: 0 },
      },
      durationMs: 0,
    };
  }

  private async memoryRecallRedDb(query: string, limit: number): Promise<unknown> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    const r = await this.db.query("SELECT * FROM memory_nodes");
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = r.rows
      .map((row) => residentRowToRecallHit(row, terms))
      .filter((hit): hit is ResidentRecallHit => hit != null)
      .sort((a, b) => b.score - a.score)
      .slice(0, Math.max(1, Math.min(100, limit)));
    return {
      hits,
      context_md: hits.map((hit) => `- memory_nodes:${hit.rid} ${hit.label}: ${hit.excerpt}`).join("\n"),
      diagnostics: {
        vector: { status: "unavailable", candidates: 0, contributed: 0, reason: "resident-basic-recall" },
      },
    };
  }

  private async readRedDbIndex(): Promise<IndexDocument> {
    const raw = await this.kvGet(indexKey());
    return isIndexDocument(raw) ? raw : { version: 1, records: [] };
  }

  private async writeRedDbIndex(index: IndexDocument): Promise<void> {
    await this.kv().put(indexKey(), index);
  }

  private async pruneRedDb(index: IndexDocument): Promise<IndexDocument> {
    const nowMs = this.opts.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const live: IndexEntry[] = [];
    for (const entry of index.records) {
      if (Date.parse(entry.expires_at) <= nowMs) {
        await this.expireRedDbEntry(entry, entry.expires_at);
      } else {
        live.push(entry);
      }
    }
    let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      bytes -= evicted.bytes;
      await this.expireRedDbEntry(evicted, nowIso);
    }
    const next = { version: 1 as const, records: live };
    await this.writeRedDbIndex(next);
    return next;
  }

  private async expireRedDbEntry(entry: IndexEntry, expiredAt: string): Promise<void> {
    await this.kv().delete(entry.key);
    await this.kv().put(tombstoneKey(entry.handle), {
      status: "expired",
      expired_at: expiredAt,
      command: entry.command,
    });
  }

  private async assertRedDbMintPersisted(handle: `el:${string}`, bytes: number): Promise<void> {
    const raw = await this.kvGet(recordKey(handle));
    if (!isStoredRecord(raw)) {
      throw new Error(`rsp resident failed to persist elision record ${handle}`);
    }
    const index = await this.readRedDbIndex();
    const entry = index.records.find((candidate) => candidate.handle === handle);
    if (!entry || entry.bytes !== bytes) {
      throw new Error(`rsp resident failed to persist elision index ${handle}`);
    }
  }
}

function contentHandle(original: Buffer, meta: RspMintMeta): `el:${string}` {
  const hash = createHash("sha256")
    .update("rsp-elision-v1\0")
    .update(original)
    .update("\0")
    .update(JSON.stringify({ command: meta.command, loss: meta.loss }))
    .digest("hex")
    .slice(0, 12);
  return `el:${hash}`;
}

function recordKey(handle: `el:${string}`): string {
  return `record:${handle.slice(3)}`;
}

function tombstoneKey(handle: `el:${string}`): string {
  return `expired:${handle.slice(3)}`;
}

function indexKey(): string {
  return "index:v1";
}

function isHandle(value: string): value is `el:${string}` {
  return /^el:[a-f0-9]{12}$/.test(value);
}

function parseMemoryRecallPayload(payload: unknown): {
  query: string;
  limit: number;
  options: {
    includeSuperseded?: boolean;
    scope?: unknown;
    now?: number;
    ranking?: unknown;
  };
} {
  if (!isPlainObject(payload)) throw new Error("memory recall payload must be an object");
  const query = payload.query;
  if (typeof query !== "string" || query.trim() === "") throw new Error("memory recall query is required");
  const limit = typeof payload.limit === "number" && Number.isFinite(payload.limit) ? payload.limit : 10;
  return {
    query,
    limit,
    options: {
      includeSuperseded: payload.includeSuperseded === true,
      scope: isPlainObject(payload.scope) ? payload.scope : undefined,
      ranking: isPlainObject(payload.ranking) ? payload.ranking : undefined,
    },
  };
}

function parseMemoryIngestPayload(payload: unknown): {
  cwd: string;
  maxFiles?: number;
  ignore?: string[];
} {
  if (!isPlainObject(payload)) throw new Error("memory ingest payload must be an object");
  const cwd = payload.cwd;
  if (typeof cwd !== "string" || cwd.trim() === "") throw new Error("memory ingest cwd is required");
  const maxFiles = typeof payload.maxFiles === "number" && Number.isFinite(payload.maxFiles)
    ? payload.maxFiles
    : undefined;
  const ignore = Array.isArray(payload.ignore)
    ? payload.ignore.filter((item): item is string => typeof item === "string")
    : undefined;
  return { cwd, maxFiles, ignore };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ResidentRecallHit {
  id: string;
  rid: number;
  label: string;
  node_type: string;
  score: number;
  excerpt: string;
}

async function collectMemoryFiles(root: string, maxFiles: number, ignore: string[]): Promise<string[]> {
  const out: string[] = [];
  const ignored = new Set([".git", "node_modules", ".red", ...ignore]);
  async function walk(dir: string): Promise<void> {
    if (out.length >= maxFiles) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (ignored.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (entry.isFile() && /\.(md|mdx|txt|ts|tsx|js|jsx|json|yaml|yml|toml|rs|go|py|sql)$/i.test(entry.name)) {
        out.push(path);
      }
    }
  }
  await walk(root);
  return out;
}

function residentRowToRecallHit(row: Record<string, unknown>, terms: string[]): ResidentRecallHit | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  if (!Number.isFinite(rid)) return null;
  const rawProperties = row.properties ?? row.PROPERTIES;
  const properties = isPlainObject(rawProperties) ? rawProperties : {};
  const label = String(row.label ?? row.LABEL ?? properties.title ?? `memory-${rid}`);
  const nodeType = String(row.node_type ?? row.NODE_TYPE ?? "concept");
  const content = String(properties.content ?? properties.summary ?? properties.title ?? label);
  const haystack = `${label} ${content}`.toLowerCase();
  const matched = terms.filter((term) => haystack.includes(term));
  if (matched.length === 0 && terms.length > 0) return null;
  return {
    id: String(rid),
    rid,
    label,
    node_type: nodeType,
    score: matched.length || 1,
    excerpt: content.slice(0, 500),
  };
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isRecord(value)) return false;
  return value.collection === RSP_ELISION_COLLECTION &&
    typeof value.handle === "string" &&
    isHandle(value.handle) &&
    typeof value.original === "string" &&
    value.original_encoding === "base64" &&
    typeof value.original_bytes === "number" &&
    typeof value.command === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    isLossMeta(value.loss);
}

function isIndexDocument(value: unknown): value is IndexDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) return false;
  return value.records.every((entry) =>
    isRecord(entry) &&
    typeof entry.handle === "string" &&
    isHandle(entry.handle) &&
    typeof entry.key === "string" &&
    typeof entry.bytes === "number" &&
    typeof entry.command === "string" &&
    typeof entry.created_at === "string" &&
    typeof entry.expires_at === "string"
  );
}

function isExpiredHandle(value: unknown): value is RspExpiredHandle {
  return isRecord(value) &&
    value.status === "expired" &&
    typeof value.expired_at === "string" &&
    typeof value.command === "string";
}

function isLossMeta(value: unknown): value is RspLossMeta {
  return isRecord(value) &&
    typeof value.level === "string" &&
    typeof value.bytes_elided === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStoreDocument(path: string): Promise<StoreDocument> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return emptyStoreDocument();
    const parsed = JSON.parse(text) as unknown;
    if (isStoreDocument(parsed)) return parsed;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const document = emptyStoreDocument();
      await writeStoreDocument(path, document);
      return document;
    }
    throw err;
  }
  throw new Error("rsp elision store is unreadable");
}

async function writableStorePath(path: string): Promise<string> {
  try {
    const bytes = await readFile(path);
    if (usesEmbeddedRedDb(path)) return path;
    if (isLegacyRedDbStore(bytes)) return legacyRedDbFallbackPath(path);
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw err;
  }
}

function isLegacyRedDbStore(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).toString("ascii") === "RDBSBLK1";
}

function legacyRedDbFallbackPath(path: string): string {
  if (basename(path) === "red.rdb") return join(dirname(path), "tmp", "rsp-elisions.json");
  return `${path}.json`;
}

function usesEmbeddedRedDb(path: string): boolean {
  return basename(path) === "red-skills.rdb";
}

async function ensureReddbBinaryFromWarmCache(): Promise<void> {
  if (process.env.REDDB_BIN || !process.env.RED_SKILLS_CACHE_DIR) return;
  const root = join(process.env.RED_SKILLS_CACHE_DIR, "reddb");
  let versions: string[];
  try {
    versions = await readdir(root);
  } catch {
    return;
  }
  versions.sort().reverse();
  for (const version of versions) {
    const candidate = join(root, version, process.platform === "win32" ? "red.exe" : "red");
    if (existsSync(candidate)) {
      process.env.REDDB_BIN = candidate;
      return;
    }
  }
}

async function writeStoreDocument(path: string, document: StoreDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(document)}\n`, "utf8");
  await rename(tmp, path);
}

function emptyStoreDocument(): StoreDocument {
  return { version: 1, records: {}, tombstones: {}, index: { version: 1, records: [] } };
}

function isStoreDocument(value: unknown): value is StoreDocument {
  return isRecord(value) &&
    value.version === 1 &&
    isRecord(value.records) &&
    Object.values(value.records).every(isStoredRecord) &&
    isRecord(value.tombstones) &&
    Object.values(value.tombstones).every(isExpiredHandle) &&
    isIndexDocument(value.index);
}

function fileStorePath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error("rsp elision store requires a file:// URI");
  }
  return fileURLToPath(uri);
}
