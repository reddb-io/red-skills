import { createHash } from "node:crypto";
import { connect, type RedDB } from "@reddb-io/sdk";

export const RSP_ELISION_COLLECTION = "rsp_elisions_v1";
const INDEX_KEY = "__rsp_elision_index_v1";

export const DEFAULT_RSP_TTL_DAYS = 7;
export const DEFAULT_RSP_BYTE_BUDGET = 64 * 1024 * 1024;

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
}

interface StoredRecord {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  original?: string;
  original_chunks?: number;
  original_encoding: "base64";
  original_bytes: number;
  command: string;
  created_at: string;
  expires_at: string;
  loss: RspLossMeta;
}

interface StoredChunk {
  collection: typeof RSP_ELISION_COLLECTION;
  handle: `el:${string}`;
  index: number;
  original: string;
  original_encoding: "base64";
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

export class RspElisionStore {
  private db!: RedDB;

  private constructor(private readonly opts: Required<Omit<RspElisionStoreOptions, "ttlDays" | "byteBudget">> & {
    ttlDays: number;
    byteBudget: number;
  }) {}

  static async open(opts: RspElisionStoreOptions): Promise<RspElisionStore> {
    if (process.env.RSP_FAIL_IF_STORE_OPEN === "1") {
      throw new Error("RSP_FAIL_IF_STORE_OPEN blocked store open");
    }
    const store = new RspElisionStore({
      uri: opts.uri,
      ttlDays: positiveNumber(opts.ttlDays, DEFAULT_RSP_TTL_DAYS),
      byteBudget: positiveNumber(opts.byteBudget, DEFAULT_RSP_BYTE_BUDGET),
      now: opts.now ?? (() => new Date()),
    });
    store.db = await connect(store.opts.uri);
    return store;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
    const bytes = Buffer.from(original);
    const now = this.opts.now();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const handle = contentHandle(bytes, meta);
    const key = recordKey(handle);

    const chunks = chunkBytes(bytes);
    const record: StoredRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle,
      ...(chunks.length === 1 ? { original: chunks[0] } : { original_chunks: chunks.length }),
      original_encoding: "base64",
      original_bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
      loss: meta.loss,
    };

    await this.deleteChunks(handle);
    for (let i = 0; i < chunks.length; i++) {
      if (chunks.length === 1) break;
      await this.kv().put(chunkKey(handle, i), {
        collection: RSP_ELISION_COLLECTION,
        handle,
        index: i,
        original: chunks[i],
        original_encoding: "base64",
      } satisfies StoredChunk);
    }
    await this.kv().put(key, record);
    await this.removeTombstone(handle);
    await this.upsertIndex({
      handle,
      key,
      bytes: bytes.length,
      command: meta.command,
      created_at: createdAt,
      expires_at: expiresAt,
    });
    await this.prune();
    return handle;
  }

  async get(handle: string): Promise<RspElisionRecord | RspExpiredHandle | null> {
    if (!isHandle(handle)) return null;
    const tombstone = await this.tombstone(handle);
    if (tombstone) return tombstone;

    const raw = parseStoredValue(await this.kv().get(recordKey(handle)));
    if (!isStoredRecord(raw)) return null;

    if (Date.parse(raw.expires_at) <= this.opts.now().getTime()) {
      const expired = { status: "expired" as const, expired_at: raw.expires_at, command: raw.command };
      await this.expireEntry({
        handle: raw.handle,
        key: recordKey(raw.handle),
        bytes: raw.original_bytes,
        command: raw.command,
        created_at: raw.created_at,
        expires_at: raw.expires_at,
      }, raw.expires_at);
      return expired;
    }

    const original = await this.readOriginal(raw);
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
    await this.prune();
    const index = await this.readIndex();
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

  private kv() {
    return this.db.kv(RSP_ELISION_COLLECTION);
  }

  private async readIndex(): Promise<IndexDocument> {
    const raw = parseStoredValue(await this.kv().get(INDEX_KEY));
    if (!isIndexDocument(raw)) return { version: 1, records: [] };
    return raw;
  }

  private async writeIndex(index: IndexDocument): Promise<void> {
    await this.kv().put(INDEX_KEY, index);
  }

  private async upsertIndex(entry: IndexEntry): Promise<void> {
    const index = await this.readIndex();
    const withoutExisting = index.records.filter((record) => record.handle !== entry.handle);
    withoutExisting.push(entry);
    await this.writeIndex({ version: 1, records: withoutExisting });
  }

  private async prune(): Promise<void> {
    const nowMs = this.opts.now().getTime();
    const nowIso = new Date(nowMs).toISOString();
    const index = await this.readIndex();
    const live: IndexEntry[] = [];

    for (const entry of index.records) {
      if (Date.parse(entry.expires_at) <= nowMs) {
        await this.expireEntry(entry, entry.expires_at);
      } else {
        live.push(entry);
      }
    }

    let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      bytes -= evicted.bytes;
      await this.expireEntry(evicted, nowIso);
    }

    await this.writeIndex({ version: 1, records: live });
  }

  private async expireEntry(entry: IndexEntry, expiredAt: string): Promise<void> {
    await this.deleteChunks(entry.handle);
    await this.kv().delete(entry.key);
    await this.kv().put(tombstoneKey(entry.handle), {
      status: "expired",
      expired_at: expiredAt,
      command: entry.command,
    });
  }

  private async tombstone(handle: `el:${string}`): Promise<RspExpiredHandle | null> {
    const raw = parseStoredValue(await this.kv().get(tombstoneKey(handle)));
    return isExpiredHandle(raw) ? raw : null;
  }

  private async removeTombstone(handle: `el:${string}`): Promise<void> {
    await this.kv().delete(tombstoneKey(handle));
  }

  private async readOriginal(record: StoredRecord): Promise<Buffer | null> {
    if (record.original) return Buffer.from(record.original, "base64");
    if (!record.original_chunks) return null;
    const chunks: Buffer[] = [];
    for (let i = 0; i < record.original_chunks; i++) {
      const raw = parseStoredValue(await this.kv().get(chunkKey(record.handle, i)));
      if (!isStoredChunk(raw) || raw.handle !== record.handle || raw.index !== i) return null;
      chunks.push(Buffer.from(raw.original, "base64"));
    }
    return Buffer.concat(chunks);
  }

  private async deleteChunks(handle: `el:${string}`): Promise<void> {
    const existing = parseStoredValue(await this.kv().get(recordKey(handle)));
    if (!isStoredRecord(existing) || !existing.original_chunks) return;
    await Promise.all(Array.from({ length: existing.original_chunks }, (_, i) => this.kv().delete(chunkKey(handle, i))));
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

function chunkKey(handle: `el:${string}`, index: number): string {
  return `chunk:${handle.slice(3)}:${index}`;
}

function tombstoneKey(handle: `el:${string}`): string {
  return `expired:${handle.slice(3)}`;
}

function isHandle(value: string): value is `el:${string}` {
  return /^el:[a-f0-9]{12}$/.test(value);
}

function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function chunkBytes(bytes: Buffer): string[] {
  const chunks: string[] = [];
  const chunkSize = 2048;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.subarray(offset, offset + chunkSize).toString("base64"));
  }
  return chunks.length > 0 ? chunks : [""];
}

function isStoredRecord(value: unknown): value is StoredRecord {
  if (!isRecord(value)) return false;
  return value.collection === RSP_ELISION_COLLECTION &&
    typeof value.handle === "string" &&
    isHandle(value.handle) &&
    (typeof value.original === "string" || (typeof value.original_chunks === "number" && Number.isInteger(value.original_chunks) && value.original_chunks > 0)) &&
    value.original_encoding === "base64" &&
    typeof value.original_bytes === "number" &&
    typeof value.command === "string" &&
    typeof value.created_at === "string" &&
    typeof value.expires_at === "string" &&
    isLossMeta(value.loss);
}

function isStoredChunk(value: unknown): value is StoredChunk {
  return isRecord(value) &&
    value.collection === RSP_ELISION_COLLECTION &&
    typeof value.handle === "string" &&
    isHandle(value.handle) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    typeof value.original === "string" &&
    value.original_encoding === "base64";
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

function parseStoredValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
