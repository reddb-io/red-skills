import { chmod } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { commandFamily } from "../src/command-classifier.js";
import {
  appendTelemetryEvent,
  calibratedTelemetryTiming,
  connect,
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_TTL_DAYS,
  drainTelemetrySpool,
  ensureRspBundle,
  execFile,
  execFileAsync,
  fileMtimeMs,
  join,
  mkdir,
  parseStructured,
  readCorrectionRows,
  readFile,
  readSpoolRows,
  readTelemetry,
  readTelemetryCollectionModels,
  readTelemetryGainsReport,
  readTelemetryRecords,
  readTelemetryStats,
  resolveResidentPaths,
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_ELISION_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INDEX_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  sendResidentRequest,
  runResidentServer,
  shutdownResident,
  spawnSync,
  telemetryLegacySpoolPath,
  telemetrySpoolCorrectionsPath,
  telemetrySpoolPath,
  tempRoot,
  tokenSavingsEstimate,
  waitForResident,
  waitForResidentTelemetry,
  waitForStatusSummary,
  writeFile,
} from "./telemetry.helpers.js";

describe("rsp telemetry spool", () => {
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
    const env = await envWithRsp(root);
    const payload = {
      cwd: root,
      tool_name: "bash",
      tool_input: { command: "git status" },
    };

    const hook = spawnSync(process.execPath, [bundle, "hook", "codex-pre-exec"], {
      cwd: root,
      env,
      input: Buffer.from(JSON.stringify(payload)),
      encoding: "buffer",
    });
    expect(hook.status, `${hook.stdout.toString("utf8")}${hook.stderr.toString("utf8")}`).toBe(0);
    expect(JSON.parse(hook.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: `${process.execPath} ${bundle} proxy -- 'git status'` },
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
      reason: "universal-proxy",
      capability_id: "proxy:universal",
    }));
    const summary = parseStructured(await readFile(paths.summaryPath, "utf8")) as {
      decisions?: { seen?: number; contributed?: number };
    };
    expect(summary.decisions).toEqual({ seen: 1, contributed: 1 });
  }, 40_000);

  it("routes a real Codex PreToolUse payload through the built bundle proxy and executes verbatim", async () => {
    const root = await tempRoot();
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n  proxy:\n    enabled: true\n", "utf8");
    const bundle = await ensureRspBundle();
    const env = await envWithRsp(root);
    const command = "printf 'out\\n'; printf 'err\\n' >&2";
    const payload = {
      cwd: root,
      tool_name: "bash",
      tool_input: { command },
    };

    const hook = spawnSync(process.execPath, [bundle, "hook", "codex-pre-exec"], {
      cwd: root,
      env,
      input: Buffer.from(JSON.stringify(payload)),
      encoding: "buffer",
    });
    expect(hook.status, `${hook.stdout.toString("utf8")}${hook.stderr.toString("utf8")}`).toBe(0);
    const updated = JSON.parse(hook.stdout.toString("utf8")) as {
      hookSpecificOutput: { updatedInput: { command: string } };
    };
    expect(updated.hookSpecificOutput.updatedInput.command).toBe(
      `${process.execPath} ${bundle} proxy -- 'printf '\\''out\\n'\\''; printf '\\''err\\n'\\'' >&2'`,
    );

    const raw = spawnSync(command, { cwd: root, shell: true, encoding: "buffer" });
    const proxied = spawnSync(process.execPath, [bundle, "proxy", "--", command], {
      cwd: root,
      encoding: "buffer",
    });

    expect(proxied.stdout).toEqual(raw.stdout);
    expect(proxied.stderr).toEqual(raw.stderr);
    expect(proxied.status).toBe(raw.status);
    expect(proxied.signal).toBe(raw.signal);
    await expect(readSpoolRows(root)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: expect.objectContaining({ reason: "universal-proxy" }),
        }),
      ]),
    );
  }, 40_000);

  it("self-heals old-model rsp collections in the built bundle resident with clean elision cutover", async () => {
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
      value: null,
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

    const degraded = spawnSync(process.execPath, [bundle, "--store-uri", storeUri, "show", legacyHandle], {
      cwd: root,
      encoding: "utf8",
    });
    expect(degraded.status).toBe(1);
    expect(degraded.stdout).toContain("category: real-error");
    expect(degraded.stdout).toContain("error: expired unknown");
    expect(degraded.stdout).toContain(`help[1]: "${legacyHandle}"`);
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
    expect(stdout).toContain("top_commands[1]{command,invocations,bytes_saved,tokens_saved}:");
    expect(stdout).toContain("git log --terse,1,900,225");

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
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("holdout-one", {
        created_at: "2026-07-08T12:17:00.000Z",
        command: "git log --brief",
        event_type: "control_holdout",
        control_holdout: true,
        holdout_share: 0.1,
        raw_bytes: 2400,
        emitted_bytes: 2400,
        tokens_raw: 600,
        tokens_emitted: 600,
      });
      await db.kv(RSP_ACCOUNTING_EVENTS_COLLECTION).put("show-git-log", {
        created_at: "2026-07-08T12:18:00.000Z",
        event_type: "show",
        command: "rsp show",
        recovered_command: "git log --brief",
        hit: true,
        raw_bytes: 1000,
        emitted_bytes: 1000,
      });
      await db.kv(RSP_TELEMETRY_DEGRADATIONS_COLLECTION).put("degraded", {
        created_at: "2026-07-08T12:16:00.000Z",
        command: "git --version",
        reason: "wrapper failed",
      });
      await db.kv(RSP_TELEMETRY_DEGRADATIONS_COLLECTION).put("degraded-two", {
        created_at: "2026-07-08T12:19:00.000Z",
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
        degradations: 2,
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
      expect(report.savings.measured_control_holdout).toMatchObject({
        enabled: true,
        holdout_share: 0.1,
        holdout_invocations: 1,
        compressed_invocations: 3,
        savings_rate: expect.any(Number),
        confidence_interval_95: { low: expect.any(Number), high: expect.any(Number) },
      });
      expect(report.mining.recovery_usage_by_family).toEqual([
        { command_family: "git log", show_total: 1, show_hits: 1, show_misses: 0, show_hit_rate: 1 },
      ]);
      expect(report.mining.degradation_clusters).toEqual([
        expect.objectContaining({
          command_family: "git --version",
          reason: "wrapper failed",
          count: 2,
          suggestion: expect.stringContaining("Investigate"),
        }),
      ]);
      expect(report.mining.threshold_tuning_suggestions.length).toBeGreaterThan(0);
      expect(report.health.degradation_timeline).toEqual([
        { timestamp: "2026-07-08T12:16:00.000Z", command_family: "git --version", reason: "wrapper failed" },
        { timestamp: "2026-07-08T12:19:00.000Z", command_family: "git --version", reason: "wrapper failed" },
      ]);
      expect(report.health.degradations_by_reason).toEqual([{ reason: "wrapper failed", count: 2 }]);
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

  // Wired smoke for the telemetry surface of the shared command classifier
  // (#2659): reports no longer keeps its own gh-blind copy, so a gh json/jq
  // invocation aggregates under the same key the hook and proxy record.
  it("aggregates gh json/jq invocations under the shared command_family key", async () => {
    const root = await tempRoot();
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    try {
      const command = "gh pr list --json number,title --jq '.[0]'";
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("gh-json-jq", {
        created_at: "2026-07-09T23:00:00.000Z",
        command,
        elided: true,
        raw_bytes: 4000,
        emitted_bytes: 400,
        tokens_raw: 1000,
        tokens_emitted: 100,
        wrapper_ms: 12,
      });

      const report = await readTelemetryGainsReport(db, 28, new Date("2026-07-10T00:00:00.000Z"));
      expect(report.savings.top_commands_by_tokens_saved[0]).toMatchObject({
        command_family: commandFamily(command),
      });
      expect(report.savings.top_commands_by_tokens_saved[0]?.command_family).toBe("gh pr list json-jq");
    } finally {
      await db.close();
    }
  });
});

async function envWithRsp(root: string): Promise<NodeJS.ProcessEnv> {
  const binDir = join(root, "bin");
  const rsp = join(binDir, "rsp");
  await mkdir(binDir, { recursive: true });
  await writeFile(rsp, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(rsp, 0o755);
  return { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` };
}
