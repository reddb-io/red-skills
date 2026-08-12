import { describe, expect, it } from "vitest";
import {
  RSP_ACCOUNTING_EVENTS_COLLECTION,
  RSP_DECISIONS_COLLECTION,
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  RspElisionStore,
  budgetSample,
  buildBundleOnce,
  bundle,
  closeWithTimeout,
  commitMany,
  connect,
  countTrackedResidentProcesses,
  decode,
  dirname,
  enableRsp,
  expectLatencyBudget,
  expectWarmResident,
  extractHandle,
  fakeGhPath,
  initGitRepo,
  isRecord,
  join,
  localBaselineRatio,
  median,
  mkdir,
  normalizedDurationMs,
  normalizedLatencyRatio,
  normalizedTimeoutMs,
  parseStructured,
  randomUUID,
  readFile,
  readPid,
  readResidentVersion,
  readSpoolEvents,
  readTelemetryRecords,
  readdir,
  resolveResidentPaths,
  rm,
  runBundleCodexHookFromCwd,
  runBundleFromCwd,
  runBundleFromCwdAsync,
  runBundleHookFromCwd,
  runGit,
  runMcpRequests,
  runNodeNoop,
  runRsp,
  runRspFromCwd,
  runShellFromCwd,
  seedWarmRedCache,
  sendResidentRequest,
  shellQuote,
  spawn,
  startHungOldResident,
  stat,
  stopTrackedResidents,
  telemetrySpoolPath,
  tempRoot,
  timedStatus,
  trackedResidentPaths,
  tsxLoader,
  waitForActiveWait,
  waitForGone,
  waitForResidentReady,
  waitForResidentSocket,
  waitForSummaryTokens,
  waitForTelemetryInvocations,
  writeFile,
  cli,
} from "./cli.helpers.js";

describe("rsp cli", () => {
  it("built bundle preserves rsp exec redirects and structures failing command errors", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });

    const redirected = runBundleFromCwd(root, ["exec", "--", "printf 'redirected\\n' > out.txt"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
    });

    expect(redirected.status).toBe(0);
    expect(redirected.stdout).toEqual(Buffer.alloc(0));
    expect(redirected.stderr).toEqual(Buffer.alloc(0));
    await expect(readFile(join(root, "out.txt"), "utf8")).resolves.toBe("redirected\n");

    const failingCommand = `${shellQuote(process.execPath)} -e "process.stderr.write('bad\\\\n'); process.exit(7)"`;
    const direct = runShellFromCwd(root, failingCommand);
    const failing = runBundleFromCwd(root, ["exec", "--", failingCommand], { RED_SKILLS_CACHE_DIR: cacheDir });
    const decoded = decode(failing.stdout.toString("utf8")) as { category: string; error: string; help: string[] };

    expect(failing.status).toBe(1);
    expect(direct.status).toBe(7);
    expect(failing.stderr).toEqual(direct.stderr);
    expect(decoded).toMatchObject({ category: "real-error", error: "bad", help: [`${failingCommand} --help`] });
  }, 120_000);

  it("built bundle records invocation and degradation telemetry through the resident", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const resident = runBundleFromCwdAsync(root, ["server", "--idle-ms", "1000"], { RED_SKILLS_CACHE_DIR: cacheDir });
    await waitForResidentSocket(root);
    await waitForResidentReady(root);

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    const fastStatus = runBundleFromCwd(root, ["git", "status"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(fastStatus.status).toBe(0);
    expect(fastStatus.stderr).toEqual(Buffer.alloc(0));
    const residentResult = await resident;
    expect(residentResult.status, `${residentResult.stdout.toString("utf8")}${residentResult.stderr.toString("utf8")}`).toBe(0);

    const degradedResident = runBundleFromCwdAsync(root, ["server", "--idle-ms", "1000"], { RED_SKILLS_CACHE_DIR: cacheDir });
    await waitForResidentSocket(root);
    await waitForResidentReady(root);
    const degradedArgs: string[] = [];
    const degraded = runBundleFromCwd(root, ["git", ...degradedArgs], { RED_SKILLS_CACHE_DIR: cacheDir });
    const direct = runGit(degradedArgs);
    expect(degraded.status).toBe(direct.status);
    expect(degraded.stdout).toEqual(direct.stdout);
    expect(degraded.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${direct.stderr.toString("utf8")}`);
    const degradedResidentResult = await degradedResident;
    expect(
      degradedResidentResult.status,
      `${degradedResidentResult.stdout.toString("utf8")}${degradedResidentResult.stderr.toString("utf8")}`,
    ).toBe(0);

    const invocations = await readTelemetryRecords(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION);
    const invocation = invocations.find((record) => isRecord(record) && record.command === "git log");
    expect(invocation).toMatchObject({
      command: "git log",
      wrapper: "git",
      loss: "terse",
      elided: true,
      raw_bytes: expect.any(Number),
      emitted_bytes: compressed.stdout.length,
      wrapper_ms: expect.any(Number),
      store_open_count: expect.any(Number),
      store_elapsed_ms: expect.any(Number),
      tokens_raw: expect.any(Number),
      tokens_emitted: expect.any(Number),
      estimated: false,
    });
    expect(invocations).toContainEqual(expect.objectContaining({
      command: "git status",
      wrapper: "git",
      loss: "lossless",
      elided: false,
      emitted_bytes: fastStatus.stdout.length,
      wrapper_ms: expect.any(Number),
    }));

    const degradations = await readTelemetryRecords(storeUri, RSP_TELEMETRY_DEGRADATIONS_COLLECTION);
    expect(degradations).toContainEqual(expect.objectContaining({
      command: "git",
      reason: "wrapper-crash",
      wrapper_family: "git",
      wrapper_exit_code: 1,
      stderr_head: "unsupported git subcommand:",
    }));

    const stats = runBundleFromCwd(root, ["stats", "--since", "7d", "--full"], { RED_SKILLS_CACHE_DIR: cacheDir });
    const statsText = stats.stdout.toString("utf8");
    const statsPayload = decode(statsText) as {
      records: number;
      savings: {
        window_days: number;
        invocations: number;
        elided: number;
        raw_bytes: number;
        emitted_bytes: number;
        tokens_saved: number;
        tokens_saved_display: string;
        dollars_saved_estimate_usd_display: string;
        pricing_model_family: string;
        top_commands: Array<{ command: string }>;
      };
      health: {
        degradations: number;
        degradation_rate_display: string;
        most_recent_degradation_reason: string;
        by_reason: Array<{ reason: string; count: number }>;
        by_family: Array<{ family: string; count: number }>;
        recent_failures: Array<{ family: string; command: string; reason: string; exit_code: number; stderr_head: string }>;
      };
      latency: { wrapper_ms_p50: number; wrapper_ms_p95: number };
    };
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsPayload.records).toBe(3);
    expect(statsPayload.savings.window_days).toBe(7);
    expect(statsPayload.savings.invocations).toBeGreaterThan(0);
    expect(statsPayload.savings.elided).toBe(1);
    expect(statsPayload.savings.raw_bytes).toBeGreaterThan(0);
    expect(statsPayload.savings.emitted_bytes).toBeGreaterThan(0);
    expect(statsPayload.savings.tokens_saved_display).toMatch(/(?:[1-9]\d*|[1-9]\d*-[1-9]\d* .*)/);
    expect(statsPayload.savings.dollars_saved_estimate_usd_display).toContain("$");
    expect(statsPayload.savings.pricing_model_family).toBe("gpt-5");
    expect(statsPayload.savings.top_commands).toContainEqual(expect.objectContaining({ command: "git log" }));
    expect(statsPayload.health.degradations).toBe(1);
    expect(statsPayload.health.degradation_rate_display).toBe("0.3333");
    expect(statsPayload.health.most_recent_degradation_reason).toBe("wrapper-crash");
    expect(statsPayload.health.by_reason).toContainEqual({ reason: "wrapper-crash", count: 1 });
    expect(statsPayload.health.by_family).toContainEqual({ family: "git", count: 1 });
    expect(statsPayload.health.recent_failures).toContainEqual(expect.objectContaining({
      family: "git",
      command: "git",
      reason: "wrapper-crash",
      exit_code: 1,
      stderr_head: "unsupported git subcommand:",
    }));
    expect(statsPayload.latency.wrapper_ms_p50).toEqual(expect.any(Number));
    expect(statsPayload.latency.wrapper_ms_p95).toEqual(expect.any(Number));
  }, 120_000);

  it("built bundle renders rsp gains TOON from synthetic telemetry", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    const recent = Date.now() - 24 * 60 * 60 * 1_000;
    try {
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("big", {
        created_at: new Date(recent).toISOString(),
        command: "git log --terse",
        elided: true,
        raw_bytes: 8000,
        emitted_bytes: 800,
        tokens_raw: 2000,
        tokens_emitted: 200,
        estimated: true,
        wrapper_ms: 15,
        store_open_count: 1,
      });
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("small", {
        created_at: new Date(recent + 60_000).toISOString(),
        command: "gh pr list --brief",
        elided: false,
        raw_bytes: 200,
        emitted_bytes: 200,
        tokens_raw: 50,
        tokens_emitted: 50,
        wrapper_ms: 40,
        store_open_count: 0,
      });
      await db.kv(RSP_TELEMETRY_DEGRADATIONS_COLLECTION).put("down", {
        created_at: new Date(recent + 120_000).toISOString(),
        command: "git --version",
        reason: "store not provisioned",
      });
    } finally {
      await db.close();
    }

    const res = runBundleFromCwd(root, ["gains", "--since", "28d"], { RED_SKILLS_CACHE_DIR: cacheDir });
    const text = res.stdout.toString("utf8");
    expect(res.status, `${text}${res.stderr.toString("utf8")}`).toBe(0);
    expect(text).toContain("schema_version: red.rsp.gains.v1");
    expect(text).toContain("latency:");
    expect(text).toContain("throughput:");
    expect(text).toContain("savings:");
    expect(text).toContain("health:");
    expect(text).toContain("top_commands_by_tokens_saved");
    expect(text).not.toContain("{\n");
    const decoded = decode(text) as {
      window: { requested_days: number; invocations: number; degradations: number };
      savings: {
        tokens: { tokens_saved_low: number; tokens_saved_high: number; dollars_saved_estimate_usd: number };
        single_biggest_elision: { command_family: string; tokens_saved: number };
      };
    };
    expect(decoded.window.requested_days).toBe(28);
    expect(decoded.window.invocations).toBe(2);
    expect(decoded.window.degradations).toBe(1);
    expect(decoded.savings.tokens).toMatchObject({ tokens_saved_low: 1350, tokens_saved_high: 2250, dollars_saved_estimate_usd: 0.00225 });
    expect(decoded.savings.single_biggest_elision).toMatchObject({ command_family: "git log", tokens_saved: 1800 });
  }, 120_000);

  it("built bundle drains raw-text telemetry without losing the trailing event", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await enableRsp(root);
    const cacheDir = await seedWarmRedCache();
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };
    const setup = runBundleFromCwd(root, ["setup"], env);
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    const now = new Date().toISOString();
    await mkdir(dirname(telemetrySpoolPath(root)), { recursive: true });
    await writeFile(telemetrySpoolPath(root), [
      JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "leading",
        created_at: now,
        command: "git status",
        elided: false,
        raw_bytes: 80,
        emitted_bytes: 80,
        wrapper_ms: 1,
      }),
      "{not-json",
      JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "raw-text",
        created_at: now,
        command: "git log --terse",
        elided: true,
        raw_bytes: 1200,
        emitted_bytes: 120,
        raw_text: "alpha beta gamma delta epsilon zeta eta theta iota kappa",
        emitted_text: "alpha beta",
        wrapper_ms: 2,
      }),
      JSON.stringify({
        collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
        id: "trailing",
        created_at: now,
        command: "gh pr list",
        elided: false,
        raw_bytes: 200,
        emitted_bytes: 200,
        wrapper_ms: 3,
      }),
      "",
    ].join("\n"), "utf8");

    const child = spawn(process.execPath, [
      bundle,
      "server",
      "--idle-ms",
      "250",
      "--telemetry-drain-interval-ms",
      "50",
    ], {
      cwd: root,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    const status = await closeWithTimeout(child, normalizedDurationMs(5_000));
    expect(status, `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`).toBe(0);
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toBe("");

    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const invocations = await readTelemetryRecords(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION);
    expect(invocations).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "leading", command: "git status" }),
      expect.objectContaining({
        id: "raw-text",
        command: "git log --terse",
        tokens_raw: expect.any(Number),
        tokens_emitted: expect.any(Number),
      }),
      expect.objectContaining({ id: "trailing", command: "gh pr list" }),
    ]));
    const degradations = await readTelemetryRecords(storeUri, RSP_TELEMETRY_DEGRADATIONS_COLLECTION);
    expect(degradations).toContainEqual(expect.objectContaining({ reason: "telemetry parse failed" }));

    const stats = runBundleFromCwd(root, ["stats", "--since", "7d", "--full"], env);
    const statsText = stats.stdout.toString("utf8");
    const statsPayload = decode(statsText) as {
      savings: {
        invocations: number;
        tokens_saved: number;
        top_commands: Array<{ command: string; invocations: number }>;
      };
      health: { degradations: number };
    };
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsPayload.savings.invocations).toBe(3);
    expect(statsPayload.savings.tokens_saved).toBeGreaterThan(0);
    expect(statsPayload.savings.top_commands).toContainEqual(expect.objectContaining({ command: "git log --terse", invocations: 1 }));
    expect(statsPayload.savings.top_commands).toContainEqual(expect.objectContaining({ command: "gh pr list", invocations: 1 }));
    expect(statsPayload.health.degradations).toBe(1);
    const summaryRaw = await readFile(resolveResidentPaths(root).summaryPath, "utf8");
    const summary = parseStructured(summaryRaw) as {
      version: number;
      tokens_saved_today: number;
      updated_at: string;
    };
    expect(summaryRaw.trimStart().startsWith("{")).toBe(false);
    expect(summary.version).toBe(1);
    expect(summary.tokens_saved_today).toBeGreaterThan(0);
    expect(Date.parse(summary.updated_at)).not.toBeNaN();

    const gains = runBundleFromCwd(root, ["gains", "--since", "7d"], env);
    const gainsText = gains.stdout.toString("utf8");
    expect(gains.status, `${gainsText}${gains.stderr.toString("utf8")}`).toBe(0);
    const decoded = decode(gainsText) as {
      window: { invocations: number; degradations: number };
      savings: { single_biggest_elision: { command_family: string; tokens_saved: number } | null };
    };
    expect(decoded.window).toMatchObject({ invocations: 3, degradations: 1 });
    expect(decoded.savings.single_biggest_elision).toMatchObject({
      command_family: "git log",
      tokens_saved: expect.any(Number),
    });
  }, 120_000);

  it("built bundle keeps git log terse elision latency under budget", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };
    await expectWarmResident(root, env);

    expect(runBundleFromCwd(root, ["git", "log", "--terse"], env).status).toBe(0);
    expect(runGit(["-C", root, "log"]).status).toBe(0);

    const rawSamples: number[] = [];
    const nodeSamples: number[] = [];
    const wrappedSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const raw = timedStatus(() => runGit(["-C", root, "log"]));
      const node = timedStatus(() => runNodeNoop());
      const wrapped = timedStatus(() => runBundleFromCwd(root, ["git", "log", "--terse"], env));
      expect(raw.status).toBe(0);
      expect(node.status).toBe(0);
      expect(wrapped.status).toBe(0);
      expect(wrapped.stderr).toEqual(Buffer.alloc(0));
      expect(wrapped.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
      rawSamples.push(raw.elapsedMs);
      nodeSamples.push(node.elapsedMs);
      wrappedSamples.push(wrapped.elapsedMs);
    }

    const rawMedian = median(rawSamples);
    const nodeMedian = median(nodeSamples);
    const wrappedMedian = median(wrappedSamples);
    const overheadMs = wrappedMedian - rawMedian;
    await expectLatencyBudget(
      "git log terse elision overhead",
      budgetSample(
        overheadMs,
        rawMedian + nodeMedian,
        `raw=${rawMedian.toFixed(1)}ms node=${nodeMedian.toFixed(1)}ms ` +
          `wrapped=${wrappedMedian.toFixed(1)}ms overhead=${overheadMs.toFixed(1)}ms`,
      ),
      normalizedLatencyRatio(12),
      () => {
        const retryRawSamples: number[] = [];
        const retryNodeSamples: number[] = [];
        const retryWrappedSamples: number[] = [];
        for (let i = 0; i < 5; i++) {
          const raw = timedStatus(() => runGit(["-C", root, "log"]));
          const node = timedStatus(() => runNodeNoop());
          const wrapped = timedStatus(() => runBundleFromCwd(root, ["git", "log", "--terse"], env));
          expect(raw.status).toBe(0);
          expect(node.status).toBe(0);
          expect(wrapped.status).toBe(0);
          expect(wrapped.stderr).toEqual(Buffer.alloc(0));
          expect(wrapped.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
          retryRawSamples.push(raw.elapsedMs);
          retryNodeSamples.push(node.elapsedMs);
          retryWrappedSamples.push(wrapped.elapsedMs);
        }

        const retryRawMedian = median(retryRawSamples);
        const retryNodeMedian = median(retryNodeSamples);
        const retryWrappedMedian = median(retryWrappedSamples);
        const retryOverheadMs = retryWrappedMedian - retryRawMedian;
        return budgetSample(
          retryOverheadMs,
          retryRawMedian + retryNodeMedian,
          `raw=${retryRawMedian.toFixed(1)}ms node=${retryNodeMedian.toFixed(1)}ms ` +
            `wrapped=${retryWrappedMedian.toFixed(1)}ms overhead=${retryOverheadMs.toFixed(1)}ms`,
        );
      },
    );
  }, 120_000);

  it("prints a degraded dashboard instead of creating the default Repo store when setup has not provisioned it", async () => {
    const root = await tempRoot();
    await enableRsp(root);

    const res = runRspFromCwd(root, [], {});
    const decoded = decode(res.stdout.toString("utf8")) as {
      executable: { name: string };
      recovery: { pending: number };
      waits: { active: number };
      store: { records: number; bytes: number };
      savings: { empty: boolean };
      next_steps: string[];
    };

    expect(res.status).toBe(0);
    expect(decoded).toMatchObject({
      executable: { name: "rsp" },
      recovery: { pending: 0 },
      waits: { active: 0 },
      store: { records: 0, bytes: 0 },
      savings: { empty: true },
    });
    expect(decoded.next_steps).toContain("rsp <wrapped-command> --terse");
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes through a successful wrapper when the repo store is absent and the cold summarizer cannot handle it", async () => {
    const root = await initGitRepo();
    await enableRsp(root);
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "-C", root, "status", "--short"], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${direct.stderr.toString("utf8")}`);
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes through a failing wrapper with the underlying exit code and raw stderr when the store is absent", async () => {
    const root = await initGitRepo();
    await enableRsp(root);
    const args = ["-C", root, "definitely-not-a-git-subcommand"];
    const direct = runGit(args);

    const res = runRspFromCwd(root, ["git", ...args], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${direct.stderr.toString("utf8")}`);
  });

  it("passes through wrappers when the configured store is unreadable non-RedDB data", async () => {
    const root = await initGitRepo();
    await enableRsp(root);
    const storeRoot = await tempRoot();
    const storePath = join(storeRoot, "rsp-elisions.json");
    await writeFile(storePath, "not a reddb store", "utf8");
    await writeFile(join(root, "raw.txt"), "raw\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "-C", root, "status", "--short"], { RSP_STORE_URI: `file://${storePath}` });

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${direct.stderr.toString("utf8")}`);
  });

  it("built bundle never writes .red/red.rdb and preserves a RedDB-format file there", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const redBytes = Buffer.concat([Buffer.from("RDBSBLK1", "ascii"), Buffer.from([0, 1, 2, 3])]);
    await writeFile(join(root, ".red", "red.rdb"), redBytes);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readFile(join(root, ".red", "red.rdb"))).resolves.toEqual(redBytes);
    await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
  }, 120_000);

  it("built bundle cuts over a configured legacy RedDB store without a sidecar migration", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    await enableRsp(root);
    const legacyPath = join(root, ".red", "red.rdb");
    const legacyBytes = Buffer.concat([Buffer.from("RDBSBLK1", "ascii"), Buffer.from("legacy graph bytes")]);
    await writeFile(legacyPath, legacyBytes);
    const warm = runBundleFromCwd(root, ["--store-uri", `file://${legacyPath}`, "warm-resident"]);
    expect(warm.status, `${warm.stdout.toString("utf8")}${warm.stderr.toString("utf8")}`).toBe(0);
    expect(warm.stdout).toEqual(Buffer.alloc(0));
    expect(warm.stderr).toEqual(Buffer.alloc(0));

    const compressed = runBundleFromCwd(root, ["--store-uri", `file://${legacyPath}`, "git", "log", "--terse"]);

    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readFile(legacyPath)).resolves.not.toEqual(legacyBytes);
    expect(decode(await readFile(legacyPath, "utf8"))).toMatchObject({ version: 1 });
    await expect(stat(join(root, ".red", "tmp", "rsp-elisions.json"))).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("passes through wrappers when rsp hits an internal wrapper error after opening the store", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({ uri: storeUri });
    await store.close();
    const direct = runGit(["--version"]);

    const res = runRspFromCwd(root, ["git", "--version"], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${direct.stderr.toString("utf8")}`);

    const debug = runRspFromCwd(root, ["git", "--version"], { RSP_STORE_URI: storeUri, RSP_DEBUG: "1" });
    expect(debug.status).toBe(1);
    expect(debug.stdout.toString("utf8")).toContain('error: "unsupported git subcommand');
  });

});
