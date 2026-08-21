import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { connect, type RedDB } from "@reddb-io/sdk";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_TTL_DAYS, RSP_ELISION_COLLECTION, type RspElisionRecord, type RspElisionStoreOptions, type RspExpiredHandle, type RspMintMeta, type RspRecoveryHandle, type RspStoreStats } from "./public.js";
import type { IndexDocument, IndexEntry, RedDbKvCollectionSnapshot, ResidentRecallHit, StoreDocument, StoredRecord } from "./model.js";
import { ensureReddbBinary } from "../reddb-binary.js";
import { collectMemoryFiles, compressedBlob, contentHandle, contentHash, deriveGitBlobRecipe, deriveReexecutionRecipe, expiresAtFor, fileStorePath, indexKey, isExpiredHandle, isHandle, isIndexDocument, isStoredBlob, isStoredRecord, parseMemoryIngestPayload, parseMemoryRecallPayload, positiveNumber, readCompressedBlob, readGitBlobRecipe, readReexecutionRecipe, readStoreDocument, recoveryHandlesForIndex, recordKey, redDbIdentifier, residentRowToRecallHit, storageClassForCommand, storageClassForRecord, storageStatsForIndex, storedBytesFor, storedBytesForIndex, storedBytesForRecord, tombstoneKey, usesEmbeddedRedDb, writableStorePath, writeStoreDocument } from "./helpers.js";

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
      ensureReddbBinary();
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

  async recoveryHandles(limit = 5): Promise<RspRecoveryHandle[]> {
    if (this.db) return await this.recoveryHandlesRedDb(limit);
    this.prune();
    await this.flush();
    return recoveryHandlesForIndex(this.readIndex().records, this.opts.now(), limit);
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

  private async recoveryHandlesRedDb(limit: number): Promise<RspRecoveryHandle[]> {
    const index = await this.pruneRedDb(await this.readRedDbIndex());
    return recoveryHandlesForIndex(index.records, this.opts.now(), limit);
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

/**
 * Create the store file, then let go of it (ADR 0126).
 *
 * Provisioning is the one moment no resident can own the store: the file has to
 * exist before anything can be a client of it. That construction belongs to the
 * store module, not to the surface that asks for it — `rsp setup` calls this and
 * never names `RspElisionStore`, so the resident stays the only *running* opener.
 */
export async function provisionElisionStore(opts: RspElisionStoreOptions): Promise<void> {
  const store = await RspElisionStore.open({ ...opts, allowResidentOpen: true });
  await store.close();
}
