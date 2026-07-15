import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { connect, type RedDB } from "@reddb-io/sdk";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_TTL_DAYS } from "./config.js";

export const RSP_ELISION_COLLECTION = "rsp_elisions_v1";

export { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_TTL_DAYS };

export type RspLossLevel = "lossless" | "brief" | "terse" | (string & {});

export interface RspLossMeta {
  level: RspLossLevel;
  bytes_elided: number;
}

export interface RspMintMeta {
  command: string;
  loss: RspLossMeta;
}

export type RspStorageClass = "derivable" | "re-executable" | "ephemeral";

export type RspStorageClassStats = Record<RspStorageClass, { records: number; bytes: number; raw_bytes: number }>;

export interface RspElisionRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original: Buffer;
  command: string;
  created_at: string;
  loss: RspLossMeta;
  storage_class: RspStorageClass;
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
  storage_classes: RspStorageClassStats;
}

export interface RspElisionStoreOptions {
  uri: string;
  ttlDays?: number;
  ephemeralTtlHours?: number;
  byteBudget?: number;
  now?: () => Date;
  allowResidentOpen?: boolean;
}

interface StoredRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original?: string;
  original_encoding?: "base64";
  original_bytes: number;
  content_hash?: string;
  stored_bytes?: number;
  blob_key?: string;
  command: string;
  created_at: string;
  expires_at: string;
  loss: RspLossMeta;
  storage_class?: RspStorageClass;
  derivation_recipe?: RspDerivationRecipe;
  reexecution_recipe?: RspReexecutionRecipe;
}

interface IndexEntry {
  handle: `el:${string}`;
  key: string;
  bytes: number;
  raw_bytes?: number;
  command: string;
  created_at: string;
  expires_at: string;
  storage_class?: RspStorageClass;
  blob_key?: string;
}

interface StoredBlob {
  key: string;
  content_hash: string;
  encoding: "gzip+base64";
  bytes: string;
  original_bytes: number;
  stored_bytes: number;
  created_at: string;
}

interface RspDerivationRecipe {
  kind: "git-blob";
  command: string;
  cwd: string;
  object_ids: string[];
  working_tree_fingerprint: string;
  original_bytes: number;
}

interface RspReexecutionRecipe {
  kind: "command";
  command: string;
  cwd: string;
  argv: string[];
  original_bytes: number;
  content_hash: string;
}

interface IndexDocument {
  version: 1;
  records: IndexEntry[];
}

interface StoreDocument {
  version: 1;
  records: Record<string, StoredRecord>;
  blobs: Record<string, StoredBlob>;
  tombstones: Record<string, RspExpiredHandle>;
  index: IndexDocument;
}

interface RedDbKvCollectionSnapshot {
  name: string;
  items: Array<{ key: string; value: unknown }>;
}

export class RspElisionStore {
  private document!: StoreDocument;
  private db?: RedDB;
  private readonly path: string;
  private dirty = false;

  private constructor(path: string, private readonly opts: Omit<RspElisionStoreOptions, "ttlDays" | "ephemeralTtlHours" | "byteBudget"> & {
    uri: string;
    now: () => Date;
    ttlDays: number;
    ephemeralTtlHours: number;
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
      ephemeralTtlHours: positiveNumber(opts.ephemeralTtlHours, DEFAULT_RSP_EPHEMERAL_TTL_HOURS),
      byteBudget: positiveNumber(opts.byteBudget, DEFAULT_RSP_BYTE_BUDGET),
      now: opts.now ?? (() => new Date()),
    });
    if (usesEmbeddedRedDb(path)) {
      await ensureReddbBinaryFromWarmCache();
      // The SDK creates the .rdb file but not its parent directory; the store now
      // lives in the state tier (.red/state), which may not exist yet.
      await mkdir(dirname(path), { recursive: true });
      store.db = await connect(`file://${path}`);
      await store.ensureRedDbCollections();
      await store.ensureRedDbStore();
    } else {
      store.document = await readStoreDocument(store.path);
    }
    return store;
  }

  async close(): Promise<void> {
    await this.db?.close();
  }

  redDb(): RedDB | undefined {
    return this.db;
  }

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    if (this.db) return await this.mintRedDb(original, meta);
    const bytes = Buffer.from(original);
    const now = this.opts.now();
    const createdAt = now.toISOString();
    const handle = contentHandle(bytes, meta);
    const key = recordKey(handle);
    const requestedStorageClass = storageClassForCommand(meta.command);
    const derivationRecipe = requestedStorageClass === "derivable" ? deriveGitBlobRecipe(bytes, meta.command) : null;
    const reexecutionRecipe = requestedStorageClass === "re-executable" ? deriveReexecutionRecipe(bytes, meta.command) : null;
    const storageClass = requestedStorageClass === "derivable" && !derivationRecipe
      ? "ephemeral"
      : requestedStorageClass === "re-executable" && !reexecutionRecipe
        ? "ephemeral"
        : requestedStorageClass;
    const expiresAt = expiresAtFor(now, storageClass, this.opts.ttlDays, this.opts.ephemeralTtlHours);
    const hash = contentHash(bytes);
    const blob = storageClass === "ephemeral" ? compressedBlob(bytes, hash, createdAt) : null;
    const storedBytes = storedBytesFor(bytes, derivationRecipe, reexecutionRecipe, blob);
    if (blob && !this.document.blobs[blob.key]) {
      this.document.blobs[blob.key] = blob;
      this.dirty = true;
    }

    const record: StoredRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle,
      original_bytes: bytes.length,
      stored_bytes: storedBytes,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      loss: meta.loss,
      storage_class: storageClass,
      content_hash: hash,
      ...(derivationRecipe
        ? { derivation_recipe: derivationRecipe }
        : reexecutionRecipe
          ? { reexecution_recipe: reexecutionRecipe }
          : { blob_key: blob?.key }),
    };

    delete this.document.tombstones[tombstoneKey(handle)];
    this.document.records[key] = record;
    this.upsertIndex({
      handle,
      key,
      bytes: storedBytes,
      raw_bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      storage_class: storageClass,
      blob_key: blob?.key,
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
        bytes: storedBytesForRecord(raw),
        raw_bytes: raw.original_bytes,
        command: raw.command,
        created_at: raw.created_at,
        expires_at: raw.expires_at,
        storage_class: storageClassForRecord(raw),
        blob_key: raw.blob_key,
      }, raw.expires_at);
      await this.flush();
      return expired;
    }

    const original = await this.readOriginal(raw);
    if (!original && (raw.derivation_recipe || raw.reexecution_recipe)) {
      return { status: "expired", expired_at: raw.expires_at, command: raw.command };
    }
    if (!original) return null;

    return {
      collection: RSP_ELISION_COLLECTION,
      handle: raw.handle,
      original,
      command: raw.command,
      created_at: raw.created_at,
      loss: raw.loss,
      storage_class: storageClassForRecord(raw),
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
      bytes: storedBytesForIndex(records),
      oldest: records.reduce<string | null>((oldest, entry) => {
        if (oldest == null) return entry.created_at;
        return entry.created_at < oldest ? entry.created_at : oldest;
      }, null),
      budget: this.opts.byteBudget,
      storage_classes: storageStatsForIndex(records),
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
    this.dirty = true;
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

    let bytes = storedBytesForIndex(live);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      this.expireEntry(evicted, nowIso);
      bytes = storedBytesForIndex(live);
    }

    if (live.length < index.records.length) {
      this.writeIndex({ version: 1, records: live });
    }
    this.deleteUnreferencedLocalBlobs(live);
  }

  private expireEntry(entry: IndexEntry, expiredAt: string): void {
    delete this.document.records[entry.key];
    this.document.tombstones[tombstoneKey(entry.handle)] = {
      status: "expired",
      expired_at: expiredAt,
      command: entry.command,
    };
    this.dirty = true;
  }

  private tombstone(handle: `el:${string}`): RspExpiredHandle | null {
    const raw = this.document.tombstones[tombstoneKey(handle)];
    return isExpiredHandle(raw) ? raw : null;
  }

  private async readOriginal(record: StoredRecord): Promise<Buffer | null> {
    if (record.original) return Buffer.from(record.original, "base64");
    if (record.derivation_recipe) return readGitBlobRecipe(record.derivation_recipe);
    if (record.reexecution_recipe) return readReexecutionRecipe(record.reexecution_recipe);
    if (record.blob_key) {
      const blob = this.db ? await this.kvGet(record.blob_key) : this.document.blobs[record.blob_key];
      if (!isStoredBlob(blob)) return null;
      return readCompressedBlob(blob);
    }
    return null;
  }

  private deleteUnreferencedLocalBlobs(live: readonly IndexEntry[]): void {
    const referenced = new Set(live.map((entry) => entry.blob_key).filter((key): key is string => typeof key === "string"));
    for (const key of Object.keys(this.document.blobs)) {
      if (!referenced.has(key)) {
        delete this.document.blobs[key];
        this.dirty = true;
      }
    }
  }

  private async flush(): Promise<void> {
    if (this.dirty) {
      await writeStoreDocument(this.path, this.document);
      this.dirty = false;
    }
    await this.rotateLocalGenerationIfOversized();
  }

  private async rotateLocalGenerationIfOversized(): Promise<void> {
    const currentBytes = await stat(this.path).then((value) => value.size, () => 0);
    if (currentBytes <= this.opts.byteBudget) return;
    const live = this.readIndex().records;
    const liveKeys = new Set(live.map((entry) => entry.key));
    const liveBlobKeys = new Set(live.map((entry) => entry.blob_key).filter((key): key is string => typeof key === "string"));
    const compacted: StoreDocument = {
      version: 1,
      records: Object.fromEntries(Object.entries(this.document.records).filter(([key]) => liveKeys.has(key))),
      blobs: Object.fromEntries(Object.entries(this.document.blobs).filter(([key]) => liveBlobKeys.has(key))),
      tombstones: {},
      index: { version: 1, records: live },
    };
    const compactedBytes = Buffer.byteLength(`${JSON.stringify(compacted)}\n`, "utf8");
    if (compactedBytes > this.opts.byteBudget) return;
    if (compactedBytes >= currentBytes) return;
    this.document = compacted;
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

  private async ensureRedDbCollections(): Promise<void> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    const meta = (await this.db.list()).find((entry) => entry.name === RSP_ELISION_COLLECTION);
    if (!meta) {
      await this.db.query(`CREATE KV IF NOT EXISTS ${RSP_ELISION_COLLECTION}`);
      return;
    }
    if (meta.model === "kv") return;
    if (meta.model !== "table") {
      throw new Error(`cannot self-heal elision collection ${RSP_ELISION_COLLECTION}: unsupported model ${meta.model}`);
    }

    await this.db.query(`DROP TABLE ${RSP_ELISION_COLLECTION}`);
    await this.db.query(`CREATE KV IF NOT EXISTS ${RSP_ELISION_COLLECTION}`);
  }

  private async mintRedDb(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const bytes = Buffer.from(original);
    const now = this.opts.now();
    const createdAt = now.toISOString();
    const handle = contentHandle(bytes, meta);
    const key = recordKey(handle);
    const requestedStorageClass = storageClassForCommand(meta.command);
    const derivationRecipe = requestedStorageClass === "derivable" ? deriveGitBlobRecipe(bytes, meta.command) : null;
    const reexecutionRecipe = requestedStorageClass === "re-executable" ? deriveReexecutionRecipe(bytes, meta.command) : null;
    const storageClass = requestedStorageClass === "derivable" && !derivationRecipe
      ? "ephemeral"
      : requestedStorageClass === "re-executable" && !reexecutionRecipe
        ? "ephemeral"
        : requestedStorageClass;
    const expiresAt = expiresAtFor(now, storageClass, this.opts.ttlDays, this.opts.ephemeralTtlHours);
    const hash = contentHash(bytes);
    const blob = storageClass === "ephemeral" ? compressedBlob(bytes, hash, createdAt) : null;
    const storedBytes = storedBytesFor(bytes, derivationRecipe, reexecutionRecipe, blob);
    if (blob && !isStoredBlob(await this.kvGet(blob.key))) {
      await this.kv().put(blob.key, blob);
    }
    const record: StoredRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle,
      original_bytes: bytes.length,
      stored_bytes: storedBytes,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      loss: meta.loss,
      storage_class: storageClass,
      content_hash: hash,
      ...(derivationRecipe
        ? { derivation_recipe: derivationRecipe }
        : reexecutionRecipe
          ? { reexecution_recipe: reexecutionRecipe }
          : { blob_key: blob?.key }),
    };
    await this.kv().delete(tombstoneKey(handle));
    await this.kv().put(key, record);
    const index = await this.readRedDbIndex();
    const withoutExisting = index.records.filter((entry) => entry.handle !== handle);
    withoutExisting.push({
      handle,
      key,
      bytes: storedBytes,
      raw_bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      storage_class: storageClass,
      blob_key: blob?.key,
    });
    await this.pruneRedDb({ version: 1, records: withoutExisting }, true);
    await this.assertRedDbMintPersisted(handle, storedBytes);
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
        bytes: storedBytesForRecord(raw),
        raw_bytes: raw.original_bytes,
        command: raw.command,
        created_at: raw.created_at,
        expires_at: raw.expires_at,
        storage_class: storageClassForRecord(raw),
        blob_key: raw.blob_key,
      }, raw.expires_at);
      return expired;
    }
    const original = await this.readOriginal(raw);
    if (!original && (raw.derivation_recipe || raw.reexecution_recipe)) {
      return { status: "expired", expired_at: raw.expires_at, command: raw.command };
    }
    if (!original) return null;
    return {
      collection: RSP_ELISION_COLLECTION,
      handle: raw.handle,
      original,
      command: raw.command,
      created_at: raw.created_at,
      loss: raw.loss,
      storage_class: storageClassForRecord(raw),
    };
  }

  private async statsRedDb(): Promise<RspStoreStats> {
    const index = await this.pruneRedDb(await this.readRedDbIndex());
    return {
      records: index.records.length,
      bytes: storedBytesForIndex(index.records),
      oldest: index.records.reduce<string | null>((oldest, entry) => {
        if (oldest == null) return entry.created_at;
        return entry.created_at < oldest ? entry.created_at : oldest;
      }, null),
      budget: this.opts.byteBudget,
      storage_classes: storageStatsForIndex(index.records),
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

  private async pruneRedDb(index: IndexDocument, hadAdditions = false): Promise<IndexDocument> {
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
    let bytes = storedBytesForIndex(live);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      await this.expireRedDbEntry(evicted, nowIso);
      bytes = storedBytesForIndex(live);
    }
    const next = { version: 1 as const, records: live };
    if (hadAdditions || live.length < index.records.length) {
      await this.writeRedDbIndex(next);
    }
    await this.deleteUnreferencedRedDbBlobs(live);
    await this.rotateRedDbGenerationIfOversized(next);
    return next;
  }

  private async rotateRedDbGenerationIfOversized(index: IndexDocument): Promise<void> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    const currentBytes = await stat(this.path).then((value) => value.size, () => 0);
    if (currentBytes <= this.opts.byteBudget) return;

    const snapshot = await this.snapshotRedDbKvCollections(index);
    if (!snapshot) return;

    const suffix = `${process.pid}.${Date.now()}`;
    const compactPath = `${this.path}.${suffix}.compact`;
    const backupPath = `${this.path}.${suffix}.old`;
    await rm(compactPath, { force: true });
    await rm(backupPath, { force: true });

    const compactDb = await connect(`file://${compactPath}`);
    try {
      for (const collection of snapshot) {
        await compactDb.query(`CREATE KV IF NOT EXISTS ${redDbIdentifier(collection.name)}`);
        const kv = compactDb.kv(collection.name);
        for (const item of collection.items) await kv.put(item.key, item.value);
      }
    } finally {
      await compactDb.close();
    }

    const compactBytes = await stat(compactPath).then((value) => value.size, () => 0);
    if (compactBytes === 0 || compactBytes > this.opts.byteBudget || compactBytes >= currentBytes) {
      await rm(compactPath, { force: true });
      return;
    }

    await this.db.close();
    this.db = undefined;
    try {
      await rename(this.path, backupPath);
      await rename(compactPath, this.path);
      await rm(backupPath, { force: true });
    } catch (err) {
      if (!existsSync(this.path) && existsSync(backupPath)) {
        await rename(backupPath, this.path);
      }
      await rm(compactPath, { force: true });
      throw err;
    } finally {
      this.db = await connect(`file://${this.path}`);
    }
  }

  private async snapshotRedDbKvCollections(index: IndexDocument): Promise<RedDbKvCollectionSnapshot[] | null> {
    if (!this.db) throw new Error("rsp RedDB store is not open");
    const collections = await this.db.list();
    if (collections.some((collection) => collection.model !== "kv")) return null;

    const snapshots: RedDbKvCollectionSnapshot[] = [];
    let sawElisionCollection = false;
    for (const collection of collections) {
      const name = String(collection.name ?? "").trim();
      if (name === RSP_ELISION_COLLECTION) {
        snapshots.push(await this.snapshotRedDbElisions(index));
        sawElisionCollection = true;
        continue;
      }
      const listed = await this.db.kv(name).list({ limit: 10_000 });
      if (listed.items.length >= 10_000) return null;
      snapshots.push({ name, items: listed.items });
    }
    if (!sawElisionCollection) snapshots.push(await this.snapshotRedDbElisions(index));
    return snapshots;
  }

  private async snapshotRedDbElisions(index: IndexDocument): Promise<RedDbKvCollectionSnapshot> {
    const items: Array<{ key: string; value: unknown }> = [{ key: indexKey(), value: index }];
    const keys = new Set<string>();
    for (const entry of index.records) {
      keys.add(entry.key);
      if (entry.blob_key) keys.add(entry.blob_key);
    }
    for (const key of keys) {
      const value = await this.kvGet(key);
      if (value != null) items.push({ key, value });
    }
    return { name: RSP_ELISION_COLLECTION, items };
  }

  private async expireRedDbEntry(entry: IndexEntry, expiredAt: string): Promise<void> {
    await this.kv().delete(entry.key);
    await this.kv().put(tombstoneKey(entry.handle), {
      status: "expired",
      expired_at: expiredAt,
      command: entry.command,
    });
  }

  private async deleteUnreferencedRedDbBlobs(live: readonly IndexEntry[]): Promise<void> {
    const referenced = new Set(live.map((entry) => entry.blob_key).filter((key): key is string => typeof key === "string"));
    const listed = await this.kv().list({ limit: 10_000 }).catch(() => ({ items: [] as Array<{ key: string }> }));
    for (const entry of listed.items) {
      if (entry.key.startsWith("blob:") && !referenced.has(entry.key)) {
        await this.kv().delete(entry.key);
      }
    }
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

function blobKey(hash: string): string {
  return `blob:${hash}`;
}

function redDbIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid RedDB identifier: ${value}`);
  return value;
}

export function storageClassForCommand(command: string): RspStorageClass {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  const executable = argv[0] ?? "";
  if (executable === "cat") return "derivable";
  if (executable === "git") {
    const subcommand = argv[1] ?? "";
    if (subcommand === "log" || subcommand === "diff" || subcommand === "blame" || subcommand === "show") {
      return "derivable";
    }
    if (isReExecutableArgv(argv)) return "re-executable";
    return "ephemeral";
  }
  return "ephemeral";
}

function storageClassForRecord(record: Pick<StoredRecord, "command" | "storage_class">): RspStorageClass {
  return isStorageClass(record.storage_class) ? record.storage_class : storageClassForCommand(record.command);
}

function storageClassForIndexEntry(entry: Pick<IndexEntry, "command" | "storage_class">): RspStorageClass {
  return isStorageClass(entry.storage_class) ? entry.storage_class : storageClassForCommand(entry.command);
}

function storageStatsForIndex(records: readonly IndexEntry[]): RspStorageClassStats {
  const stats = emptyStorageClassStats();
  const seenBlobsByClass: Record<RspStorageClass, Set<string>> = {
    derivable: new Set(),
    "re-executable": new Set(),
    ephemeral: new Set(),
  };
  for (const entry of records) {
    const storageClass = storageClassForIndexEntry(entry);
    stats[storageClass].records += 1;
    stats[storageClass].raw_bytes += entry.raw_bytes ?? entry.bytes;
    if (entry.blob_key) {
      if (seenBlobsByClass[storageClass].has(entry.blob_key)) continue;
      seenBlobsByClass[storageClass].add(entry.blob_key);
    }
    stats[storageClass].bytes += entry.bytes;
  }
  return stats;
}

function expiresAtFor(now: Date, storageClass: RspStorageClass, ttlDays: number, ephemeralTtlHours: number): string {
  const ttlMs = storageClass === "ephemeral"
    ? ephemeralTtlHours * 60 * 60 * 1000
    : ttlDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ttlMs).toISOString();
}

function storedBytesForIndex(records: readonly IndexEntry[]): number {
  let bytes = 0;
  const seenBlobs = new Set<string>();
  for (const entry of records) {
    if (entry.blob_key) {
      if (seenBlobs.has(entry.blob_key)) continue;
      seenBlobs.add(entry.blob_key);
    }
    bytes += entry.bytes;
  }
  return bytes;
}

function deriveGitBlobRecipe(bytes: Buffer, command: string): RspDerivationRecipe | null {
  const cwd = process.cwd();
  const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, encoding: "utf8" });
  if (inside.status !== 0 || inside.stdout.trim() !== "true") return null;
  const object = spawnSync("git", ["hash-object", "-w", "--stdin"], { cwd, input: bytes, encoding: "buffer" });
  if (object.status !== 0) return null;
  const objectId = object.stdout.toString("utf8").trim();
  if (!/^[0-9a-f]{40,64}$/.test(objectId)) return null;
  return {
    kind: "git-blob",
    command,
    cwd,
    object_ids: [objectId],
    working_tree_fingerprint: gitWorkingTreeFingerprint(cwd),
    original_bytes: bytes.length,
  };
}

function gitWorkingTreeFingerprint(cwd: string): string {
  const head = gitOutput(cwd, ["rev-parse", "HEAD"]) || "unborn";
  const index = gitOutput(cwd, ["write-tree"]) || "no-index";
  const status = gitOutput(cwd, ["status", "--porcelain=v1", "-z"]) || "";
  return createHash("sha256")
    .update(head)
    .update("\0")
    .update(index)
    .update("\0")
    .update(status)
    .digest("hex");
}

function gitOutput(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

function deriveReexecutionRecipe(bytes: Buffer, command: string): RspReexecutionRecipe | null {
  const argv = command.trim().split(/\s+/).filter(Boolean);
  if (!isReExecutableArgv(argv)) return null;
  const current = runReexecutionCommand(process.cwd(), argv, bytes.length);
  if (!current || contentHash(current) !== contentHash(bytes)) return null;
  return {
    kind: "command",
    command,
    cwd: process.cwd(),
    argv,
    original_bytes: bytes.length,
    content_hash: contentHash(bytes),
  };
}

function isReExecutableArgv(argv: readonly string[]): boolean {
  if (argv[0] === "git") {
    if (argv[1] === "status") return true;
    if (argv[1] !== "branch") return false;
    return argv.length === 2 || argv.slice(2).every((arg) => /^-[avvr]+$/.test(arg));
  }
  return false;
}

function contentHash(bytes: Buffer): string {
  return createHash("sha256").update("rsp-reexecutable-content-v1\0").update(bytes).digest("hex");
}

function storedBytesFor(
  bytes: Buffer,
  derivationRecipe: RspDerivationRecipe | null,
  reexecutionRecipe?: RspReexecutionRecipe | null,
  blob?: StoredBlob | null,
): number {
  if (derivationRecipe) return Buffer.byteLength(JSON.stringify(derivationRecipe), "utf8");
  if (reexecutionRecipe) return Buffer.byteLength(JSON.stringify(reexecutionRecipe), "utf8");
  if (blob) return blob.stored_bytes;
  return bytes.length;
}

function storedBytesForRecord(record: StoredRecord): number {
  if (typeof record.stored_bytes === "number") return record.stored_bytes;
  if (record.derivation_recipe) return Buffer.byteLength(JSON.stringify(record.derivation_recipe), "utf8");
  if (record.reexecution_recipe) return Buffer.byteLength(JSON.stringify(record.reexecution_recipe), "utf8");
  if (record.blob_key) return typeof record.stored_bytes === "number" ? record.stored_bytes : 0;
  return record.original_bytes;
}

function compressedBlob(bytes: Buffer, hash: string, createdAt: string): StoredBlob {
  const compressed = gzipSync(bytes);
  return {
    key: blobKey(hash),
    content_hash: hash,
    encoding: "gzip+base64",
    bytes: compressed.toString("base64"),
    original_bytes: bytes.length,
    stored_bytes: compressed.length,
    created_at: createdAt,
  };
}

function readCompressedBlob(blob: StoredBlob): Buffer | null {
  try {
    const original = gunzipSync(Buffer.from(blob.bytes, "base64"));
    return original.length === blob.original_bytes ? original : null;
  } catch {
    return null;
  }
}

function readGitBlobRecipe(recipe: RspDerivationRecipe): Buffer | null {
  const objectId = recipe.object_ids[0];
  if (!objectId) return null;
  const result = spawnSync("git", ["cat-file", "-p", objectId], {
    cwd: recipe.cwd,
    encoding: "buffer",
    maxBuffer: Math.max(recipe.original_bytes + 1024, 1024 * 1024),
  });
  if (result.status !== 0) return null;
  if (result.stdout.length !== recipe.original_bytes) return null;
  return result.stdout;
}

function readReexecutionRecipe(recipe: RspReexecutionRecipe): Buffer | null {
  if (!isReExecutableArgv(recipe.argv)) return null;
  const current = runReexecutionCommand(recipe.cwd, recipe.argv, recipe.original_bytes);
  if (!current) return null;
  if (contentHash(current) === recipe.content_hash) return current;
  return Buffer.concat([
    Buffer.from("reconstructed after state moved - current snapshot follows\n", "utf8"),
    current,
  ]);
}

function runReexecutionCommand(cwd: string, argv: readonly string[], originalBytes: number): Buffer | null {
  const executable = argv[0];
  if (!executable) return null;
  const result = spawnSync(executable, argv.slice(1), {
    cwd,
    encoding: "buffer",
    maxBuffer: Math.max(originalBytes + 1024, 1024 * 1024),
  });
  if (result.status !== 0 || result.signal) return null;
  return result.stdout;
}

function emptyStorageClassStats(): RspStorageClassStats {
  return {
    derivable: { records: 0, bytes: 0, raw_bytes: 0 },
    "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
    ephemeral: { records: 0, bytes: 0, raw_bytes: 0 },
  };
}

function isHandle(value: string): value is `el:${string}` {
  return /^el:[a-f0-9]{12}$/.test(value);
}

function isBlobKey(value: string): boolean {
  return /^blob:[a-f0-9]{64}$/.test(value);
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
  const hasOriginal = typeof value.original === "string" && value.original_encoding === "base64";
  const hasRecipe = isDerivationRecipe(value.derivation_recipe);
  const hasReexecutionRecipe = isReexecutionRecipe(value.reexecution_recipe);
  const blobKeyValue = value.blob_key;
  const hasBlob = typeof blobKeyValue === "string" && isBlobKey(blobKeyValue);
  return value.collection === RSP_ELISION_COLLECTION &&
    typeof value.handle === "string" &&
    isHandle(value.handle) &&
    (hasOriginal || hasRecipe || hasReexecutionRecipe || hasBlob) &&
    typeof value.original_bytes === "number" &&
    (value.content_hash === undefined || isSha256(value.content_hash)) &&
    (value.stored_bytes === undefined || typeof value.stored_bytes === "number") &&
    (blobKeyValue === undefined || (typeof blobKeyValue === "string" && isBlobKey(blobKeyValue))) &&
    typeof value.command === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    isLossMeta(value.loss) &&
    (value.storage_class === undefined || isStorageClass(value.storage_class));
}

function isIndexDocument(value: unknown): value is IndexDocument {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.records)) return false;
  return value.records.every((entry) => {
    if (!isRecord(entry)) return false;
    const blobKeyValue = entry.blob_key;
    return (
    typeof entry.handle === "string" &&
    isHandle(entry.handle) &&
    typeof entry.key === "string" &&
    typeof entry.bytes === "number" &&
    (entry.raw_bytes === undefined || typeof entry.raw_bytes === "number") &&
    typeof entry.command === "string" &&
    typeof entry.created_at === "string" &&
    typeof entry.expires_at === "string" &&
    (entry.storage_class === undefined || isStorageClass(entry.storage_class)) &&
    (blobKeyValue === undefined || (typeof blobKeyValue === "string" && isBlobKey(blobKeyValue)))
    );
  });
}

function isStoredBlob(value: unknown): value is StoredBlob {
  return isRecord(value) &&
    typeof value.key === "string" &&
    isBlobKey(value.key) &&
    isSha256(value.content_hash) &&
    value.encoding === "gzip+base64" &&
    typeof value.bytes === "string" &&
    typeof value.original_bytes === "number" &&
    typeof value.stored_bytes === "number" &&
    typeof value.created_at === "string";
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

function isStorageClass(value: unknown): value is RspStorageClass {
  return value === "derivable" || value === "re-executable" || value === "ephemeral";
}

function isDerivationRecipe(value: unknown): value is RspDerivationRecipe {
  return isRecord(value) &&
    value.kind === "git-blob" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.object_ids) &&
    value.object_ids.every((item) => typeof item === "string" && /^[0-9a-f]{40,64}$/.test(item)) &&
    typeof value.working_tree_fingerprint === "string" &&
    typeof value.original_bytes === "number";
}

function isReexecutionRecipe(value: unknown): value is RspReexecutionRecipe {
  return isRecord(value) &&
    value.kind === "command" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.argv) &&
    value.argv.every((item) => typeof item === "string") &&
    isReExecutableArgv(value.argv) &&
    typeof value.original_bytes === "number" &&
    isSha256(value.content_hash);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readStoreDocument(path: string): Promise<StoreDocument> {
  try {
    const text = await readFile(path, "utf8");
    if (text.trim() === "") return emptyStoreDocument();
    const parsed = JSON.parse(text) as unknown;
    if (isStoreDocument(parsed)) return { ...parsed, blobs: parsed.blobs ?? {} };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      const document = emptyStoreDocument();
      await writeStoreDocument(path, document);
      return document;
    }
    const document = emptyStoreDocument();
    await writeStoreDocument(path, document);
    return document;
  }
  const document = emptyStoreDocument();
  await writeStoreDocument(path, document);
  return document;
}

async function writableStorePath(path: string): Promise<string> {
  try {
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw err;
  }
}

function usesEmbeddedRedDb(path: string): boolean {
  return basename(path) === "red-skills.rdb";
}

export async function ensureReddbBinaryFromWarmCache(): Promise<void> {
  if (process.env.REDDB_BIN) return;
  // Same default cascade as the launcher fetch: an unset RED_SKILLS_CACHE_DIR
  // means the standard cache location, not "no cache".
  const cacheDir =
    process.env.RED_SKILLS_CACHE_DIR ??
    (process.env.XDG_CACHE_HOME
      ? join(process.env.XDG_CACHE_HOME, "red-skills", "bundles")
      : join(homedir(), ".cache", "red-skills", "bundles"));
  const root = join(cacheDir, "reddb");
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
  return { version: 1, records: {}, blobs: {}, tombstones: {}, index: { version: 1, records: [] } };
}

function isStoreDocument(value: unknown): value is StoreDocument {
  return isRecord(value) &&
    value.version === 1 &&
    isRecord(value.records) &&
    Object.values(value.records).every(isStoredRecord) &&
    (value.blobs === undefined || (isRecord(value.blobs) && Object.values(value.blobs).every(isStoredBlob))) &&
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
