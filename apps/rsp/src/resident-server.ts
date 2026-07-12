import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RedDB } from "@reddb-io/sdk";
import type { RspExpiredHandle, RspElisionRecord } from "./elision-store.js";
import { RspElisionStore } from "./elision-store.js";
import type { RspResidentConfig, RspResidentRequest, RspResidentResponse } from "./resident-protocol.js";
import {
  parseTelemetryEvent,
  readTelemetryStats,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  takeTelemetrySpool,
  type RspTelemetryEvent,
} from "./telemetry.js";
import { DEFAULT_RSP_TELEMETRY_BYTE_BUDGET, DEFAULT_RSP_TELEMETRY_TTL_DAYS } from "./config.js";

export interface ResidentServerOptions extends RspResidentConfig {
  socketPath: string;
  rootDir?: string;
  idleMs?: number;
}

export async function runResidentServer(opts: ResidentServerOptions): Promise<void> {
  await mkdir(dirname(opts.socketPath), { recursive: true });

  const openedAt = process.hrtime.bigint();
  const store = await RspElisionStore.open({
    uri: opts.storeUri,
    ttlDays: opts.ttlDays,
    byteBudget: opts.byteBudget,
    allowResidentOpen: true,
  });
  const storeElapsedMs = Number(process.hrtime.bigint() - openedAt) / 1_000_000;
  let storeOpenCount = 1;
  const telemetry = new ResidentTelemetryDrain(store, {
    rootDir: opts.rootDir ?? process.cwd(),
    ttlDays: opts.telemetryTtlDays ?? DEFAULT_RSP_TELEMETRY_TTL_DAYS,
    byteBudget: opts.telemetryByteBudget ?? opts.byteBudget ?? DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
  });
  await telemetry.drainAndSweep();

  const idleMs = opts.idleMs ?? 30_000;
  let idleTimer: NodeJS.Timeout | undefined;
  const server = createServer((socket) => {
    touch();
    handleSocket(socket, async (request) => {
      touch();
      const value = await handleRequest(store, request);
      const response: RspResidentResponse = { id: request.id, ok: true, value, storeOpenCount, storeElapsedMs };
      socket.write(`${JSON.stringify(response)}\n`);
    });
  });

  function touch(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void telemetry.drainAndSweep().finally(() => server.close());
    }, idleMs);
    idleTimer.unref();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  touch();

  await new Promise<void>((resolve) => server.once("close", resolve));
  storeOpenCount = 0;
  if (idleTimer) clearTimeout(idleTimer);
  await store.close();
  await rm(opts.socketPath, { force: true });
}

interface ResidentTelemetryOptions {
  rootDir: string;
  ttlDays: number;
  byteBudget: number;
}

interface TelemetryIndexEntry {
  collection: typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION;
  key: string;
  created_at: string;
  expires_at: string;
  bytes: number;
}

interface TelemetryIndexDocument {
  version: 1;
  records: TelemetryIndexEntry[];
}

const TOKENIZATION_CAP_BYTES = 256 * 1024;

class ResidentTelemetryDrain {
  private running?: Promise<void>;

  constructor(
    private readonly store: RspElisionStore,
    private readonly opts: ResidentTelemetryOptions,
  ) {}

  async drainAndSweep(): Promise<void> {
    this.running ??= this.drainAndSweepOnce().finally(() => {
      this.running = undefined;
    });
    await this.running;
  }

  private async drainAndSweepOnce(): Promise<void> {
    const db = this.store.redDb();
    if (!db) return;
    const lines = await takeTelemetrySpool(this.opts.rootDir);
    const index = await this.readIndex(db);
    const nextRecords = [...index.records];
    for (const line of lines) {
      const event = parseTelemetryEvent(line);
      if (!event) continue;
      const entry = await this.writeEvent(db, event);
      nextRecords.push(entry);
    }
    await this.prune(db, { version: 1, records: nextRecords });
  }

  private async writeEvent(db: RedDB, event: RspTelemetryEvent): Promise<TelemetryIndexEntry> {
    const now = new Date();
    const createdAt = typeof event.created_at === "string" ? event.created_at : now.toISOString();
    const expiresAt = new Date(Date.parse(createdAt) + this.opts.ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const key = typeof event.id === "string" && event.id.trim() !== "" ? event.id : randomUUID();
    const record = {
      ...await enrichTelemetryEvent(event),
      id: key,
      created_at: createdAt,
      expires_at: expiresAt,
    };
    await db.kv(event.collection).put(key, record);
    return {
      collection: event.collection,
      key,
      created_at: createdAt,
      expires_at: expiresAt,
      bytes: typeof event.bytes === "number" && Number.isFinite(event.bytes)
        ? Math.max(0, event.bytes)
        : Buffer.byteLength(JSON.stringify(record), "utf8"),
    };
  }

  private async readIndex(db: RedDB): Promise<TelemetryIndexDocument> {
    const raw = await db.kv(RSP_TELEMETRY_INDEX_COLLECTION).get("index:v1");
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    return isTelemetryIndex(parsed) ? parsed : { version: 1, records: [] };
  }

  private async writeIndex(db: RedDB, index: TelemetryIndexDocument): Promise<void> {
    await db.kv(RSP_TELEMETRY_INDEX_COLLECTION).put("index:v1", index);
  }

  private async prune(db: RedDB, index: TelemetryIndexDocument): Promise<void> {
    const nowMs = Date.now();
    const live: TelemetryIndexEntry[] = [];
    for (const entry of index.records) {
      if (Date.parse(entry.expires_at) <= nowMs) {
        await db.kv(entry.collection).delete(entry.key);
      } else {
        live.push(entry);
      }
    }
    let bytes = live.reduce((sum, entry) => sum + entry.bytes, 0);
    live.sort((a, b) => a.created_at.localeCompare(b.created_at));
    while (bytes > this.opts.byteBudget && live.length > 0) {
      const evicted = live.shift()!;
      bytes -= evicted.bytes;
      await db.kv(evicted.collection).delete(evicted.key);
    }
    await this.writeIndex(db, { version: 1, records: live });
  }
}

async function enrichTelemetryEvent(event: RspTelemetryEvent): Promise<RspTelemetryEvent> {
  if (event.collection !== RSP_TELEMETRY_INVOCATIONS_COLLECTION) return event;
  const raw = await tokenCount(event.raw_text, numericField(event.raw_bytes));
  const emitted = await tokenCount(event.emitted_text, numericField(event.emitted_bytes));
  const { raw_text: _rawText, emitted_text: _emittedText, ...persisted } = event;
  return {
    ...persisted,
    tokens_raw: raw.tokens,
    tokens_emitted: emitted.tokens,
    estimated: raw.estimated || emitted.estimated,
  };
}

async function tokenCount(text: unknown, fallbackBytes: number | undefined): Promise<{ tokens: number; estimated: boolean }> {
  if (typeof text === "string") {
    const bytes = Buffer.byteLength(text, "utf8");
    if (bytes <= TOKENIZATION_CAP_BYTES) {
      const getEncoding = await loadGetEncoding();
      return { tokens: getEncoding("cl100k_base").encode(text).length, estimated: false };
    }
    return { tokens: Math.ceil(bytes / 4), estimated: true };
  }
  if (fallbackBytes != null) return { tokens: Math.ceil(fallbackBytes / 4), estimated: true };
  return { tokens: 0, estimated: false };
}

type GetEncoding = (encoding: "cl100k_base") => { encode(text: string): number[] };
let getEncodingLoader: Promise<GetEncoding> | undefined;

async function loadGetEncoding(): Promise<GetEncoding> {
  getEncodingLoader ??= import(pathToFileURL(resolveJsTiktoken()).href).then((module) => {
    const getEncoding = (module as { getEncoding?: GetEncoding }).getEncoding;
    if (!getEncoding) throw new Error("js-tiktoken getEncoding export not found");
    return getEncoding;
  });
  return await getEncodingLoader;
}

function resolveJsTiktoken(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "node_modules", "js-tiktoken", "dist", "index.js"),
    join(here, "..", "apps", "rsp", "node_modules", "js-tiktoken", "dist", "index.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("js-tiktoken dependency not found");
  return found;
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function safeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function isTelemetryIndex(value: unknown): value is TelemetryIndexDocument {
  return isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.records) &&
    value.records.every((entry) =>
      isRecord(entry) &&
      (
        entry.collection === RSP_TELEMETRY_INVOCATIONS_COLLECTION ||
        entry.collection === RSP_TELEMETRY_DEGRADATIONS_COLLECTION
      ) &&
      typeof entry.key === "string" &&
      typeof entry.created_at === "string" &&
      typeof entry.expires_at === "string" &&
      typeof entry.bytes === "number"
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function handleSocket(socket: Socket, handler: (request: RspResidentRequest) => Promise<void>): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline);
    socket.pause();
    void (async () => {
      let request: RspResidentRequest | undefined;
      try {
        request = JSON.parse(line) as RspResidentRequest;
        await handler(request);
      } catch (err) {
        const id = request?.id ?? randomUUID();
        const response: RspResidentResponse = {
          id,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
        socket.write(`${JSON.stringify(response)}\n`);
      } finally {
        socket.end();
      }
    })();
  });
}

async function handleRequest(store: RspElisionStore, request: RspResidentRequest): Promise<unknown> {
  if (request.op === "ping") return { pong: true };
  if (request.op === "stats") return await store.stats();
  if (request.op === "telemetry-stats") {
    const db = store.redDb();
    if (!db) throw new Error("rsp telemetry stats require the shared RedDB store");
    return await readTelemetryStats(db, request.sinceDays);
  }
  if (request.op === "mint") {
    return {
      handle: await store.mint(Buffer.from(request.original, "base64"), request.meta as Parameters<RspElisionStore["mint"]>[1]),
    };
  }
  if (request.op === "get") return encodeRecord(await store.get(request.handle));
  if (request.op === "memory") return await store.memory(request.action, request.payload);
  throw new Error(`unsupported resident op: ${(request as { op?: string }).op ?? "unknown"}`);
}

function encodeRecord(record: RspElisionRecord | RspExpiredHandle | null): unknown {
  if (!record) return null;
  if ("status" in record) return record;
  return {
    ...record,
    original: record.original.toString("base64"),
    original_encoding: "base64",
  };
}
