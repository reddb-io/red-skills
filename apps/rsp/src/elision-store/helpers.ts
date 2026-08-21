import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import { commandWords } from "../command-classifier.js";
import { RSP_ELISION_COLLECTION, type RspExpiredHandle, type RspLossMeta, type RspMintMeta, type RspRecoveryHandle, type RspStorageClass, type RspStorageClassStats } from "./public.js";
import type { IndexDocument, IndexEntry, ResidentRecallHit, RspDerivationRecipe, RspReexecutionRecipe, StoreDocument, StoredBlob, StoredRecord } from "./model.js";

export function contentHandle(original: Buffer, meta: RspMintMeta): `el:${string}` {
  const hash = createHash("sha256")
    .update("rsp-elision-v1\0")
    .update(original)
    .update("\0")
    .update(JSON.stringify({ command: meta.command, loss: meta.loss }))
    .digest("hex")
    .slice(0, 12);
  return `el:${hash}`;
}

export function recordKey(handle: `el:${string}`): string {
  return `record:${handle.slice(3)}`;
}

export function tombstoneKey(handle: `el:${string}`): string {
  return `expired:${handle.slice(3)}`;
}

export function indexKey(): string {
  return "index:v1";
}

export function blobKey(hash: string): string {
  return `blob:${hash}`;
}

export function redDbIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid RedDB identifier: ${value}`);
  return value;
}

export function storageClassForCommand(command: string): RspStorageClass {
  const argv = commandWords(command);
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

export function storageClassForRecord(record: Pick<StoredRecord, "command" | "storage_class">): RspStorageClass {
  return isStorageClass(record.storage_class) ? record.storage_class : storageClassForCommand(record.command);
}

export function storageClassForIndexEntry(entry: Pick<IndexEntry, "command" | "storage_class">): RspStorageClass {
  return isStorageClass(entry.storage_class) ? entry.storage_class : storageClassForCommand(entry.command);
}

export function storageStatsForIndex(records: readonly IndexEntry[]): RspStorageClassStats {
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

export function recoveryHandlesForIndex(records: readonly IndexEntry[], now: Date, limit: number): RspRecoveryHandle[] {
  const nowMs = now.getTime();
  return [...records]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, Math.max(0, limit))
    .map((entry) => {
      const ageSeconds = Math.max(0, Math.floor((nowMs - Date.parse(entry.created_at)) / 1000));
      return {
        handle: entry.handle,
        command: entry.command,
        created_at: entry.created_at,
        expires_at: entry.expires_at,
        age_seconds: ageSeconds,
        age_display: formatAge(ageSeconds),
        storage_class: storageClassForIndexEntry(entry),
        recover: `rsp show ${entry.handle}`,
      };
    });
}

export function formatAge(ageSeconds: number): string {
  if (ageSeconds < 60) return `${ageSeconds}s`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h`;
  return `${Math.floor(ageHours / 24)}d`;
}

export function expiresAtFor(now: Date, storageClass: RspStorageClass, ttlDays: number, ephemeralTtlHours: number): string {
  const ttlMs = storageClass === "ephemeral"
    ? ephemeralTtlHours * 60 * 60 * 1000
    : ttlDays * 24 * 60 * 60 * 1000;
  return new Date(now.getTime() + ttlMs).toISOString();
}

export function storedBytesForIndex(records: readonly IndexEntry[]): number {
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

export function deriveGitBlobRecipe(bytes: Buffer, command: string): RspDerivationRecipe | null {
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

export function gitWorkingTreeFingerprint(cwd: string): string {
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

export function gitOutput(cwd: string, args: string[]): string | null {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : null;
}

export function deriveReexecutionRecipe(bytes: Buffer, command: string): RspReexecutionRecipe | null {
  const argv = commandWords(command);
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

export function isReExecutableArgv(argv: readonly string[]): boolean {
  if (argv[0] === "git") {
    if (argv[1] === "status") return true;
    if (argv[1] !== "branch") return false;
    return argv.length === 2 || argv.slice(2).every((arg) => /^-[avvr]+$/.test(arg));
  }
  return false;
}

export function contentHash(bytes: Buffer): string {
  return createHash("sha256").update("rsp-reexecutable-content-v1\0").update(bytes).digest("hex");
}

export function storedBytesFor(
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

export function storedBytesForRecord(record: StoredRecord): number {
  if (typeof record.stored_bytes === "number") return record.stored_bytes;
  if (record.derivation_recipe) return Buffer.byteLength(JSON.stringify(record.derivation_recipe), "utf8");
  if (record.reexecution_recipe) return Buffer.byteLength(JSON.stringify(record.reexecution_recipe), "utf8");
  if (record.blob_key) return typeof record.stored_bytes === "number" ? record.stored_bytes : 0;
  return record.original_bytes;
}

export function compressedBlob(bytes: Buffer, hash: string, createdAt: string): StoredBlob {
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

export function readCompressedBlob(blob: StoredBlob): Buffer | null {
  try {
    const original = gunzipSync(Buffer.from(blob.bytes, "base64"));
    return original.length === blob.original_bytes ? original : null;
  } catch {
    return null;
  }
}

export function readGitBlobRecipe(recipe: RspDerivationRecipe): Buffer | null {
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

export function readReexecutionRecipe(recipe: RspReexecutionRecipe): Buffer | null {
  if (!isReExecutableArgv(recipe.argv)) return null;
  const current = runReexecutionCommand(recipe.cwd, recipe.argv, recipe.original_bytes);
  if (!current) return null;
  if (contentHash(current) === recipe.content_hash) return current;
  return Buffer.concat([
    Buffer.from("reconstructed after state moved - current snapshot follows\n", "utf8"),
    current,
  ]);
}

export function runReexecutionCommand(cwd: string, argv: readonly string[], originalBytes: number): Buffer | null {
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

export function emptyStorageClassStats(): RspStorageClassStats {
  return {
    derivable: { records: 0, bytes: 0, raw_bytes: 0 },
    "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
    ephemeral: { records: 0, bytes: 0, raw_bytes: 0 },
  };
}

export function isHandle(value: string): value is `el:${string}` {
  return /^el:[a-f0-9]{12}$/.test(value);
}

export function isBlobKey(value: string): boolean {
  return /^blob:[a-f0-9]{64}$/.test(value);
}

export function parseMemoryRecallPayload(payload: unknown): {
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

export function parseMemoryIngestPayload(payload: unknown): {
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function collectMemoryFiles(root: string, maxFiles: number, ignore: string[]): Promise<string[]> {
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

export function residentRowToRecallHit(row: Record<string, unknown>, terms: string[]): ResidentRecallHit | null {
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

export function positiveNumber(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

export function isStoredRecord(value: unknown): value is StoredRecord {
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

export function isIndexDocument(value: unknown): value is IndexDocument {
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

export function isStoredBlob(value: unknown): value is StoredBlob {
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

export function isExpiredHandle(value: unknown): value is RspExpiredHandle {
  return isRecord(value) &&
    value.status === "expired" &&
    typeof value.expired_at === "string" &&
    typeof value.command === "string";
}

export function isLossMeta(value: unknown): value is RspLossMeta {
  return isRecord(value) &&
    typeof value.level === "string" &&
    typeof value.bytes_elided === "number";
}

export function isStorageClass(value: unknown): value is RspStorageClass {
  return value === "derivable" || value === "re-executable" || value === "ephemeral";
}

export function isDerivationRecipe(value: unknown): value is RspDerivationRecipe {
  return isRecord(value) &&
    value.kind === "git-blob" &&
    typeof value.command === "string" &&
    typeof value.cwd === "string" &&
    Array.isArray(value.object_ids) &&
    value.object_ids.every((item) => typeof item === "string" && /^[0-9a-f]{40,64}$/.test(item)) &&
    typeof value.working_tree_fingerprint === "string" &&
    typeof value.original_bytes === "number";
}

export function isReexecutionRecipe(value: unknown): value is RspReexecutionRecipe {
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

export function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readStoreDocument(path: string): Promise<StoreDocument> {
  try {
    const text = await readFile(path, "utf8");
    const body = text.trim();
    if (body === "") return emptyStoreDocument();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body) as unknown;
    } catch {
      parsed = decode(body);
    }
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

export async function writableStorePath(path: string): Promise<string> {
  try {
    return path;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return path;
    throw err;
  }
}

export function usesEmbeddedRedDb(path: string): boolean {
  return basename(path) === "red-skills.rdb";
}

export async function writeStoreDocument(path: string, document: StoreDocument): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${encode(toJsonValue(document))}\n`, "utf8");
  await rename(tmp, path);
}

export function toJsonValue(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) out[key] = toJsonValue(child);
    }
    return out;
  }
  return String(value);
}

export function emptyStoreDocument(): StoreDocument {
  return { version: 1, records: {}, blobs: {}, tombstones: {}, index: { version: 1, records: [] } };
}

export function isStoreDocument(value: unknown): value is StoreDocument {
  return isRecord(value) &&
    value.version === 1 &&
    isRecord(value.records) &&
    Object.values(value.records).every(isStoredRecord) &&
    (value.blobs === undefined || (isRecord(value.blobs) && Object.values(value.blobs).every(isStoredBlob))) &&
    isRecord(value.tombstones) &&
    Object.values(value.tombstones).every(isExpiredHandle) &&
    isIndexDocument(value.index);
}

export function fileStorePath(uri: string): string {
  if (!uri.startsWith("file://")) {
    throw new Error("rsp elision store requires a file:// URI");
  }
  return fileURLToPath(uri);
}
