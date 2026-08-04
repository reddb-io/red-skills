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

const BUNDLED_STATUS_REWRITE = `${process.execPath} ${bundle} proxy -- 'git status'`;

describe("rsp cli", () => {
  it("built bundle keeps cold small git status off the resident", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    const res = runBundleFromCwd(root, ["git", "status"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_FAIL_IF_STORE_OPEN: "1",
    });
    const direct = runGit(["-C", root, "status", "--porcelain=v1"]);
    const paths = trackedResidentPaths(root);

    expect(res.status).toBe(0);
    if (direct.stdout.length === 0) {
      expect(decode(res.stdout.toString("utf8"))).toMatchObject({
        category: "no-op",
        scope: "git status",
        empty: true,
      });
    } else {
      expect(res.stdout).toEqual(direct.stdout);
    }
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    const status = runBundleFromCwd(root, ["status"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(status.status, `${status.stdout.toString("utf8")}${status.stderr.toString("utf8")}`).toBe(0);
    expect(decode(status.stdout.toString("utf8"))).toMatchObject({
      state: "missing",
    });
  }, 120_000);

  it("built bundle keeps cold git status off the resident drain path", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await enableRsp(root);
    await writeFile(join(root, ".gitignore"), ".red/\n", "utf8");
    expect(runGit(["-C", root, "add", ".gitignore"]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", "baseline"]).status).toBe(0);
    const cacheDir = await seedWarmRedCache();
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    await mkdir(dirname(telemetrySpoolPath(root)), { recursive: true });
    const huge = "x".repeat(512 * 1024);
    await writeFile(telemetrySpoolPath(root), Array.from({ length: 8 }, (_, i) => JSON.stringify({
      collection: RSP_TELEMETRY_INVOCATIONS_COLLECTION,
      id: `backlog-${i}`,
      created_at: new Date().toISOString(),
      command: "git log --terse",
      elided: true,
      raw_bytes: huge.length,
      emitted_bytes: huge.length,
      raw_text: huge,
      emitted_text: huge,
    })).join("\n") + "\n", "utf8");

    const raw = timedStatus(() => runGit(["-C", root, "status", "--porcelain=v1"]));
    const node = timedStatus(runNodeNoop);
    const wrapped = timedStatus(() => runBundleFromCwd(root, ["--store-uri", storeUri, "git", "status"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(normalizedDurationMs(60_000)),
    }));
    const paths = trackedResidentPaths(root);

    expect(wrapped.status, `${wrapped.stdout.toString("utf8")}${wrapped.stderr.toString("utf8")}`).toBe(0);
    expect(raw.stdout.length).toBe(0);
    expect(decode(wrapped.stdout.toString("utf8"))).toMatchObject({
      category: "no-op",
      scope: "git status",
      empty: true,
    });
    expect(wrapped.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(wrapped.elapsedMs - node.elapsedMs).toBeLessThan(normalizedDurationMs(150) + raw.elapsedMs);
  }, 120_000);

  it("built bundle resident listens before opening the RedDB store", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);
    const child = spawn(process.execPath, [bundle, "server", "--idle-ms", String(normalizedDurationMs(5_000))], {
      cwd: root,
      env: {
        ...process.env,
        RED_SKILLS_CACHE_DIR: cacheDir,
        RSP_TEST_HANG_RESIDENT_STORE_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    await waitForResidentSocket(root);
    const ping = await sendResidentRequest({ socketPath: paths.socketPath, timeoutMs: 200 }, {
      id: randomUUID(),
      op: "ping",
    });
    expect(ping).toMatchObject({ ok: false, error: "rsp resident store is not ready" });
    const stats = await sendResidentRequest({ socketPath: paths.socketPath, timeoutMs: 200 }, {
      id: randomUUID(),
      op: "stats",
    });
    expect(stats).toMatchObject({ ok: false, error: "rsp resident store is not ready" });
    await sendResidentRequest({ socketPath: paths.socketPath, timeoutMs: 200 }, {
      id: randomUUID(),
      op: "handover",
      clientVersion: "999.0.0",
    }).catch(() => undefined);
    if (child.exitCode == null) child.kill("SIGTERM");
    const status = await closeWithTimeout(child, normalizedDurationMs(5_000)).catch(() => null);
    expect(status === 0 || status === null).toBe(true);
  }, 120_000);

  it("built bundle warm-resident waits through a slow resident store open", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    const warm = runBundleFromCwd(root, ["warm-resident", "--idle-ms", String(normalizedDurationMs(30_000))], {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_TEST_DELAY_RESIDENT_STORE_OPEN_MS: "5500",
    });

    expect(warm.status, `${warm.stdout.toString("utf8")}${warm.stderr.toString("utf8")}`).toBe(0);
    expect(warm.stdout).toEqual(Buffer.alloc(0));
    expect(warm.stderr).toEqual(Buffer.alloc(0));
    await waitForResidentReady(root);
  }, 120_000);

  it("built bundle elision falls back fast when the resident store is not ready", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 24);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);
    const child = spawn(process.execPath, [bundle, "server", "--idle-ms", String(normalizedDurationMs(5_000))], {
      cwd: root,
      env: {
        ...process.env,
        RED_SKILLS_CACHE_DIR: cacheDir,
        RSP_TEST_HANG_RESIDENT_STORE_OPEN: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await waitForResidentSocket(root);

    const raw = runGit(["-C", root, "log"]);
    const node = timedStatus(runNodeNoop);
    const wrapped = timedStatus(() => runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir }));

    expect(wrapped.status, `${wrapped.stdout.toString("utf8")}${wrapped.stderr.toString("utf8")}`).toBe(0);
    expect(wrapped.stderr).toEqual(Buffer.alloc(0));
    expect(wrapped.stdout.length).toBeLessThan(raw.stdout.length);
    expect(wrapped.stdout.toString("utf8")).toContain("recovery unavailable (resident cold) — re-run: git log");
    expect(wrapped.elapsedMs - node.elapsedMs).toBeLessThan(normalizedDurationMs(250));
    await sendResidentRequest({ socketPath: paths.socketPath, timeoutMs: 200 }, {
      id: randomUUID(),
      op: "handover",
      clientVersion: "999.0.0",
    }).catch(() => undefined);
    if (child.exitCode == null) child.kill("SIGTERM");
    const status = await closeWithTimeout(child, normalizedDurationMs(5_000)).catch(() => null);
    expect(status === 0 || status === null).toBe(true);
  }, 120_000);

  it("built bundle teardown stops every spawned resident process", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);

    const res = runBundleFromCwd(root, ["warm-resident", "--idle-ms", String(normalizedDurationMs(30_000))], {
      RED_SKILLS_CACHE_DIR: cacheDir,
    });

    expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
    await waitForResidentSocket(root);
    await expect(readPid(paths.pidPath)).resolves.toEqual(expect.any(Number));
    expect(await countTrackedResidentProcesses()).toBe(1);

    await stopTrackedResidents([]);

    expect(await countTrackedResidentProcesses([root])).toBe(0);
  }, 120_000);

  it("built bundle idle resident exits even when final telemetry drain hangs", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const started = Date.now();
    const child = spawn(process.execPath, [
      bundle,
      "server",
      "--idle-ms",
      "100",
      "--telemetry-drain-timeout-ms",
      "60000",
    ], {
      cwd: root,
      env: {
        ...process.env,
        RED_SKILLS_CACHE_DIR: cacheDir,
        RSP_TEST_HANG_TELEMETRY_DRAIN: "1",
        RSP_TEST_IDLE_SHUTDOWN_WATCHDOG_MS: String(normalizedDurationMs(500)),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    await waitForResidentSocket(root);
    const status = await closeWithTimeout(child, normalizedDurationMs(5_000));

    expect(status, `${Buffer.concat(stdout).toString("utf8")}${Buffer.concat(stderr).toString("utf8")}`).toBe(0);
    expect(Date.now() - started).toBeLessThan(normalizedDurationMs(10_000));
    await expect(stat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await countTrackedResidentProcesses()).toBe(0);
  }, 120_000);

  it("built bundle Claude pre-exec hook rewrites while cold and warms once", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };
    const paths = trackedResidentPaths(root);

    const coldNodeBaseline = timedStatus(runNodeNoop);
    const cold = timedStatus(() => runBundleHookFromCwd(root, "git status", env));
    const coldHookWorkMs = Math.max(0, cold.elapsedMs - coldNodeBaseline.elapsedMs);

    expect(cold.status).toBe(0);
    expect(JSON.parse(cold.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: BUNDLED_STATUS_REWRITE },
      },
    });
    expect(cold.stderr).toEqual(Buffer.alloc(0));
    await expectLatencyBudget(
      "cold pre-exec hook work",
      budgetSample(
        coldHookWorkMs,
        coldNodeBaseline.elapsedMs,
        `node=${coldNodeBaseline.elapsedMs.toFixed(1)}ms cold=${cold.elapsedMs.toFixed(1)}ms hookWork=${coldHookWorkMs.toFixed(1)}ms`,
      ),
      normalizedLatencyRatio(8),
      async () => {
        const retryRoot = await initGitRepo();
        const retryCacheDir = await seedWarmRedCache();
        const retrySetup = runBundleFromCwd(retryRoot, ["setup"], { RED_SKILLS_CACHE_DIR: retryCacheDir });
        expect(retrySetup.status, `${retrySetup.stdout.toString("utf8")}${retrySetup.stderr.toString("utf8")}`).toBe(0);
        const retryEnv = { RED_SKILLS_CACHE_DIR: retryCacheDir };
        const retryNodeBaseline = timedStatus(runNodeNoop);
        const retryCold = timedStatus(() => runBundleHookFromCwd(retryRoot, "git status", retryEnv));
        const retryColdHookWorkMs = Math.max(0, retryCold.elapsedMs - retryNodeBaseline.elapsedMs);

        expect(retryCold.status).toBe(0);
        expect(JSON.parse(retryCold.stdout.toString("utf8"))).toMatchObject({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { command: BUNDLED_STATUS_REWRITE },
          },
        });
        expect(retryCold.stderr).toEqual(Buffer.alloc(0));
        return budgetSample(
          retryColdHookWorkMs,
          retryNodeBaseline.elapsedMs,
          `node=${retryNodeBaseline.elapsedMs.toFixed(1)}ms cold=${retryCold.elapsedMs.toFixed(1)}ms hookWork=${retryColdHookWorkMs.toFixed(1)}ms`,
        );
      },
    );
    await waitForResidentSocket(root);
    // The wake lock is transient; the observable contract is that the hook's
    // kick brings the resident online.
    await waitForGone(paths.wakeLockPath);

    for (let i = 0; i < 4; i++) {
      const repeat = runBundleHookFromCwd(root, "git status", env);
      expect(repeat.status).toBe(0);
      expect(JSON.parse(repeat.stdout.toString("utf8"))).toMatchObject({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          updatedInput: { command: BUNDLED_STATUS_REWRITE },
        },
      });
      expect(repeat.stderr).toEqual(Buffer.alloc(0));
    }

    const measureWarmHookWork = () => {
      const nodeSamples: number[] = [];
      const warmSamples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const node = timedStatus(runNodeNoop);
        const warm = timedStatus(() => runBundleHookFromCwd(root, "git status", env));

        expect(warm.status).toBe(0);
        expect(JSON.parse(warm.stdout.toString("utf8"))).toMatchObject({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            updatedInput: { command: BUNDLED_STATUS_REWRITE },
          },
        });
        expect(warm.stderr).toEqual(Buffer.alloc(0));
        nodeSamples.push(node.elapsedMs);
        warmSamples.push(warm.elapsedMs);
      }

      const nodeMedian = median(nodeSamples);
      const warmMedian = median(warmSamples);
      return {
        nodeMedian,
        warmMedian,
        hookWorkMs: Math.max(0, warmMedian - nodeMedian),
      };
    };

    const measuredWarm = measureWarmHookWork();
    await expectLatencyBudget(
      "warm pre-exec hook work",
      budgetSample(
        measuredWarm.hookWorkMs,
        measuredWarm.nodeMedian,
        `node=${measuredWarm.nodeMedian.toFixed(1)}ms warm=${measuredWarm.warmMedian.toFixed(1)}ms ` +
          `hookWork=${measuredWarm.hookWorkMs.toFixed(1)}ms`,
      ),
      normalizedLatencyRatio(8),
      () => {
        const retry = measureWarmHookWork();
        return budgetSample(
          retry.hookWorkMs,
          retry.nodeMedian,
          `node=${retry.nodeMedian.toFixed(1)}ms warm=${retry.warmMedian.toFixed(1)}ms ` +
            `hookWork=${retry.hookWorkMs.toFixed(1)}ms`,
        );
      },
    );
  }, 120_000);

  it("built bundle keeps the warmed resident alive until the configured idle timeout", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const idleMs = normalizedDurationMs(5_000);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir, RSP_IDLE_MS: String(idleMs) };
    const paths = trackedResidentPaths(root);

    const cold = runBundleHookFromCwd(root, "git status", env);
    expect(cold.status).toBe(0);
    expect(JSON.parse(cold.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: BUNDLED_STATUS_REWRITE },
      },
    });
    expect(cold.stderr).toEqual(Buffer.alloc(0));
    await waitForResidentSocket(root);
    await waitForGone(paths.wakeLockPath);

    await new Promise((resolve) => setTimeout(resolve, normalizedDurationMs(2_000)));
    const warm = runBundleHookFromCwd(root, "git status", env);
    expect(warm.status).toBe(0);
    expect(JSON.parse(warm.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: BUNDLED_STATUS_REWRITE },
      },
    });
    expect(warm.stderr).toEqual(Buffer.alloc(0));

    await waitForGone(paths.socketPath, idleMs + normalizedDurationMs(5_000));
    await waitForGone(paths.registryPath);
    const expired = runBundleHookFromCwd(root, "git status", env);
    expect(expired.status).toBe(0);
    expect(JSON.parse(expired.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: BUNDLED_STATUS_REWRITE },
      },
    });
    expect(expired.stderr).toEqual(Buffer.alloc(0));
  }, 120_000);

  it("built bundle Codex pre-exec rewrite records telemetry when the rewritten command runs", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const resident = runBundleFromCwdAsync(root, ["server", "--idle-ms", "1000"], env);
    await waitForResidentSocket(root);
    await waitForResidentReady(root);

    const hook = runBundleCodexHookFromCwd(root, "git status", env);
    expect(hook.status, `${hook.stdout.toString("utf8")}${hook.stderr.toString("utf8")}`).toBe(0);
    expect(hook.stderr).toEqual(Buffer.alloc(0));
    expect(JSON.parse(hook.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: BUNDLED_STATUS_REWRITE },
      },
    });

    const rewritten = runBundleFromCwd(root, ["git", "status"], env);
    expect(rewritten.status).toBe(0);
    expect(rewritten.stderr).toEqual(Buffer.alloc(0));
    const residentResult = await resident;
    expect(residentResult.status, `${residentResult.stdout.toString("utf8")}${residentResult.stderr.toString("utf8")}`).toBe(0);

    const invocations = await readTelemetryRecords(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION);
    expect(invocations).toContainEqual(expect.objectContaining({
      command: "git status",
      wrapper: "git",
      loss: "lossless",
      elided: false,
    }));

    const disabledRoot = await initGitRepo();
    const disabledHook = runBundleCodexHookFromCwd(disabledRoot, "git status", env);
    expect(disabledHook.status).toBe(0);
    expect(disabledHook.stdout).toEqual(Buffer.alloc(0));
    expect(disabledHook.stderr).toEqual(Buffer.alloc(0));
    const direct = runGit(["-C", disabledRoot, "status"]);
    const disabled = runBundleFromCwd(disabledRoot, ["git", "status"], env);
    expect(disabled.status).toBe(direct.status);
    expect(disabled.stdout).toEqual(direct.stdout);
    expect(disabled.stderr).toEqual(direct.stderr);
  }, 120_000);

  it("built bundle starts the resident for a repo root longer than the Unix socket path limit", async () => {
    buildBundleOnce();
    const base = await tempRoot();
    let root = base;
    let segment = 0;
    while (root.length <= 120) {
      root = join(root, `deep-segment-${segment++}`);
    }
    await mkdir(root, { recursive: true });
    const init = runGit(["-C", root, "init"]);
    expect(init.status).toBe(0);
    expect(runGit(["-C", root, "config", "user.email", "rsp-test@example.invalid"]).status).toBe(0);
    expect(runGit(["-C", root, "config", "user.name", "Rsp Test"]).status).toBe(0);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    const paths = trackedResidentPaths(root);
    expect(join(root, ".red", "tmp", "rsp.sock").length).toBeGreaterThan(108);
    expect(paths.socketPath.length).toBeLessThan(108);
    expect(paths.socketPath).not.toBe(join(root, ".red", "tmp", "rsp.sock"));

    const res = runBundleFromCwd(root, ["warm-resident"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
    });

    expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
    expect(res.stdout).toEqual(Buffer.alloc(0));
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(((await stat(dirname(paths.socketPath))).mode & 0o777)).toBe(0o700);
    await expect(stat(join(root, ".red", "tmp", "rsp.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
  }, 120_000);

  it("built bundle uses the primary resident and store from linked worktrees", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await enableRsp(root);
    await writeFile(join(root, ".gitignore"), ".red/tmp/\n", "utf8");
    expect(runGit(["-C", root, "add", ".red/config.yaml", ".gitignore"]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", "baseline"]).status).toBe(0);
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const env = {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_HEAVY_GIT_BYTE_THRESHOLD: "1",
      RSP_TELEMETRY_DRAIN_INTERVAL_MS: "50",
    };
    const setup = runBundleFromCwd(root, ["setup"], env);
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, env);

    const worktreeA = join(root, ".red", "tmp", "linked-a");
    const worktreeB = join(root, ".red", "tmp", "linked-b");
    expect(runGit(["-C", root, "worktree", "add", worktreeA, "-b", `rsp-linked-a-${randomUUID()}`, "HEAD"]).status).toBe(0);
    expect(runGit(["-C", root, "worktree", "add", worktreeB, "-b", `rsp-linked-b-${randomUUID()}`, "HEAD"]).status).toBe(0);

    const primaryPaths = trackedResidentPaths(root);
    const worktreePaths = resolveResidentPaths(worktreeA);
    expect(worktreePaths.rootDir).toBe(primaryPaths.rootDir);
    expect(worktreePaths.socketPath).toBe(primaryPaths.socketPath);
    expect(worktreePaths.summaryPath).toBe(primaryPaths.summaryPath);

    const primaryWarm = runBundleFromCwd(root, ["git", "log", "--terse"], env);
    expect(primaryWarm.status, `${primaryWarm.stdout.toString("utf8")}${primaryWarm.stderr.toString("utf8")}`).toBe(0);
    extractHandle(primaryWarm.stdout);
    const beforeWorktree = await waitForSummaryTokens(root, 0);

    const fromWorktree = runBundleFromCwd(worktreeA, ["git", "log", "--terse"], env);
    expect(fromWorktree.status, `${fromWorktree.stdout.toString("utf8")}${fromWorktree.stderr.toString("utf8")}`).toBe(0);
    const handle = extractHandle(fromWorktree.stdout);
    await expect(stat(primaryPaths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
    await waitForSummaryTokens(root, beforeWorktree);

    const concurrent = await Promise.all([
      runBundleFromCwdAsync(root, ["git", "status"], env),
      runBundleFromCwdAsync(worktreeA, ["git", "status"], env),
      runBundleFromCwdAsync(worktreeB, ["git", "status"], env),
    ]);
    for (const res of concurrent) {
      expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
      expect(res.stderr).toEqual(Buffer.alloc(0));
    }

    expect(runGit(["-C", root, "worktree", "remove", "--force", worktreeA]).status).toBe(0);
    await rm(worktreeA, { recursive: true, force: true });
    const shown = runBundleFromCwd(root, ["show", handle], env);
    expect(shown.status, `${shown.stdout.toString("utf8")}${shown.stderr.toString("utf8")}`).toBe(0);
    expect(shown.stdout.toString("utf8")).toContain("commit ");

    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    await waitForTelemetryInvocations(storeUri, "git log", 2);
    const invocations = await waitForTelemetryInvocations(storeUri, "git status", 3);
    const stats = runBundleFromCwd(root, ["stats", "--since", "7d"], env);
    const statsText = stats.stdout.toString("utf8");
    const statsPayload = decode(statsText) as { savings: { top_commands: Array<{ command: string; invocations: number }> } };
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsPayload.savings.top_commands).toContainEqual(expect.objectContaining({ command: "git log", invocations: expect.any(Number) }));

    expect(invocations.filter((entry) => isRecord(entry) && entry.command === "git status").length)
      .toBeGreaterThanOrEqual(3);
  }, 120_000);

  it("built bundle keeps small git status wrapper work under 100ms", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await enableRsp(root);
    await writeFile(join(root, ".gitignore"), ".red/\n", "utf8");
    expect(runGit(["-C", root, "add", ".gitignore"]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", "baseline"]).status).toBe(0);
    const cacheDir = await seedWarmRedCache();
    const storeUri = `file://${join(await tempRoot(), "rsp-elisions.json")}`;
    const store = await RspElisionStore.open({ uri: storeUri });
    await store.close();
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };

    expect(runBundleFromCwd(root, ["--store-uri", storeUri, "git", "status"], env).status).toBe(0);
    expect(runGit(["-C", root, "status"]).status).toBe(0);

    const measureWrapperWork = () => {
      const rawSamples: number[] = [];
      const nodeSamples: number[] = [];
      const wrappedSamples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const raw = timedStatus(() => runGit(["-C", root, "status"]));
        const node = timedStatus(() => runNodeNoop());
        const wrapped = timedStatus(() => runBundleFromCwd(root, ["--store-uri", storeUri, "git", "status"], env));
        expect(raw.status).toBe(0);
        expect(node.status).toBe(0);
        expect(wrapped.status).toBe(0);
        expect(wrapped.stderr).toEqual(Buffer.alloc(0));
        rawSamples.push(raw.elapsedMs);
        nodeSamples.push(node.elapsedMs);
        wrappedSamples.push(wrapped.elapsedMs);
      }

      const rawMedian = median(rawSamples);
      const nodeMedian = median(nodeSamples);
      const wrappedMedian = median(wrappedSamples);
      return {
        rawMedian,
        nodeMedian,
        wrappedMedian,
        wrapperWorkMs: wrappedMedian - nodeMedian,
      };
    };

    const measured = measureWrapperWork();
    const measuredDetails =
      `raw=${measured.rawMedian.toFixed(1)}ms node=${measured.nodeMedian.toFixed(1)}ms ` +
      `wrapped=${measured.wrappedMedian.toFixed(1)}ms wrapperWork=${measured.wrapperWorkMs.toFixed(1)}ms`;
    await expectLatencyBudget(
      "small git status wrapper work",
      budgetSample(measured.wrapperWorkMs, measured.nodeMedian + measured.rawMedian, measuredDetails),
      normalizedLatencyRatio(8),
      () => {
        const retry = measureWrapperWork();
        return budgetSample(
          retry.wrapperWorkMs,
          retry.nodeMedian + retry.rawMedian,
          `raw=${retry.rawMedian.toFixed(1)}ms node=${retry.nodeMedian.toFixed(1)}ms ` +
            `wrapped=${retry.wrappedMedian.toFixed(1)}ms wrapperWork=${retry.wrapperWorkMs.toFixed(1)}ms`,
        );
      },
    );
  }, 120_000);

  it("built bundle resolves rsp server store from repo config and idles out", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

    const res = runBundleFromCwd(root, ["server", "--idle-ms", "100"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
    expect(res.stdout).toEqual(Buffer.alloc(0));
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(trackedResidentPaths(root).socketPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("built bundle handles concurrent cold status locally and keeps the resident store usable", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };

    const results = await Promise.all(Array.from({ length: 8 }, () => runBundleFromCwdAsync(root, ["git", "status"], env)));

    for (const res of results) {
      expect(res.status).toBe(0);
      expect(decode(res.stdout.toString("utf8"))).toMatchObject({
        category: "no-op",
        scope: "git status",
        empty: true,
      });
      expect(res.stderr).toEqual(Buffer.alloc(0));
    }
    const paths = trackedResidentPaths(root);
    await expect(stat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expectWarmResident(root, env);
    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], env);
    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
  }, 120_000);

  it("built bundle recovers an orphaned resident socket before spawning", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);
    await mkdir(dirname(paths.socketPath), { recursive: true });
    await writeFile(paths.socketPath, "orphaned resident socket\n", "utf8");
    await expectWarmResident(root, {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_FAIL_IF_STORE_OPEN: "1",
    });

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_FAIL_IF_STORE_OPEN: "1",
    });

    expect(compressed.status, `${compressed.stdout.toString("utf8")}${compressed.stderr.toString("utf8")}`).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 120_000);

  it("built bundle hands over from an older live resident and keeps serving requests", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const oldVersion = "2.23.0";
    const oldResident = runBundleFromCwdAsync(
      root,
      ["server", "--idle-ms", "10000", "--resident-version", oldVersion],
      { RED_SKILLS_CACHE_DIR: cacheDir },
    );
    await waitForResidentSocket(root);
    expect(await readResidentVersion(root)).toBe(oldVersion);
    const oldRegistryRaw = await readFile(trackedResidentPaths(root).registryPath, "utf8");
    const oldRegistry = parseStructured(oldRegistryRaw) as {
      pid: number;
      resident_version: string;
    };
    expect(oldRegistry.resident_version).toBe(oldVersion);
    expect(oldRegistryRaw.trimStart().startsWith("{")).toBe(false);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status, `${compressed.stdout.toString("utf8")}${compressed.stderr.toString("utf8")}`).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(compressed.stdout.toString("utf8"))?.[1];
    expect(handle).toBeTruthy();
    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(shown.status, `${shown.stdout.toString("utf8")}${shown.stderr.toString("utf8")}`).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(compressed.stdout.length);
    expect(await readResidentVersion(root)).not.toBe(oldVersion);
    const nextRegistry = parseStructured(await readFile(trackedResidentPaths(root).registryPath, "utf8")) as {
      pid: number;
      resident_version: string;
    };
    expect(nextRegistry.pid).not.toBe(oldRegistry.pid);
    expect(nextRegistry.resident_version).not.toBe(oldVersion);
    expect(await oldResident).toMatchObject({ status: 0 });
  }, 120_000);

  it("built bundle removes a hung old resident socket after handover timeout", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const paths = trackedResidentPaths(root);
    const oldVersion = "2.23.0";
    const hung = await startHungOldResident(paths.socketPath, oldVersion);
    try {
      expect(await readResidentVersion(root)).toBe(oldVersion);
      await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });

      const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

      expect(compressed.status, `${compressed.stdout.toString("utf8")}${compressed.stderr.toString("utf8")}`).toBe(0);
      expect(compressed.stderr).toEqual(Buffer.alloc(0));
      expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
      expect(await readResidentVersion(root)).not.toBe(oldVersion);
      await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      hung.close();
    }
  }, 120_000);

  it("built bundle compresses git log warm and cold, with recovery only for warm handles", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const raw = runGit(["-C", root, "log"]);
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(raw.status);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.length).toBeLessThan(raw.stdout.length);
    const text = compressed.stdout.toString("utf8");
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const stats = runBundleFromCwd(root, [], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(stats.status).toBe(0);
    expect(decode(stats.stdout.toString("utf8"))).toMatchObject({
      savings: expect.objectContaining({ invocations: expect.any(Number) }),
    });

    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(shown.status).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(compressed.stdout.length);
    expect(shown.stderr).toEqual(Buffer.alloc(0));

    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(join(root, ".red", "state", "red-skills.rdb"));
    const cold = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(cold.status).toBe(raw.status);
    expect(cold.stderr).toEqual(Buffer.alloc(0));
    expect(cold.stdout.length).toBeLessThan(raw.stdout.length);
    const coldText = cold.stdout.toString("utf8");
    expect(coldText).toContain("summary: 12 commits");
    expect(coldText).toContain("recovery unavailable (cold store) — re-run: git log");
    expect(coldText).not.toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readSpoolEvents(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ command: "git log" }),
    ]));
  }, 120_000);

  it("built bundle elides final stdout from rsp exec pipelines and recovers original bytes", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 80);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });
    const command = "git log | head -c 400000";
    const direct = runShellFromCwd(root, command);

    const compressed = runBundleFromCwd(root, ["exec", "--", command], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(direct.status);
    expect(compressed.stderr).toEqual(direct.stderr);
    expect(compressed.stdout.length).toBeLessThan(direct.stdout.length);
    const text = compressed.stdout.toString("utf8");
    expect(text).toContain("summary:");
    expect(text).toContain("rsp show el:");
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toEqual(direct.stdout);
    expect(shown.stderr).toEqual(Buffer.alloc(0));
    await expect(readSpoolEvents(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ command }),
    ]));
  }, 120_000);

  it("built bundle renders rsp cat code outlines and recovers original file bytes", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    await expectWarmResident(root, { RED_SKILLS_CACHE_DIR: cacheDir });
    const source = [
      "export function greet(name: string): string {",
      "  return `hello ${name}`;",
      "}",
      "",
      "class Greeter {",
      "  run(name: string): string {",
      "    return greet(name);",
      "  }",
      "}",
      "",
    ].join("\n");
    await writeFile(join(root, "sample.ts"), source, "utf8");

    const rendered = runBundleFromCwd(root, ["cat", "--terse", "sample.ts"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(rendered.status, `${rendered.stdout.toString("utf8")}${rendered.stderr.toString("utf8")}`).toBe(0);
    expect(rendered.stderr).toEqual(Buffer.alloc(0));
    const text = rendered.stdout.toString("utf8");
    expect(text).toContain("kind: code");
    expect(text).toContain("greet");
    expect(text).toContain("Greeter");
    expect(text).toMatch(/rsp show el:[a-f0-9]{12}/);
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(shown.status).toBe(0);
    expect(shown.stdout.toString("utf8")).toBe(source);
    expect(shown.stderr).toEqual(Buffer.alloc(0));
  }, 120_000);

});
