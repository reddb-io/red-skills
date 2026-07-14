import { execFile, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
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
  readTelemetryStats,
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  telemetrySpoolPath,
} from "../src/telemetry.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS, RSP_ELISION_COLLECTION } from "../src/elision-store.js";
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
  await Promise.all(roots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 50,
  })));
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

  it("ingests orphaned .drain files left behind by a crashed drain", async () => {
    const root = await tempRoot();
    const spool = telemetrySpoolPath(root);
    const orphan = `${spool}.999999.1783958744462.drain`;
    await writeFile(
      orphan,
      `${JSON.stringify({ collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION, id: "orphaned", command: "git log" })}\n`,
      "utf8",
    );
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "live",
      command: "git status",
    });

    const drained: string[] = [];
    await drainTelemetrySpool(root, async (line) => {
      drained.push(line);
      return true;
    });

    expect(drained.join("\n")).toContain('"id":"orphaned"');
    expect(drained.join("\n")).toContain('"id":"live"');
    await expect(readFile(orphan, "utf8")).rejects.toThrow();
  });

  it("sweeps orphaned .drain files even when the live spool is gone, and leaves live-owner drains alone", async () => {
    const root = await tempRoot();
    const spool = telemetrySpoolPath(root);
    const orphan = `${spool}.999999.1783958744462.drain`;
    const inFlight = `${spool}.${process.ppid}.1783958744463.drain`;
    await writeFile(
      orphan,
      `${JSON.stringify({ collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION, id: "orphaned", command: "git log" })}\n`,
      "utf8",
    );
    await writeFile(
      inFlight,
      `${JSON.stringify({ collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION, id: "not-mine", command: "git log" })}\n`,
      "utf8",
    );

    const drained: string[] = [];
    await drainTelemetrySpool(root, async (line) => {
      drained.push(line);
      return true;
    });

    expect(drained.join("\n")).toContain('"id":"orphaned"');
    expect(drained.join("\n")).not.toContain('"id":"not-mine"');
    await expect(readFile(inFlight, "utf8")).resolves.toContain('"id":"not-mine"');
  });

  it("keeps oversized raw and emitted text out of the spool while preserving byte estimates", async () => {
    const root = await tempRoot();
    const huge = "x".repeat(300 * 1024);

    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "oversized",
      command: "git log",
      raw_text: huge,
      emitted_text: huge,
    });

    const spool = await readFile(telemetrySpoolPath(root), "utf8");
    expect(spool).not.toContain(huge);
    expect(JSON.parse(spool)).toMatchObject({
      id: "oversized",
      command: "git log",
      raw_bytes: Buffer.byteLength(huge, "utf8"),
      emitted_bytes: Buffer.byteLength(huge, "utf8"),
      estimated: true,
    });
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
    const timing = await calibratedTelemetryTiming(root);
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      telemetryDrainTimeoutMs: timing.drainTimeoutMs,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);

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
  }, 60_000);

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
    const timing = await calibratedTelemetryTiming(root);
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000_000,
      telemetryDrainTimeoutMs: timing.drainTimeoutMs,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
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
  }, 60_000);

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
    const timing = await calibratedTelemetryTiming(root);
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 1,
      telemetryByteBudget: 75,
      telemetryDrainTimeoutMs: timing.drainTimeoutMs,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    await server;

    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "expired")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "oldest")).resolves.toBeNull();
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "newest")).resolves.toMatchObject({
      id: "newest",
    });
  }, 60_000);

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
    const timing = await calibratedTelemetryTiming(root);
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      telemetryDrainTimeoutMs: timing.drainTimeoutMs,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);

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
  }, 60_000);

  it("serves stats from counters-only accounting events and reports show hit-rate", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      id: "accounted-invocation",
      created_at: new Date().toISOString(),
      event_type: "invocation",
      command: "git log",
      command_class: "git",
      loss: "terse",
      elided: true,
      raw_bytes: 1000,
      emitted_bytes: 100,
      bytes: 120,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      id: "accounted-ephemeral",
      created_at: new Date().toISOString(),
      event_type: "invocation",
      command: "vitest run",
      command_class: "vitest",
      loss: "terse",
      elided: true,
      raw_bytes: 400,
      emitted_bytes: 40,
      bytes: 90,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      id: "show-hit",
      created_at: new Date().toISOString(),
      event_type: "show",
      command: "rsp show",
      command_class: "show",
      hit: true,
      raw_bytes: 900,
      emitted_bytes: 900,
      bytes: 80,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_ACCOUNTING_EVENTS_COLLECTION,
      id: "show-miss",
      created_at: new Date().toISOString(),
      event_type: "show",
      command: "rsp show",
      command_class: "show",
      hit: false,
      raw_bytes: 0,
      emitted_bytes: 40,
      bytes: 80,
    });
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "legacy-ignored",
      created_at: new Date().toISOString(),
      command: "git status",
      raw_bytes: 9999,
      emitted_bytes: 1,
      accounting_recorded: true,
      bytes: 100,
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const timing = await calibratedTelemetryTiming(root);
    const server = runResidentServer({
      rootDir: root,
      socketPath: paths.socketPath,
      storeUri,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      telemetryTtlDays: 90,
      telemetryByteBudget: 1_000,
      telemetryDrainTimeoutMs: timing.drainTimeoutMs,
      idleMs: 100,
    });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);

    const response = await sendResidentRequest({ socketPath: paths.socketPath }, {
      id: "stats",
      op: "telemetry-stats",
      sinceDays: 7,
    });

    expect(response.ok).toBe(true);
    expect(response.ok && response.value).toMatchObject({
      savings: {
        invocations: 2,
        elided: 2,
        raw_bytes: 1400,
        emitted_bytes: 140,
        top_commands: [
          expect.objectContaining({ command: "git log", invocations: 1 }),
          expect.objectContaining({ command: "vitest run", invocations: 1 }),
        ],
      },
      health: {
        show_total: 2,
        show_hits: 1,
        show_misses: 1,
        show_hit_rate: 0.5,
      },
    });
    const accountingResponse = await sendResidentRequest({ socketPath: paths.socketPath }, {
      id: "accounting-stats",
      op: "accounting-stats",
      byteBudget: 1_000,
    });
    expect(accountingResponse.ok).toBe(true);
    expect(accountingResponse.ok && accountingResponse.value).toMatchObject({
      storage_classes: {
        derivable: { records: 1, bytes: 1000 },
        "re-executable": { records: 0, bytes: 0 },
        ephemeral: { records: 1, bytes: 400 },
      },
    });
    await server;
    await expect(readTelemetry(storeUri, RSP_ACCOUNTING_EVENTS_COLLECTION, "accounted-invocation")).resolves.not.toHaveProperty("raw_text");
  }, 60_000);

  it("computes contribution-rate stats from the dedicated decision lane", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    try {
      await db.kv(RSP_DECISIONS_COLLECTION).put("passed-disabled", {
        created_at: "2026-07-10T10:00:00.000Z",
        hook: "codex-pre-exec",
        command: "git status",
        command_family: "git status",
        decision: "passed",
        reason: "disabled",
      });
      await db.kv(RSP_DECISIONS_COLLECTION).put("passed-unsupported", {
        created_at: "2026-07-10T10:01:00.000Z",
        hook: "codex-pre-exec",
        command: "git status --short",
        command_family: "git status",
        decision: "passed",
        reason: "unsupported-command",
      });
      await db.kv(RSP_DECISIONS_COLLECTION).put("failed-open", {
        created_at: "2026-07-10T10:02:00.000Z",
        hook: "codex-pre-exec",
        command: "unknown",
        command_family: "unknown",
        decision: "failed-open",
        reason: "hook-exception",
      });

      const stats = await readTelemetryStats(db, 7, new Date("2026-07-11T00:00:00.000Z"));

      expect(stats.decisions).toEqual({
        seen: 3,
        contributed: 0,
        passed: 2,
        failed_open: 1,
        contribution_rate: 0,
        top_pass_reasons: [
          { reason: "disabled", count: 1 },
          { reason: "hook-exception", count: 1 },
          { reason: "unsupported-command", count: 1 },
        ],
      });
    } finally {
      await db.close();
    }
  });

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
    const timing = await calibratedTelemetryTiming(root);
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
      String(timing.drainTimeoutMs),
      "--idle-ms",
      "100",
    ], { cwd: root });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
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

  it("pipes a real Codex PreToolUse payload through the built bundle and drains a decision event", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const payload = {
      cwd: root,
      tool_name: "bash",
      tool_input: { command: "git status" },
    };

    const hook = spawnSync(process.execPath, [bundle, "hook", "codex-pre-exec"], {
      cwd: root,
      input: Buffer.from(JSON.stringify(payload)),
      encoding: "buffer",
    });
    expect(hook.status, `${hook.stdout.toString("utf8")}${hook.stderr.toString("utf8")}`).toBe(0);
    expect(JSON.parse(hook.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "rsp git status" },
      },
    });

    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const timing = await calibratedTelemetryTiming(root);
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
      String(timing.drainTimeoutMs),
      "--idle-ms",
      "100",
    ], { cwd: root });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`bundle resident exited ${code}`)));
      child.once("error", reject);
    });

    const decisions = await readTelemetryRecords(storeUri, RSP_DECISIONS_COLLECTION);
    expect(decisions).toContainEqual(expect.objectContaining({
      hook: "codex-pre-exec",
      command: "git status",
      command_family: "git status",
      decision: "contributed",
      reason: "matched-capability",
      capability_id: "git:status",
    }));
  }, 40_000);

  it("self-heals old-model rsp collections in the built bundle resident without losing elisions", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const legacyHandle = "el:123456789abc";
    const legacyRecord = {
      collection: RSP_ELISION_COLLECTION,
      handle: legacyHandle,
      original: Buffer.from("legacy recoverable elision").toString("base64"),
      original_encoding: "base64",
      original_bytes: Buffer.byteLength("legacy recoverable elision"),
      command: "git diff --stat",
      created_at: "2026-07-13T12:00:00.000Z",
      expires_at: "2026-07-20T12:00:00.000Z",
      loss: { level: "terse", bytes_elided: 27 },
    };
    const seeded = await connect(storeUri);
    try {
      await seeded.query(`CREATE TABLE ${RSP_ELISION_COLLECTION} (record_key TEXT, value JSON)`);
      await seeded.query(
        `INSERT INTO ${RSP_ELISION_COLLECTION} (record_key, value) VALUES ($1, $2)`,
        "record:123456789abc",
        legacyRecord,
      );
      await seeded.query(`CREATE TABLE ${RSP_DECISIONS_COLLECTION} (id TEXT)`);
      await seeded.query(`CREATE TABLE ${RSP_TELEMETRY_INVOCATIONS_COLLECTION} (id TEXT)`);
      await seeded.query(`CREATE TABLE ${RSP_TELEMETRY_DEGRADATIONS_COLLECTION} (id TEXT)`);
      await seeded.query(`CREATE TABLE ${RSP_TELEMETRY_INDEX_COLLECTION} (id TEXT)`);
    } finally {
      await seeded.close();
    }

    await writeFile(telemetrySpoolPath(root), [
      JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "legacy-model-event",
        command: "git log",
      }),
      JSON.stringify({
        collection: RSP_DECISIONS_COLLECTION,
        id: "legacy-decision-event",
        command: "git status",
        decision: "contributed",
        reason: "matched-capability",
      }),
      "",
    ].join("\n"), "utf8");

    const paths = resolveResidentPaths(root);
    const timing = await calibratedTelemetryTiming(root);
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
      String(timing.drainTimeoutMs),
      "--idle-ms",
      "100",
    ], { cwd: root });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);
    await expect(sendResidentRequest(
      { socketPath: paths.socketPath, timeoutMs: 1_000 },
      { id: "recover-legacy-elision", op: "get", handle: legacyHandle },
    )).resolves.toMatchObject({
      ok: true,
      value: expect.objectContaining({
        handle: legacyHandle,
        original: Buffer.from("legacy recoverable elision").toString("base64"),
        original_encoding: "base64",
      }),
    });
    await new Promise<void>((resolve, reject) => {
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`bundle resident exited ${code}`)));
      child.once("error", reject);
    });

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "legacy-model-event")).resolves.toMatchObject({
      id: "legacy-model-event",
      command: "git log",
    });
    await expect(readTelemetry(storeUri, RSP_DECISIONS_COLLECTION, "legacy-decision-event")).resolves.toMatchObject({
      id: "legacy-decision-event",
      command: "git status",
      decision: "contributed",
    });
    await expect(readTelemetryRecords(storeUri, RSP_TELEMETRY_DEGRADATIONS_COLLECTION)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          reason: "telemetry collection model mismatch",
          source_collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        }),
      ]),
    );
    await expect(readTelemetryCollectionModels(storeUri)).resolves.toMatchObject({
      [RSP_ELISION_COLLECTION]: "kv",
      [RSP_DECISIONS_COLLECTION]: "kv",
      [RSP_TELEMETRY_INVOCATIONS_COLLECTION]: "kv",
      [RSP_TELEMETRY_DEGRADATIONS_COLLECTION]: "kv",
      [RSP_TELEMETRY_INDEX_COLLECTION]: "kv",
    });
  }, 40_000);

  it("periodically drains telemetry spooled while the built bundle resident is alive and reports stats", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const timing = await calibratedTelemetryTiming(root);
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
      String(timing.drainTimeoutMs),
      "--idle-ms",
      "2000",
      "--telemetry-drain-interval-ms",
      "50",
    ], { cwd: root });
    await waitForResident(paths.socketPath, timing.waitTimeoutMs);

    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "periodic-event",
      command: "git log --terse",
      elided: true,
      raw_bytes: 1000,
      emitted_bytes: 100,
      wrapper_ms: 5,
    });

    await waitForResidentTelemetry(paths.socketPath, "git log --terse", timing.waitTimeoutMs);
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

  it("nudges the built bundle resident after cold-path-only telemetry gets stale", async () => {
    const root = await tempRoot();
    const bundle = await ensureRspBundle();
    const paths = resolveResidentPaths(root);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const timing = await calibratedTelemetryTiming(root);
    const staleCreatedAt = new Date(Date.now() - 60_000).toISOString();
    const summaryMtimeBefore = await fileMtimeMs(paths.summaryPath);
    await writeFile(telemetrySpoolPath(root), `${JSON.stringify({
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "stale-cold-event",
      created_at: staleCreatedAt,
      ts: staleCreatedAt,
      command: "git log --terse",
      elided: true,
      raw_bytes: 1000,
      emitted_bytes: 100,
      raw_text: "alpha ".repeat(100),
      emitted_text: "alpha",
    })}\n`, "utf8");

    try {
      const { stdout } = await execFileAsync(process.execPath, [
        bundle,
        "cat",
        ".red/config.yaml",
      ], {
        cwd: root,
        env: {
          ...process.env,
          RSP_STORE_URI: storeUri,
          RSP_TELEMETRY_DRAIN_INTERVAL_MS: "50",
          RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(timing.drainTimeoutMs),
        },
      });
      expect(stdout).toContain("rsp:");

      await waitForResidentTelemetry(paths.socketPath, "git log --terse", timing.waitTimeoutMs);
      await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
      await waitForStatusSummary(paths.summaryPath, summaryMtimeBefore, timing.waitTimeoutMs);
    } finally {
      await shutdownResident(paths.socketPath);
    }
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

async function readTelemetryRecords(storeUri: string, collection: string): Promise<unknown[]> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).list({ limit: 1000 });
    return raw.items.map((entry) => typeof entry.value === "string" ? JSON.parse(entry.value) as unknown : entry.value);
  } finally {
    await db.close();
  }
}

async function readTelemetryCollectionModels(storeUri: string): Promise<Record<string, string>> {
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

async function calibratedTelemetryTiming(root: string): Promise<TelemetryTiming> {
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

async function waitForResident(socketPath: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

async function waitForResidentTelemetry(socketPath: string, command: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
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

async function waitForStatusSummary(summaryPath: string, minMtimeMs = 0, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [summary, mtimeMs] = await Promise.all([
      readFile(summaryPath, "utf8").catch(() => ""),
      fileMtimeMs(summaryPath),
    ]);
    if (summary.includes("tokens_saved_today") && mtimeMs > minMtimeMs) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("rsp status summary did not refresh");
}

async function fileMtimeMs(path: string): Promise<number> {
  return await stat(path).then((s) => s.mtimeMs, () => 0);
}

async function shutdownResident(socketPath: string): Promise<void> {
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
