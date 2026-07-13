import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "@reddb-io/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTelemetryEvent,
  drainTelemetrySpool,
  readTelemetryGainsReport,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  telemetrySpoolPath,
} from "../src/telemetry.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/config.js";
import { tokenSavingsEstimate } from "../src/pricing.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { runResidentServer } from "../src/resident-server.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-telemetry-"));
  roots.push(root);
  await mkdir(join(root, ".red", "tmp"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp telemetry spool", () => {
  it("prices estimated token savings with a documented confidence range", () => {
    expect(tokenSavingsEstimate(1000, true, "gpt-5")).toMatchObject({
      tokens_saved: 1000,
      tokens_saved_estimated: true,
      token_estimate_range_pct: 0.25,
      tokens_saved_low: 750,
      tokens_saved_high: 1250,
      dollars_saved_estimate_usd: 0.00125,
      dollars_saved_low_usd: 0.000938,
      dollars_saved_high_usd: 0.001563,
      pricing_model_family: "gpt-5",
    });
    expect(tokenSavingsEstimate(1000, false, "gpt-5")).toMatchObject({
      tokens_saved: 1000,
      tokens_saved_estimated: false,
      tokens_saved_low: null,
      tokens_saved_high: null,
      dollars_saved_estimate_usd: 0.00125,
    });
  });

  it("appends JSONL without throwing when the target is unavailable", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "ok",
      command: "git status",
    });
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toContain('"id":"ok"');

    await writeFile(join(root, ".red", "tmp", "not-a-dir"), "x", "utf8");
    await expect(appendTelemetryEvent(join(root, "not-there"), {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "lost",
    })).resolves.toBeUndefined();
  });

  it("keeps spool lines that do not drain durably", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "retry-me",
      command: "git log",
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "ok",
      command: "git status",
    });

    await drainTelemetrySpool(root, async (line) => !line.includes("retry-me"));

    const spool = await readFile(telemetrySpoolPath(root), "utf8");
    expect(spool).toContain('"id":"retry-me"');
    expect(spool).not.toContain('"id":"ok"');
  });

  it("drains boot and idle telemetry into RedDB while skipping malformed lines", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "boot-event",
      command: "git status",
      raw_text: "hello world",
      emitted_text: "hello",
      bytes: 100,
    });
    await writeFile(telemetrySpoolPath(root), "not-json\n", { flag: "a" });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      telemetryDrainTimeoutMs: await calibratedTelemetryDrainTimeoutMs(root),
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);

    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      id: "idle-event",
      reason: "resident unavailable",
      bytes: 100,
    });
    await server;

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "boot-event")).resolves.toMatchObject({
      id: "boot-event",
      command: "git status",
      tokens_raw: expect.any(Number),
      tokens_emitted: expect.any(Number),
      estimated: false,
    });
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_DEGRADATIONS_COLLECTION, "idle-event")).resolves.toMatchObject({
      id: "idle-event",
      reason: "resident unavailable",
    });
  }, 20_000);

  it("computes telemetry tokens at drain time and estimates oversized payloads", async () => {
    const root = await tempRoot();
    const huge = "x".repeat(300 * 1024);
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "exact",
      command: "git status",
      raw_text: "alpha beta",
      emitted_text: "alpha",
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "estimated",
      command: "git log",
      raw_text: huge,
      emitted_text: huge,
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000_000,
      telemetryDrainTimeoutMs: await calibratedTelemetryDrainTimeoutMs(root),
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);
    await server;

    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "exact")).resolves.toMatchObject({
      tokens_raw: expect.any(Number),
      tokens_emitted: expect.any(Number),
      estimated: false,
    });
    const estimated = await readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "estimated");
    expect(estimated).toMatchObject({
      tokens_raw: Math.ceil(Buffer.byteLength(huge, "utf8") / 4),
      tokens_emitted: Math.ceil(Buffer.byteLength(huge, "utf8") / 4),
      estimated: true,
    });
  }, 20_000);

  it("enforces telemetry ttl and byte budget without pruning elisions", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "expired",
      created_at: "2000-01-01T00:00:00.000Z",
      bytes: 10,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "oldest",
      created_at: "2099-01-01T00:00:00.000Z",
      bytes: 60,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "newest",
      created_at: "2099-01-02T00:00:00.000Z",
      bytes: 60,
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 1,
      telemetryByteBudget: 75,
      telemetryDrainTimeoutMs: await calibratedTelemetryDrainTimeoutMs(root),
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);
    await server;

    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "expired")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "oldest")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "newest")).resolves.toMatchObject({
      id: "newest",
    });
  }, 20_000);

  it("serves telemetry stats from resident collections without mutating the spool", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "saved",
      created_at: new Date().toISOString(),
      command: "git log",
      elided: true,
      raw_bytes: 1000,
      emitted_bytes: 100,
      raw_text: "alpha ".repeat(100),
      emitted_text: "alpha",
      wrapper_ms: 12,
      store_open_count: 1,
      store_elapsed_ms: 4,
      bytes: 200,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
      id: "degraded",
      created_at: new Date().toISOString(),
      command: "git --version",
      reason: "wrapper failed",
      bytes: 100,
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      telemetryDrainTimeoutMs: await calibratedTelemetryDrainTimeoutMs(root),
      idleMs: 100,
    });
    await waitForResident(paths.socketPath);

    const response = await sendResidentRequest({ socketPath: paths.socketPath }, {
      id: "stats",
      op: "telemetry-stats",
      sinceDays: 7,
    });

    expect(response.ok).toBe(true);
    expect(response.ok && response.value).toMatchObject({
      window_days: 7,
      empty: false,
      savings: {
        invocations: 1,
        elided: 1,
        raw_bytes: 1000,
        emitted_bytes: 100,
        bytes_saved: 900,
        top_commands: [expect.objectContaining({ command: "git log", invocations: 1, bytes_saved: 900 })],
      },
      health: {
        degradations: 1,
        degradation_rate: 0.5,
        by_reason: [{ reason: "wrapper failed", count: 1 }],
        most_recent: expect.objectContaining({ reason: "wrapper failed", command: "git --version" }),
      },
      latency: {
        wrapper_ms_p50: 12,
        wrapper_ms_p95: 12,
        store_open_count_sum: 1,
        store_elapsed_ms_sum: 4,
        store_elapsed_ms_avg: 4,
      },
    });
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await server;
  }, 20_000);

  it("drains a hand-written spool through the built bundle resident", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    await writeFile(telemetrySpoolPath(root), `${JSON.stringify({
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "bundle-event",
      command: "git log",
    })}\n`, "utf8");

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const child = execFile(process.execPath, [
      bundle,
      "server",
      "--socket",
      paths.socketPath,
      "--store-uri",
      storeUri,
      "--ttl-days",
      String(DEFAULT_RSP_TTL_DAYS),
      "--byte-budget",
      String(DEFAULT_RSP_BYTE_BUDGET),
      "--telemetry-drain-timeout-ms",
      String(await calibratedTelemetryDrainTimeoutMs(root)),
      "--idle-ms",
      "100",
    ], { cwd: root });
    await waitForResident(paths.socketPath);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`bundle resident exited ${code}`)));
      child.once("error", reject);
    });

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "bundle-event")).resolves.toMatchObject({
      id: "bundle-event",
      command: "git log",
    });
  }, 40_000);

  it("periodically drains telemetry spooled while the built bundle resident is alive and reports stats", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const child = execFile(process.execPath, [
      bundle,
      "server",
      "--socket",
      paths.socketPath,
      "--store-uri",
      storeUri,
      "--ttl-days",
      String(DEFAULT_RSP_TTL_DAYS),
      "--byte-budget",
      String(DEFAULT_RSP_BYTE_BUDGET),
      "--telemetry-drain-timeout-ms",
      String(await calibratedTelemetryDrainTimeoutMs(root)),
      "--idle-ms",
      "2000",
      "--telemetry-drain-interval-ms",
      "50",
    ], { cwd: root });
    await waitForResident(paths.socketPath);

    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "periodic-event",
      command: "git log --terse",
      elided: true,
      raw_bytes: 1000,
      emitted_bytes: 100,
      wrapper_ms: 5,
    });

    await waitForResidentTelemetry(paths.socketPath, "git log --terse");
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");

    const { stdout } = await execFileAsync(process.execPath, [
      bundle,
      "stats",
      "--store-uri",
      storeUri,
      "--since",
      "7d",
    ], { cwd: root });
    expect(stdout).toContain("empty: false");
    expect(stdout).toContain("invocations: 1");
    expect(stdout).toContain("command: git log --terse invocations: 1");

    child.kill("SIGTERM");
    await new Promise<void>((resolve, reject) => {
      child.once("exit", () => resolve());
      child.once("error", reject);
    });
  }, 40_000);
  it("aggregates rsp gains percentiles, buckets, rankings, and health", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    try {
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("one", {
        created_at: "2026-07-01T10:00:05.000Z",
        command: "git log --terse",
        elided: true,
        raw_bytes: 4000,
        emitted_bytes: 400,
        tokens_raw: 1000,
        tokens_emitted: 100,
        wrapper_ms: 10,
        store_open_count: 1,
      });
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("two", {
        created_at: "2026-07-01T10:00:30.000Z",
        command: "git status",
        elided: false,
        raw_bytes: 100,
        emitted_bytes: 100,
        tokens_raw: 25,
        tokens_emitted: 25,
        wrapper_ms: 20,
        store_open_count: 0,
      });
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("three", {
        created_at: "2026-07-08T12:15:00.000Z",
        command: "git log --brief",
        elided: true,
        raw_bytes: 2000,
        emitted_bytes: 1000,
        tokens_raw: 500,
        tokens_emitted: 250,
        estimated: true,
        wrapper_ms: 100,
        store_open_count: 0,
      });
      await db.kv(RSP_TELEMETRY_DEGRADATIONS_COLLECTION).put("degraded", {
        created_at: "2026-07-08T12:16:00.000Z",
        command: "git --version",
        reason: "wrapper failed",
      });

      const report = await readTelemetryGainsReport(db, 28, new Date("2026-07-10T00:00:00.000Z"));

      expect(report.window).toMatchObject({
        requested_days: 28,
        data_days: 9,
        label: "window: 28d, data: 9d",
        empty: false,
        invocations: 3,
        degradations: 1,
      });
      expect(report.latency.global).toEqual({
        wrapper_ms_p50: 20,
        wrapper_ms_p90: 100,
        wrapper_ms_p95: 100,
        wrapper_ms_p99: 100,
      });
      expect(report.latency.by_command_family).toContainEqual(expect.objectContaining({
        command_family: "git log",
        count: 2,
        wrapper_ms_p50: 10,
        wrapper_ms_p90: 100,
      }));
      expect(report.throughput.requests_per_day).toEqual([
        { date: "2026-07-01", requests: 2 },
        { date: "2026-07-08", requests: 1 },
      ]);
      expect(report.throughput.active_minute_avg).toBe(1.5);
      expect(report.throughput.peak_minute).toEqual({ minute: "2026-07-01T10:00", requests: 2 });
      expect(report.throughput.hour_weekday_heatmap).toContainEqual({ weekday: "wed", hour: 10, requests: 2 });
      expect(report.savings.weekly_tokens_saved).toEqual([
        { week_start: "2026-06-29", tokens_saved: 900, wow_delta_pct: null },
        { week_start: "2026-07-06", tokens_saved: 250, wow_delta_pct: -72.22 },
      ]);
      expect(report.savings.tokens).toMatchObject({
        tokens_saved: 1150,
        tokens_saved_estimated: true,
        tokens_saved_low: 862,
        tokens_saved_high: 1438,
        dollars_saved_estimate_usd: 0.001438,
      });
      expect(report.savings.elision_rate).toBe(0.67);
      expect(report.savings.top_commands_by_tokens_saved[0]).toMatchObject({ command_family: "git log", invocations: 2, tokens_saved: 1150 });
      expect(report.savings.top_commands_by_invocation_count[0]).toMatchObject({ command_family: "git log", invocations: 2 });
      expect(report.savings.single_biggest_elision).toMatchObject({ command_family: "git log", tokens_saved: 900 });
      expect(report.health.degradation_timeline).toEqual([
        { timestamp: "2026-07-08T12:16:00.000Z", command_family: "git --version", reason: "wrapper failed" },
      ]);
      expect(report.health.degradations_by_reason).toEqual([{ reason: "wrapper failed", count: 1 }]);
      expect(report.health).toMatchObject({ cold_boots: 1, warm_hits: 2 });
    } finally {
      await db.close();
    }
  });

  it("renders definitive empty and short-window rsp gains states", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    try {
      await expect(readTelemetryGainsReport(db, 28, new Date("2026-07-10T00:00:00.000Z"))).resolves.toMatchObject({
        window: { requested_days: 28, data_days: 0, label: "window: 28d, data: 0d", empty: true },
        latency: { by_command_family: [] },
        throughput: { requests_per_day: [], active_minute_avg: null, peak_minute: null, hour_weekday_heatmap: [] },
        savings: { weekly_tokens_saved: [], top_commands_by_tokens_saved: [], top_commands_by_invocation_count: [], single_biggest_elision: null },
        health: { degradation_timeline: [], cold_boots: null, warm_hits: null },
      });

      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("fresh", {
        created_at: "2026-07-09T23:00:00.000Z",
        command: "gh pr list",
        raw_bytes: 40,
        emitted_bytes: 40,
        tokens_raw: 10,
        tokens_emitted: 10,
      });
      const short = await readTelemetryGainsReport(db, 28, new Date("2026-07-10T00:00:00.000Z"));
      expect(short.window).toMatchObject({ requested_days: 28, data_days: 1, label: "window: 28d, data: 1d", empty: false });
    } finally {
      await db.close();
    }
  });
});

async function readTelemetry(storeUri: string, collection: string, key: string): Promise<unknown> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).get(key);
    return typeof raw === "string" ? JSON.parse(raw) as unknown : raw;
  } finally {
    await db.close();
  }
}

async function waitForResident(socketPath: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    try {
      const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, { id: `wait-${attempt++}`, op: "ping" });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("resident did not start");
}

async function calibratedTelemetryDrainTimeoutMs(root: string): Promise<number> {
  const baselineUri = `file://${join(root, ".red", "tmp", `telemetry-baseline-${process.pid}.rdb`)}`;
  const started = process.hrtime.bigint();
  const db = await connect(baselineUri);
  await db.close();
  const storeOpenMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return Math.max(2_000, Math.ceil(Math.max(1, storeOpenMs) * 6));
}

async function waitForResidentTelemetry(socketPath: string, command: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    const response = await sendResidentRequest({ socketPath, timeoutMs: 200 }, {
      id: `telemetry-${attempt++}`,
      op: "telemetry-stats",
      sinceDays: 7,
    }).catch(() => null);
    if (
      response?.ok &&
      isRecord(response.value) &&
      isRecord(response.value.savings) &&
      Array.isArray(response.value.savings.top_commands) &&
      response.value.savings.top_commands.some((entry) => isRecord(entry) && entry.command === command)
    ) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`telemetry ${command} did not drain`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function ensureRspBundle(): Promise<string> {
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
