import { describe, expect, it } from "vitest";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import {
  appendTelemetryEventSync,
  takeTelemetrySpool,
} from "../src/telemetry.js";
import {
  appendTelemetryEvent,
  calibratedTelemetryTiming,
  connect,
  DEFAULT_RSP_BYTE_BUDGET,
  DEFAULT_RSP_TTL_DAYS,
  drainTelemetrySpool,
  ensureRspBundle,
  execFile,
  join,
  mkdir,
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
  runResidentServer,
  sendResidentRequest,
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
    expect(
      tokenSavingsEstimate(1_000_000, false, "claude-sonnet-4"),
    ).toMatchObject({
      tokens_saved: 1_000_000,
      dollars_saved_estimate_usd: 3,
      pricing_model_family: "claude-sonnet-4",
      pricing_input_usd_per_million_tokens: 3,
    });
  });

  it("appends TOONL rows without throwing when the target is unavailable", async () => {
    const root = await tempRoot();
    await appendTelemetryEvent(root, {
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: "ok",
      command: "git status",
    });
    await expect(readSpoolRows(root)).resolves.toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ id: "ok", command: "git status" }),
      }),
    ]);

    await writeFile(join(root, ".red", "tmp", "not-a-dir"), "x", "utf8");
    await expect(
      appendTelemetryEvent(join(root, "not-there"), {
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "lost",
      }),
    ).resolves.toBeUndefined();
  });

  it("retries an append whose inode is renamed away during the write", async () => {
    const root = await tempRoot();
    const spool = telemetrySpoolPath(root);
    const draining = `${spool}.999999.1783958744462.drain`;
    let raced = false;

    appendTelemetryEventSync(
      root,
      {
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "rename-race",
        command: "git status",
      },
      undefined,
      {
        afterWrite(path, attempt) {
          if (attempt !== 1) return;
          raced = true;
          renameSync(path, draining);
          writeFileSync(path, "", { mode: 0o600 });
          rmSync(draining);
        },
      },
    );

    expect(raced).toBe(true);
    await expect(readSpoolRows(root)).resolves.toEqual([
      expect.objectContaining({
        event: expect.objectContaining({ id: "rename-race" }),
      }),
    ]);
  });

  it("trims an overflowing spool and corrects the drain with the dropped byte count", async () => {
    const root = await tempRoot();
    const retention = { maxBytes: 1_024 };

    for (let index = 0; index < 12; index += 1) {
      await appendTelemetryEvent(
        root,
        {
          collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
          id: `bounded-${index}`,
          command: `git log ${"x".repeat(120)}`,
        },
        retention,
      );
    }

    const rows = await readSpoolRows(root);
    expect(
      rows.some(
        (row) => row.event && (row.event as { id?: string }).id === "bounded-0",
      ),
    ).toBe(false);
    expect(rows.at(-1)).toMatchObject({ event: { id: "bounded-11" } });
    expect(
      Buffer.byteLength(await readFile(telemetrySpoolPath(root), "utf8")),
    ).toBeLessThanOrEqual(retention.maxBytes);
    await expect(readCorrectionRows(root)).resolves.toContainEqual(
      expect.objectContaining({
        action: "retry",
        event: expect.objectContaining({
          collection: RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
          reason: "telemetry spool retention",
          bytes: expect.any(Number),
        }),
      }),
    );
    const correction = (await readCorrectionRows(root)).find(
      (row) => row.event !== undefined,
    );
    if (correction === undefined)
      throw new Error("no correction row carrying an event was written");
    expect((correction.event as { bytes?: number }).bytes).toBeGreaterThan(0);
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

    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    const corrections = await readCorrectionRows(root);
    expect(corrections).toEqual([
      expect.objectContaining({
        action: "retry",
        event: expect.objectContaining({ id: "retry-me" }),
      }),
    ]);

    const retried: string[] = [];
    await drainTelemetrySpool(root, async (line) => {
      retried.push(line);
      return true;
    });
    expect(retried.join("\n")).toContain('"id":"retry-me"');
    const afterRetry = await readCorrectionRows(root);
    expect(afterRetry.at(-1)).toEqual(
      expect.objectContaining({ action: "resolved" }),
    );
  });

  it("drains legacy JSONL spools by sniffing format without rewriting them", async () => {
    const root = await tempRoot();
    await writeFile(
      telemetryLegacySpoolPath(root),
      `${JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "legacy-jsonl",
        command: "git status",
      })}\n`,
      "utf8",
    );

    const drained: string[] = [];
    await drainTelemetrySpool(root, async (line) => {
      drained.push(line);
      return true;
    });

    expect(drained.join("\n")).toContain('"id":"legacy-jsonl"');
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");
    await expect(
      readFile(telemetryLegacySpoolPath(root), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("applies the legacy spool retention policy before migration drain", async () => {
    const root = await tempRoot();
    await writeFile(
      telemetryLegacySpoolPath(root),
      `${JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "oversized-legacy-jsonl",
        command: "git status",
      })}\n`,
      "utf8",
    );

    const drained = await takeTelemetrySpool(root, {
      legacy: { maxBytes: 0, targetRatio: 0.5 },
    });
    expect(drained.join("\n")).not.toContain("oversized-legacy-jsonl");
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
    await expect(readFile(inFlight, "utf8")).resolves.toContain(
      '"id":"not-mine"',
    );
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
    expect((await readSpoolRows(root))[0]).toMatchObject({
      event: {
        id: "oversized",
        command: "git log",
        raw_bytes: Buffer.byteLength(huge, "utf8"),
        emitted_bytes: Buffer.byteLength(huge, "utf8"),
        estimated: true,
      },
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
    await expect(
      readTelemetry(
        storeUri,
        RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        "boot-event",
      ),
    ).resolves.toMatchObject({
      id: "boot-event",
      command: "git status",
      tokens_raw: expect.any(Number),
      tokens_emitted: expect.any(Number),
      estimated: false,
    });
    await expect(
      readTelemetry(
        storeUri,
        RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
        "idle-event",
      ),
    ).resolves.toMatchObject({
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

    await expect(
      readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "exact"),
    ).resolves.toMatchObject({
      tokens_raw: expect.any(Number),
      tokens_emitted: expect.any(Number),
      estimated: false,
    });
    const estimated = await readTelemetry(
      storeUri,
      RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      "estimated",
    );
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

    await expect(
      readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "expired"),
    ).resolves.toBeNull();
    await expect(
      readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "oldest"),
    ).resolves.toBeNull();
    await expect(
      readTelemetry(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION, "newest"),
    ).resolves.toMatchObject({
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
      reason: "wrapper-crash",
      wrapper_family: "git",
      wrapper_exit_code: 1,
      stderr_head: "unsupported git subcommand:",
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

    const response = await sendResidentRequest(
      { socketPath: paths.socketPath },
      {
        id: "stats",
        op: "telemetry-stats",
        sinceDays: 7,
      },
    );

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
        top_commands: [
          expect.objectContaining({
            command: "git log",
            invocations: 1,
            bytes_saved: 900,
          }),
        ],
      },
      health: {
        degradations: 1,
        degradation_rate: 0.5,
        by_reason: [{ reason: "wrapper-crash", count: 1 }],
        by_family: [{ family: "git", count: 1 }],
        recent_failures: [
          expect.objectContaining({
            family: "git",
            command: "git --version",
            reason: "wrapper-crash",
            exit_code: 1,
            stderr_head: "unsupported git subcommand:",
          }),
        ],
        most_recent: expect.objectContaining({
          reason: "wrapper-crash",
          command: "git --version",
        }),
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

    const response = await sendResidentRequest(
      { socketPath: paths.socketPath },
      {
        id: "stats",
        op: "telemetry-stats",
        sinceDays: 7,
      },
    );

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
    const accountingResponse = await sendResidentRequest(
      { socketPath: paths.socketPath },
      {
        id: "accounting-stats",
        op: "accounting-stats",
        byteBudget: 1_000,
      },
    );
    expect(accountingResponse.ok).toBe(true);
    expect(accountingResponse.ok && accountingResponse.value).toMatchObject({
      storage_classes: {
        derivable: { records: 1, bytes: 1000, raw_bytes: 1000 },
        "re-executable": { records: 0, bytes: 0, raw_bytes: 0 },
        ephemeral: { records: 1, bytes: 400, raw_bytes: 400 },
      },
    });
    await server;
    await expect(
      readTelemetry(
        storeUri,
        RSP_ACCOUNTING_EVENTS_COLLECTION,
        "accounted-invocation",
      ),
    ).resolves.not.toHaveProperty("raw_text");
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
      await db.kv(RSP_DECISIONS_COLLECTION).put("passed-lossless-gh-json-jq", {
        created_at: "2026-07-10T10:01:30.000Z",
        hook: "codex-pre-exec",
        command: "gh pr view 1747 --json number,title",
        command_family: "gh pr view json-jq",
        decision: "passed",
        reason: "lossless-gh-json-jq",
      });
      await db.kv(RSP_DECISIONS_COLLECTION).put("failed-open", {
        created_at: "2026-07-10T10:02:00.000Z",
        hook: "codex-pre-exec",
        command: "unknown",
        command_family: "unknown",
        decision: "failed-open",
        reason: "hook-exception",
      });
      await db.kv(RSP_DECISIONS_COLLECTION).put("quota-free", {
        created_at: "2026-07-10T10:03:00.000Z",
        command: "gh api repos/o/r/issues/1",
        command_family: "gh api",
        decision: "contributed",
        reason: "gh-conditional-304",
        quota_free: true,
        saved_units: 1,
      });

      const stats = await readTelemetryStats(
        db,
        7,
        new Date("2026-07-11T00:00:00.000Z"),
      );

      expect(stats.decisions).toEqual({
        seen: 5,
        contributed: 1,
        passed: 3,
        failed_open: 1,
        quota_free_saved_units: 1,
        contribution_rate: 0.2,
        top_pass_reasons: [
          { reason: "disabled", count: 1 },
          { reason: "hook-exception", count: 1 },
          { reason: "lossless-gh-json-jq", count: 1 },
          { reason: "unsupported-command", count: 1 },
        ],
        // Decision families are read back from the stored `command_family`
        // field, never re-derived — the contribution lane reports whatever key
        // the minting surface recorded.
        by_command_family: [
          {
            command_family: "git status",
            contributed: 0,
            passed: 2,
            failed_open: 0,
            contribution_rate: 0,
          },
          {
            command_family: "gh api",
            contributed: 1,
            passed: 0,
            failed_open: 0,
            contribution_rate: 1,
          },
          {
            command_family: "gh pr view json-jq",
            contributed: 0,
            passed: 1,
            failed_open: 0,
            contribution_rate: 0,
          },
          {
            command_family: "unknown",
            contributed: 0,
            passed: 0,
            failed_open: 1,
            contribution_rate: 0,
          },
        ],
      });
    } finally {
      await db.close();
    }
  });
});
