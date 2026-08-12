import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "@reddb-io/sdk";
import { decode, parseRecords } from "@reddb-io/toon";
import { afterEach } from "vitest";
import {
  appendTelemetryEvent,
  drainTelemetrySpool,
  readTelemetryGainsReport,
  readTelemetryStats,
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  telemetryLegacySpoolPath,
  telemetrySpoolCorrectionsPath,
  telemetrySpoolPath,
} from "../src/telemetry.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS, RSP_ELISION_COLLECTION } from "../src/elision-store.js";
import { tokenSavingsEstimate } from "../src/pricing.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { runResidentServer } from "../src/resident-server.js";

export {
  appendTelemetryEvent,
  connect,
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_TTL_DAYS,
  drainTelemetrySpool,
  execFile,
  execFileAsync,
  join,
  mkdir,
  readFile,
  readTelemetryGainsReport,
  readTelemetryStats,
  resolveResidentPaths,
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_ELISION_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  runResidentServer,
  sendResidentRequest,
  spawnSync,
  telemetryLegacySpoolPath,
  telemetrySpoolCorrectionsPath,
  telemetrySpoolPath,
  tokenSavingsEstimate,
  writeFile,
};

const execFileAsync = promisify(execFile);
const roots: string[] = [];

export async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-telemetry-"));
  roots.push(root);
  await mkdir(join(root, ".red", "tmp"), { recursive: true });
  // Durable telemetry spools live in the rsp state lane (ADR 0098).
  await mkdir(join(root, ".red", "state", "rsp"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
});

export async function readTelemetry(storeUri: string, collection: string, key: string): Promise<unknown> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).get(key);
    return typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  } finally {
    await db.close();
  }
}

export async function readSpoolRows(root: string): Promise<Array<Record<string, unknown>>> {
  return (await readToonlRows(telemetrySpoolPath(root))).map((row) => {
    if ("event" in row) return row;
    const { spool_id: _spoolId, ...event } = row;
    return { ...row, event };
  });
}

export async function readCorrectionRows(root: string): Promise<Array<Record<string, unknown>>> {
  return readToonlRows(telemetrySpoolCorrectionsPath(root));
}

async function readToonlRows(path: string): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(path, "utf8").catch(() => "");
  if (!raw.trim()) return [];
  return parseSniffedToonlRows(raw).map((row) => {
    if (typeof row.event_json !== "string") return row;
    try {
      return { ...row, event: JSON.parse(row.event_json) as unknown };
    } catch {
      return row;
    }
  });
}

function parseSniffedToonlRows(raw: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [];
  let header = "";
  for (const line of raw.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean)) {
    if (/^\[(?:\d*)\]\{[^}]+\}:$/.test(line)) {
      header = line;
      continue;
    }
    if (!header) continue;
    for (const row of parseRecords(`${header}\n${line}\n`)) {
      if (isRecord(row)) rows.push(row);
    }
  }
  return rows;
}

export async function readTelemetryRecords(storeUri: string, collection: string): Promise<unknown[]> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).list({ limit: 1000 });
    return raw.items.map((entry) => typeof entry.value === "string" ? JSON.parse(entry.value) as unknown : entry.value);
  } finally {
    await db.close();
  }
}

export async function readTelemetryCollectionModels(storeUri: string): Promise<Record<string, string>> {
  const db = await connect(storeUri);
  try {
    return Object.fromEntries(
      (await db.list())
        .filter((entry) => [
          RSP_ELISION_COLLECTION,
          RSP_DECISIONS_COLLECTION,
          RSP_TELEMETRY_INVOCATIONS_COLLECTION,
          RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
          RSP_TELEMETRY_INDEX_COLLECTION,
        ].includes(entry.name))
        .map((entry) => [entry.name, entry.model]),
    );
  } finally {
    await db.close();
  }
}

interface TelemetryTiming {
  drainTimeoutMs: number;
  waitTimeoutMs: number;
}

const BASELINE_STORE_OPEN_MS = 100;

export async function calibratedTelemetryTiming(root: string): Promise<TelemetryTiming> {
  const baselineUri = `file://${join(root, ".red", "tmp", `telemetry-baseline-${process.pid}-${Date.now()}.rdb`)}`;
  const started = process.hrtime.bigint();
  const db = await connect(baselineUri);
  await db.close();
  const storeOpenMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  const scale = Math.min(4, Math.max(1, Math.ceil(Math.max(1, storeOpenMs) / BASELINE_STORE_OPEN_MS)));
  return {
    drainTimeoutMs: Math.min(20_000, Math.max(2_000, Math.ceil(storeOpenMs * 8), 2_000 * scale)),
    waitTimeoutMs: 5_000 * scale,
  };
}

export async function waitForResident(socketPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  // The resident answers every request with ok:false while its store is
  // opening or after the open failed, so the last refusal is the diagnosis
  // (e.g. "store failed to open: reddb binary not found"). Carry it.
  let lastError = "no ping response (socket never answered)";
  while (Date.now() < deadline) {
    try {
      const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: `wait-${attempt++}`, op: "ping" });
      if (response.ok) return;
      if (typeof response.error === "string" && response.error) lastError = response.error;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`resident did not start: ${lastError}`);
}

export async function waitForResidentTelemetry(socketPath: string, command: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  let lastError = "no telemetry-stats response (socket never answered)";
  while (Date.now() < deadline) {
    const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, {
      id: `telemetry-${attempt++}`,
      op: "telemetry-stats",
      sinceDays: 7,
    }).catch((err: unknown) => {
      lastError = err instanceof Error ? err.message : String(err);
      return null;
    });
    if (response && !response.ok && typeof response.error === "string" && response.error) lastError = response.error;
    if (response?.ok) lastError = `stats answered without ${command} in top_commands`;
    if (
      response?.ok &&
      isRecord(response.value) &&
      isRecord(response.value.savings) &&
      Array.isArray(response.value.savings.top_commands) &&
      response.value.savings.top_commands.some((entry) => isRecord(entry) && entry.command === command)
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`telemetry ${command} did not drain: ${lastError}`);
}

export async function waitForStatusSummary(summaryPath: string, minMtimeMs = 0, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [summary, mtimeMs] = await Promise.all([
      readFile(summaryPath, "utf8").catch(() => ""),
      fileMtimeMs(summaryPath),
    ]);
    if (parseStructured(summary) && mtimeMs > minMtimeMs) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("rsp status summary did not refresh");
}

export function parseStructured(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return decode(body);
  }
}

export async function fileMtimeMs(path: string): Promise<number> {
  return await stat(path).then((s) => s.mtimeMs, () => 0);
}

export async function shutdownResident(socketPath: string): Promise<void> {
  await sendResidentRequest({ socketPath, timeoutMs: 500 }, {
    id: "shutdown",
    op: "handover",
    clientVersion: "test-shutdown",
  }).catch(() => null);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const alive = await sendResidentRequest({ socketPath, timeoutMs: 100 }, {
      id: "shutdown-poll",
      op: "ping",
    }).then((response) => response.ok, () => false);
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not shut down");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function ensureRspBundle(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const appRoot = resolve(here, "..");
  const repoRoot = resolve(appRoot, "..", "..");
  const bundle = join(repoRoot, "dist", "rsp.bundle.min.mjs");
  await execFileAsync(process.execPath, [
    join(repoRoot, "scripts", "bundle-app.mjs"),
    "--entry",
    "src/cli.ts",
    "--outfile",
    "../../dist/rsp.bundle.min.mjs",
    "--asset",
    "rsp.bundle.min.mjs",
    "--minify",
    "--reddb-from-package",
  ], { cwd: appRoot });
  return bundle;
}
