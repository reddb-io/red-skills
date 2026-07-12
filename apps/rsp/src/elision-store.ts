import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const RSP_ELISION_COLLECTION = "rsp_elisions_v1";

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
  private readonly path: string;

  private constructor(path: string, private readonly opts: Required<Omit<RspElisionStoreOptions, "ttlDays" | "byteBudget">> & {
    ttlDays: number;
    byteBudget: number;
  }) {
    this.path = path;
  }

  static async open(opts: RspElisionStoreOptions): Promise<RspElisionStore> {
    if (process.env.RSP_FAIL_IF_STORE_OPEN === "1") {
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
    store.document = await readStoreDocument(store.path);
    return store;
  }

  async close(): Promise<void> {}

  async mint(original: Uint8Array | Buffer, meta: RspMintMeta): Promise<`el:${string}`> {
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

function isHandle(value: string): value is `el:${string}` {
  return /^el:[a-f0-9]{12}$/.test(value);
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
  if (basename(path) === "red.rdb") return join(dirname(path), "rsp-elisions.json");
  return `${path}.json`;
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
