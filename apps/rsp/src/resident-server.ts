import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { RedDB } from "@reddb-io/sdk";
import { type JsonObject } from "@reddb-io/toon";
import { rspStateDir } from "@reddb-io/shared/red-paths.js";
import { removeResidentRegistry, writeResidentRegistry } from "@reddb-io/shared/resident-client.js";
import { serveWireSocket } from "@reddb-io/shared/resident-core.js";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
import type { RspExpiredHandle, RspElisionRecord } from "./elision-store.js";
import { RspElisionStore } from "./elision-store.js";
import { createResidentBrainStore } from "./resident-brain.js";
import {
  createCachedGithubBalanceReader,
  createRspResidentGithubClient,
  type RspResidentGithubClient,
} from "./resident-github.js";
import type { RspResidentConfig, RspResidentRequest, RspResidentResponse } from "./resident-protocol.js";
import {
  parseTelemetryEvent,
  readAccountingLaneStats,
  readTelemetryGainsReport,
  readTelemetryStats,
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  drainTelemetrySpool,
  type RspTelemetryEvent,
} from "./telemetry.js";
import { DEFAULT_RSP_IDLE_MS, DEFAULT_RSP_TELEMETRY_BYTE_BUDGET, DEFAULT_RSP_TELEMETRY_TTL_DAYS } from "./config.js";

export interface ResidentServerOptions extends RspResidentConfig {
  socketPath: string;
  pidPath?: string;
  rootDir?: string;
  idleMs?: number;
  residentVersion?: string;
  registryPath?: string;
  telemetryDrainIntervalMs?: number;
  telemetryDrainTimeoutMs?: number;
  /** Injected resident-lifetime GitHub client for transport fixtures. */
  github?: RspResidentGithubClient;
}

export async function runResidentServer(opts: ResidentServerOptions): Promise<void> {
  await mkdir(dirname(opts.socketPath), { recursive: true });
  const redRpcGuard = startRedRpcParentDeathGuard();
  installRedRpcExitCleanup();

  const telemetryDrainTimeoutMs = opts.telemetryDrainTimeoutMs ?? TELEMETRY_DRAIN_TIMEOUT_MS;
  let storeState: ResidentStoreState = { kind: "opening", startedAt: process.hrtime.bigint() };
  let telemetryTimer: NodeJS.Timeout | undefined;
  let shuttingDown = false;
  const github = opts.github ?? createLazyResidentGithub(opts.rootDir ?? process.cwd());

  const idleMs = opts.idleMs ?? DEFAULT_RSP_IDLE_MS;
  let idleTimer: NodeJS.Timeout | undefined;
  let idleShutdownWatchdog: NodeJS.Timeout | undefined;
  let idleShutdownStarted = false;
  const activeSockets = new Set<Socket>();
  const telemetryDrainIntervalMs = opts.telemetryDrainIntervalMs ?? 30_000;
  const server = createServer((socket) => {
    activeSockets.add(socket);
    socket.once("close", () => activeSockets.delete(socket));
    touch();
    handleSocket(socket, async (request, reply) => {
      touch();
      const value = await handleRequest(
        storeState,
        request,
        opts.storeUri,
        opts.residentVersion ?? "0.0.0-dev",
        github,
      );
      const response: RspResidentResponse = {
        id: request.id,
        ok: true,
        value,
        storeOpenCount: storeState.kind === "ready" ? storeState.storeOpenCount : undefined,
        storeElapsedMs: storeState.kind === "ready" ? storeState.storeElapsedMs : undefined,
      };
      reply(response);
      if (request.op === "handover") setImmediate(() => beginShutdown());
    });
  });

  function beginShutdown(): void {
    shuttingDown = true;
    idleShutdownStarted = true;
    idleShutdownWatchdog = armIdleShutdownWatchdog(idleShutdownWatchdog);
    server.close();
    for (const socket of activeSockets) socket.destroy();
  }

  function touch(): void {
    if (storeState.kind === "opening") return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      beginShutdown();
    }, idleMs);
    idleTimer.unref();
  }

  const shutdownSignals = ["SIGINT", "SIGTERM"] as const;
  const signalHandlers = shutdownSignals.map((signal) => {
    const handler = () => {
      cleanupRedRpcChildrenSync();
      server.close();
      for (const socket of activeSockets) socket.destroy();
      setTimeout(() => process.exit(0), 1_000);
    };
    process.once(signal, handler);
    return { signal, handler };
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  void (async () => {
    const openedAt = process.hrtime.bigint();
    if (process.env.RSP_TEST_HANG_RESIDENT_STORE_OPEN === "1") await new Promise(() => undefined);
    const testDelayMs = Number(process.env.RSP_TEST_DELAY_RESIDENT_STORE_OPEN_MS ?? "0");
    if (Number.isFinite(testDelayMs) && testDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, testDelayMs));
    }
    const store = await RspElisionStore.open({
      uri: opts.storeUri,
      ttlDays: opts.ttlDays,
      ephemeralTtlHours: opts.ephemeralTtlHours,
      byteBudget: opts.byteBudget,
      allowResidentOpen: true,
    });
    const storeElapsedMs = Number(process.hrtime.bigint() - openedAt) / 1_000_000;
    const telemetry = new ResidentTelemetryDrain(store, {
      rootDir: opts.rootDir ?? process.cwd(),
      ttlDays: opts.telemetryTtlDays ?? DEFAULT_RSP_TELEMETRY_TTL_DAYS,
      byteBudget: opts.telemetryByteBudget ?? opts.byteBudget ?? DEFAULT_RSP_TELEMETRY_BYTE_BUDGET,
    });
    if (shuttingDown) {
      await store.close();
      return;
    }
    await safeDrainTelemetry(telemetry, telemetryDrainTimeoutMs);
    if (shuttingDown) {
      await store.close();
      return;
    }
    storeState = { kind: "ready", store, telemetry, storeOpenCount: 1, storeElapsedMs };
    telemetryTimer = setInterval(() => {
      const ready = storeState.kind === "ready" ? storeState : undefined;
      if (ready) void safeDrainTelemetry(ready.telemetry, telemetryDrainTimeoutMs);
    }, telemetryDrainIntervalMs);
    telemetryTimer.unref();
    touch();
  })().catch((err) => {
    storeState = { kind: "failed", error: err instanceof Error ? err : new Error(String(err)) };
    touch();
  });

  if (opts.pidPath) {
    await writeFile(opts.pidPath, `${process.pid}\n`, { encoding: "utf8", mode: 0o600 });
  }
  const residentVersion = opts.residentVersion ?? "0.0.0-dev";
  const registryPath = opts.registryPath ?? join(rspStateDir(opts.rootDir ?? process.cwd()), "rsp-resident.pid.toon");
  try {
    await writeResidentRegistry(registryPath, {
      socket_path: opts.socketPath,
      store_uri: opts.storeUri,
      resident_version: residentVersion,
    });
  } catch {}

  await new Promise<void>((resolve) => server.once("close", resolve));
  if (idleTimer) clearTimeout(idleTimer);
  if (telemetryTimer) clearInterval(telemetryTimer);
  await rm(opts.socketPath, { force: true });
  const finalStoreState = storeState as ResidentStoreState;
  if (finalStoreState.kind === "ready") {
    await safeDrainTelemetry(finalStoreState.telemetry, telemetryDrainTimeoutMs, idleShutdownStarted);
    await finalStoreState.store.close();
  }
  if (idleShutdownWatchdog) clearTimeout(idleShutdownWatchdog);
  for (const { signal, handler } of signalHandlers) process.off(signal, handler);
  redRpcGuard?.kill("SIGTERM");
  cleanupRedRpcChildrenSync();
  if (opts.pidPath) await rm(opts.pidPath, { force: true });
  await removeResidentRegistry(registryPath);
}

interface ResidentTelemetryOptions {
  rootDir: string;
  ttlDays: number;
  byteBudget: number;
  bootHeals?: TelemetryCollectionHeal[];
}

interface TelemetryIndexEntry {
  collection:
    | typeof RSP_ACCOUNTING_EVENTS_COLLECTION
    | typeof RSP_DECISIONS_COLLECTION
    | typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION
    | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION;
  key: string;
  created_at: string;
  expires_at: string;
  bytes: number;
}

interface TelemetryIndexDocument {
  version: 1;
  records: TelemetryIndexEntry[];
}

interface TelemetryCollectionHeal {
  collection:
    | typeof RSP_ACCOUNTING_EVENTS_COLLECTION
    | typeof RSP_DECISIONS_COLLECTION
    | typeof RSP_TELEMETRY_INVOCATIONS_COLLECTION
    | typeof RSP_TELEMETRY_DEGRADATIONS_COLLECTION
    | typeof RSP_TELEMETRY_INDEX_COLLECTION;
  previousModel: string;
}

type ResidentStoreState =
  | { kind: "opening"; startedAt: bigint }
  | { kind: "ready"; store: RspElisionStore; telemetry: ResidentTelemetryDrain; storeOpenCount: number; storeElapsedMs: number }
  | { kind: "failed"; error: Error };

const TOKENIZATION_CAP_BYTES = 256 * 1024;
const TOKENIZATION_TIMEOUT_MS = 500;
const TELEMETRY_DRAIN_TIMEOUT_MS = 2_000;
const IDLE_SHUTDOWN_WATCHDOG_MS = Math.max(
  1,
  Number(process.env.RSP_TEST_IDLE_SHUTDOWN_WATCHDOG_MS ?? "10000"),
);
const RSP_STATUS_SUMMARY_FILE = "rsp-status-summary.toon";
const TELEMETRY_KV_COLLECTIONS = [
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
] as const;

class ResidentTelemetryDrain {
  private running?: Promise<void>;
  private pending = false;
  private pendingHeals: TelemetryCollectionHeal[];

  constructor(
    private readonly store: RspElisionStore,
    private readonly opts: ResidentTelemetryOptions,
  ) {
    this.pendingHeals = [...(opts.bootHeals ?? [])];
  }

  async drainAndSweep(): Promise<void> {
    if (this.running) {
      this.pending = true;
      await this.running;
      return;
    }
    this.running = (async () => {
      do {
        this.pending = false;
        await this.drainAndSweepOnce();
      } while (this.pending);
    })().finally(() => {
      this.running = undefined;
    });
    await this.running;
  }

  private async drainAndSweepOnce(): Promise<void> {
    const db = this.store.redDb();
    if (!db) return;
    const healed = await ensureTelemetryKvCollections(db);
    healed.unshift(...this.pendingHeals);
    this.pendingHeals = [];
    const index = await this.readIndex(db);
    const originalCount = index.records.length;
    const nextRecords = [...index.records];
    for (const entry of healed) {
      nextRecords.push(await this.writeDrainDegradation(db, {
        reason: "telemetry collection model mismatch",
        command: "rsp resident telemetry drain",
        source_collection: entry.collection,
        error: `expected kv, got ${entry.previousModel}`,
        bytes: 0,
      }));
    }
    await drainTelemetrySpool(this.opts.rootDir, async (line) => {
      const event = parseTelemetryEvent(line);
      if (!event) {
        const entry = await this.writeDrainDegradation(db, {
          reason: "telemetry parse failed",
          command: "unknown",
          bytes: Buffer.byteLength(line, "utf8"),
        });
        nextRecords.push(entry);
        return true;
      }
      try {
        const entry = await this.writeEvent(db, event);
        nextRecords.push(entry);
        const mirror = await this.writeAccountingMirror(db, event);
        if (mirror) nextRecords.push(mirror);
        return true;
      } catch (err) {
        const entry = await this.writeDrainDegradation(db, {
          reason: "telemetry event dropped",
          command: stringField(event.command) || "unknown",
          source_id: stringField(event.id),
          source_collection: stringField(event.collection),
          error: err instanceof Error ? err.message : String(err),
          bytes: Buffer.byteLength(line, "utf8"),
        });
        nextRecords.push(entry);
        return true;
      }
    });
    const hadAdditions = nextRecords.length > originalCount;
    await this.prune(db, { version: 1, records: nextRecords }, hadAdditions);
    await writeStatusSummary(db, this.opts.rootDir);
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
      bytes: event.collection === RSP_ACCOUNTING_EVENTS_COLLECTION
        ? 0
        : typeof event.bytes === "number" && Number.isFinite(event.bytes)
        ? Math.max(0, event.bytes)
        : Buffer.byteLength(JSON.stringify(record), "utf8"),
    };
  }

  private async writeAccountingMirror(db: RedDB, event: RspTelemetryEvent): Promise<TelemetryIndexEntry | null> {
    if (event.collection === RSP_ACCOUNTING_EVENTS_COLLECTION) return null;
    if (event.accounting_recorded === true) return null;
    if (event.collection === RSP_TELEMETRY_INVOCATIONS_COLLECTION) {
      return await this.writeEvent(db, {
        collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
        id: `mirror:${stringField(event.id) || randomUUID()}`,
        created_at: stringField(event.created_at) || stringField(event.ts) || new Date().toISOString(),
        event_type: "invocation",
        command: stringField(event.command) || "unknown",
        command_class: commandClass(stringField(event.command) || "unknown"),
        wrapper: event.wrapper,
        loss: event.loss,
        elided: event.elided,
        raw_bytes: event.raw_bytes,
        emitted_bytes: event.emitted_bytes,
        tokens_raw: event.tokens_raw,
        tokens_emitted: event.tokens_emitted,
        estimated: event.estimated,
        wrapper_ms: event.wrapper_ms,
        store_open_count: event.store_open_count,
        store_elapsed_ms: event.store_elapsed_ms,
      });
    }
    if (event.collection === RSP_TELEMETRY_DEGRADATIONS_COLLECTION) {
      return await this.writeEvent(db, {
        collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
        id: `mirror:${stringField(event.id) || randomUUID()}`,
        created_at: stringField(event.created_at) || stringField(event.ts) || new Date().toISOString(),
        event_type: "invocation",
        command: stringField(event.command) || "unknown",
        command_class: commandClass(stringField(event.command) || "unknown"),
        loss: "lossless",
        raw_bytes: 0,
        emitted_bytes: 0,
        degradation_reason: stringField(event.reason) || "unknown",
        wrapper_family: stringField(event.wrapper_family),
        wrapper_exit_code: event.wrapper_exit_code,
        stderr_head: stringField(event.stderr_head),
      });
    }
    return null;
  }

  private async writeDrainDegradation(
    db: RedDB,
    event: {
      reason: string;
      command: string;
      bytes: number;
      source_id?: string;
      source_collection?: string;
      error?: string;
    },
  ): Promise<TelemetryIndexEntry> {
    const entry = await this.writeEvent(db, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      id: randomUUID(),
      created_at: new Date().toISOString(),
      reason: event.reason,
      command: event.command,
      bytes: event.bytes,
      source_id: event.source_id,
      source_collection: event.source_collection,
      error: event.error,
    });
    await this.writeEvent(db, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      id: `mirror:${randomUUID()}`,
      created_at: entry.created_at,
      event_type: "invocation",
      command: event.command,
      command_class: commandClass(event.command),
      loss: "lossless",
      raw_bytes: 0,
      emitted_bytes: 0,
      degradation_reason: event.reason,
      source_id: event.source_id,
      source_collection: event.source_collection,
      error: event.error,
    });
    return entry;
  }

  private async readIndex(db: RedDB): Promise<TelemetryIndexDocument> {
    const raw = await db.kv(RSP_TELEMETRY_INDEX_COLLECTION).get("index:v1");
    const parsed = typeof raw === "string" ? safeJson(raw) : raw;
    return isTelemetryIndex(parsed) ? parsed : { version: 1, records: [] };
  }

  private async writeIndex(db: RedDB, index: TelemetryIndexDocument): Promise<void> {
    await db.kv(RSP_TELEMETRY_INDEX_COLLECTION).put("index:v1", index);
  }

  private async prune(db: RedDB, index: TelemetryIndexDocument, hadAdditions = false): Promise<void> {
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
    if (hadAdditions || live.length < index.records.length) {
      await this.writeIndex(db, { version: 1, records: live });
    }
  }
}

async function writeStatusSummary(db: RedDB, rootDir: string, now = new Date()): Promise<void> {
  const stats = await readTelemetryStats(db, 1, now);
  const today = now.toISOString().slice(0, 10);
  const tokensSavedToday = stats.savings.daily_tokens_saved.find((row) => row.date === today)?.tokens_saved ?? 0;
  const dollarsSavedToday = stats.savings.tokens_saved > 0
    ? (tokensSavedToday / stats.savings.tokens_saved) * stats.savings.dollars_saved_estimate_usd
    : 0;
  const path = join(rspStateDir(rootDir), RSP_STATUS_SUMMARY_FILE);
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  const payload: JsonObject = {
    version: 1,
    tokens_saved_today: tokensSavedToday,
    dollars_saved_today_usd: Math.round(dollarsSavedToday * 1_000_000) / 1_000_000,
    show_total_today: stats.health.show_total,
    updated_at: now.toISOString(),
  };
  if (stats.health.show_total > 0) payload.show_hit_rate = stats.health.show_hit_rate;
  if (stats.decisions.seen > 0) {
    payload.decisions = {
      seen: stats.decisions.seen,
      contributed: stats.decisions.contributed,
    };
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(tmp, `${encodeSnapshotToon(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, path);
}

async function safeDrainTelemetry(
  telemetry: ResidentTelemetryDrain,
  timeoutMs = TELEMETRY_DRAIN_TIMEOUT_MS,
  allowTestHang = false,
): Promise<void> {
  try {
    if (allowTestHang && process.env.RSP_TEST_HANG_TELEMETRY_DRAIN === "1") {
      await new Promise(() => undefined);
    }
    await withTimeout(telemetry.drainAndSweep(), timeoutMs, "telemetry drain timed out");
  } catch (err) {
    process.stderr.write(`rsp resident: telemetry drain failed: ${err instanceof Error ? err.message : String(err)}\n`);
  }
}

async function ensureTelemetryKvCollections(db: RedDB): Promise<TelemetryCollectionHeal[]> {
  const healed: TelemetryCollectionHeal[] = [];
  for (const collection of TELEMETRY_KV_COLLECTIONS) {
    const probe = await probeTelemetryKvCollection(db, collection);
    if (probe.ok) continue;
    if (probe.previousModel) {
      if (probe.previousModel !== "collection") await dropTelemetryCollection(db, collection, probe.previousModel);
      healed.push({ collection, previousModel: probe.previousModel });
    }
    await db.query(`CREATE KV IF NOT EXISTS ${sqlIdentifier(collection)}`);
  }
  return healed;
}

async function probeTelemetryKvCollection(
  db: RedDB,
  collection: typeof TELEMETRY_KV_COLLECTIONS[number],
): Promise<{ ok: true } | { ok: false; previousModel: string | null }> {
  try {
    await db.kv(collection).get("__rsp_telemetry_model_probe__");
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/\bnot found\b/i.test(message)) return { ok: false, previousModel: null };
    const mismatch = message.match(/model mismatch: expected kv, got ([A-Za-z_][A-Za-z0-9_]*)/i);
    if (mismatch?.[1]) return { ok: false, previousModel: mismatch[1].toLowerCase() };
    if (/does not allow 'kv' operations/i.test(message)) return { ok: false, previousModel: "collection" };
    const meta = (await db.list()).find((entry) => entry.name === collection);
    if (meta && meta.model !== "kv") return { ok: false, previousModel: meta.model };
    throw err;
  }
}

async function dropTelemetryCollection(db: RedDB, collection: string, model: string): Promise<void> {
  const kind = ddlKind(model);
  if (!kind) throw new Error(`cannot self-heal telemetry collection ${collection}: unsupported model ${model}`);
  await db.query(`DROP ${kind} ${sqlIdentifier(collection)}`);
}

function ddlKind(model: string): string | null {
  const normalized = model.toLowerCase();
  if (normalized === "table") return "TABLE";
  if (normalized === "kv") return "KV";
  if (normalized === "graph") return "GRAPH";
  if (normalized === "queue") return "QUEUE";
  if (normalized === "document" || normalized === "documents") return "DOCUMENT";
  return null;
}

function sqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) throw new Error(`invalid telemetry collection name: ${value}`);
  return value;
}

function armIdleShutdownWatchdog(existing: NodeJS.Timeout | undefined): NodeJS.Timeout {
  if (existing) clearTimeout(existing);
  return setTimeout(() => {
    cleanupRedRpcChildrenSync();
    process.exit(0);
  }, IDLE_SHUTDOWN_WATCHDOG_MS);
}

let redRpcExitCleanupInstalled = false;

function installRedRpcExitCleanup(): void {
  if (redRpcExitCleanupInstalled) return;
  redRpcExitCleanupInstalled = true;
  process.on("exit", () => cleanupRedRpcChildrenSync());
}

function startRedRpcParentDeathGuard(): ReturnType<typeof spawn> | undefined {
  if (process.platform === "win32") return undefined;
  const script = `
const { execFileSync } = require("node:child_process");
const parentPid = Number(process.argv[1]);
const known = new Set();
function rows() {
  try {
    return String(execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" }))
      .split(/\\n/)
      .map((line) => /^\\s*(\\d+)\\s+(\\d+)\\s+([\\s\\S]*)$/.exec(line))
      .filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] || "" }));
  } catch {
    return [];
  }
}
function isRedRpc(args) {
  return /(^|\\s)\\S*red(?:\\.exe)?\\s+rpc\\s+--stdio(\\s|$)/.test(args);
}
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
const timer = setInterval(() => {
  const parentAlive = alive(parentPid);
  const snapshot = rows();
  for (const row of snapshot) {
    if (row.ppid === parentPid && isRedRpc(row.args)) known.add(row.pid);
  }
  if (parentAlive) return;
  for (const row of snapshot) {
    if (known.has(row.pid) && isRedRpc(row.args)) {
      try { process.kill(row.pid, "SIGKILL"); } catch {}
    }
  }
  clearInterval(timer);
  process.exit(0);
}, 500);
`;
  const child = spawn(process.execPath, ["-e", script, String(process.pid)], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return child;
}

function cleanupRedRpcChildrenSync(): void {
  for (const pid of redRpcChildPidsSync()) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
}

function redRpcChildPidsSync(): number[] {
  if (process.platform === "win32") return [];
  let output = "";
  try {
    output = execFileSync("ps", ["-eo", "pid=,ppid=,args="], { encoding: "utf8" });
  } catch {
    return [];
  }
  const pids: number[] = [];
  for (const line of output.split(/\n/)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\s\S]*)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    const args = match[3] ?? "";
    if (ppid === process.pid && /(^|\s)\S*red(?:\.exe)?\s+rpc\s+--stdio(\s|$)/.test(args)) pids.push(pid);
  }
  return pids;
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
      try {
        return await withTimeout((async () => {
          const getEncoding = await loadGetEncoding();
          return { tokens: getEncoding("cl100k_base").encode(text).length, estimated: false };
        })(), TOKENIZATION_TIMEOUT_MS, "telemetry tokenization timed out");
      } catch {
        return { tokens: Math.ceil(bytes / 4), estimated: true };
      }
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

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function commandClass(command: string): string {
  return command.trim().split(/\s+/).filter(Boolean)[0] ?? "unknown";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
        entry.collection === RSP_ACCOUNTING_EVENTS_COLLECTION ||
        entry.collection === RSP_DECISIONS_COLLECTION ||
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

/**
 * Read one framed request and answer it in the encoding it arrived in.
 *
 * The resident shares its framing and its two encodings with `redskilled`
 * through `resident-wire`, which states the order a client and a daemon may
 * adopt them in. The error answer carries a FRESH id because a frame that never
 * became a request has no id to echo — the difference a newer client reads to
 * recognise a resident too old to understand it.
 */
function handleSocket(
  socket: Socket,
  handler: (request: RspResidentRequest, respond: (response: RspResidentResponse) => void) => Promise<void>,
): void {
  serveWireSocket<RspResidentRequest>(
    socket,
    (request, respond) => handler(request, respond as (response: RspResidentResponse) => void),
    (err, request, respond) => {
      respond({
        id: request?.id ?? randomUUID(),
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies RspResidentResponse);
    },
  );
}

async function handleRequest(
  state: ResidentStoreState,
  request: RspResidentRequest,
  storeUri: string,
  residentVersion: string,
  github: RspResidentGithubClient,
): Promise<unknown> {
  if (request.op === "handover") return { handover: true, version: residentVersion, clientVersion: request.clientVersion };
  if (state.kind === "opening") throw new Error("rsp resident store is not ready");
  if (state.kind === "failed") throw new Error(`rsp resident store failed to open: ${state.error.message}`);
  const store = state.store;
  if (request.op === "ping") return { pong: true, version: residentVersion };
  if (request.op === "stats") return await store.stats();
  if (request.op === "recovery-handles") return await store.recoveryHandles(request.limit);
  if (request.op === "accounting-stats") {
    const db = store.redDb();
    if (!db) throw new Error("rsp accounting stats require the shared RedDB store");
    return await readAccountingLaneStats(db, request.byteBudget);
  }
  if (request.op === "telemetry-stats") {
    const db = store.redDb();
    if (!db) throw new Error("rsp telemetry stats require the shared RedDB store");
    return await readTelemetryStats(db, request.sinceDays);
  }
  if (request.op === "telemetry-gains") {
    const db = store.redDb();
    if (!db) throw new Error("rsp telemetry gains require the shared RedDB store");
    return await readTelemetryGainsReport(db, request.sinceDays);
  }
  if (request.op === "mint") {
    return {
      handle: await store.mint(Buffer.from(request.original, "base64"), request.meta as Parameters<RspElisionStore["mint"]>[1]),
    };
  }
  if (request.op === "get") return encodeRecord(await store.get(request.handle));
  if (request.op === "github-read") {
    return await github.read({
      args: request.args,
      path: request.path,
      actor: request.actor,
      ...(request.params ? { params: request.params } : {}),
    });
  }
  if (request.op === "memory") return await store.memory(request.action, request.payload);
  if (request.op === "brain") return await handleBrainRequest(store, storeUri, request.action, request.payload);
  throw new Error(`unsupported resident op: ${(request as { op?: string }).op ?? "unknown"}`);
}

function createLazyResidentGithub(rootDir: string): RspResidentGithubClient {
  let client: RspResidentGithubClient | undefined;
  return {
    async read(input) {
      if (!client) {
        const token = String(execFileSync("gh", ["auth", "token"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        })).trim();
        if (token === "") throw new Error("rsp resident could not obtain a GitHub credential from gh");
        client = createRspResidentGithubClient({
          rootDir,
          token,
          balance: createCachedGithubBalanceReader(token),
        });
      }
      return await client.read(input);
    },
  };
}


async function handleBrainRequest(
  store: RspElisionStore,
  storeUri: string,
  action: Extract<RspResidentRequest, { op: "brain" }>["action"],
  payload: unknown,
): Promise<unknown> {
  const db = store.redDb();
  if (!db) throw new Error("resident brain operations require the shared RedDB store");
  return await createResidentBrainStore(db, storeUri).request(action, payload);
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
