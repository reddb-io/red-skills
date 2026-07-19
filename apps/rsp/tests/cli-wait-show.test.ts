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
  it("prints rsp wait help with the standardized waiting contract", async () => {
    const root = await tempRoot();
    const actual = runRsp(root, ["wait", "--help"], {});

    expect(actual.status).toBe(0);
    const stdout = actual.stdout.toString("utf8");
    expect(stdout).toContain("usage: rsp wait <subcommand> [options]");
    expect(stdout).toContain("rsp wait pr 123");
    expect(stdout).toContain("rsp wait run --branch feature/wait --latest");
    expect(stdout).toContain("rsp wait release --tag \"v2.*\"");
    expect(stdout).toContain("rsp wait cmd -- \"pnpm -C apps/rsp build\"");
    expect(stdout).toContain("Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.");
  });

  it("wait pr keeps polling when GitHub has not registered checks for the head SHA yet", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [
      { number: 123, state: "OPEN", mergeable: "UNKNOWN", statusCheckRollup: [] },
      { number: 123, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
    ]);

    const actual = runRsp(root, ["wait", "pr", "123", "--timeout", "2s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
      RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS: "1s",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    expect(Number(await readFile(fakeGh.countFile, "utf8"))).toBeGreaterThan(1);
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { status: string };
      verdict: { summary: string; details: { checks: number; mergeable: string } };
    };
    expect(decoded.wait.status).toBe("success");
    expect(decoded.verdict.summary).toBe("PR #123 checks passed");
    expect(decoded.verdict.details).toMatchObject({ checks: 1, mergeable: "MERGEABLE" });
  });

  it("wait pr resolves no-check repositories only through the empty-check grace path", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [{ number: 123, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }]);

    const actual = runRsp(root, ["wait", "pr", "123", "--timeout", "2s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
      RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS: "1s",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    expect(Number(await readFile(fakeGh.countFile, "utf8"))).toBeGreaterThan(1);
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { status: string };
      verdict: { summary: string; details: { checks: number; mergeable: string } };
    };
    expect(decoded.wait.status).toBe("success");
    expect(decoded.verdict.summary).toBe("PR #123 has no checks configured");
    expect(decoded.verdict.details).toMatchObject({ checks: 0, mergeable: "MERGEABLE" });
  });

  it("wait cmd exits with TOON success and removes its registry entry", async () => {
    const root = await tempRoot();
    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 120)"`;
    const actual = timedStatus(() => runRsp(root, ["wait", "cmd", "--timeout", "5s", "--reason", "test wait", "--", command], {}));

    expect(actual.status).toBe(0);
    expect(actual.elapsedMs).toBeGreaterThanOrEqual(normalizedDurationMs(60));
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { target: string; status: string; reason: string };
      verdict: { exit_code: number };
    };
    expect(decoded.wait.status).toBe("success");
    expect(decoded.wait.reason).toBe("test wait");
    expect(decoded.wait.target).toContain("cmd:");
    expect(decoded.verdict.exit_code).toBe(0);

    const listed = runRsp(root, ["wait", "ls"], {});
    expect(listed.status).toBe(0);
    expect((decode(listed.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
  });

  it("wait ls shows a live registry entry while a command wait is active", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 8000)"`;
    const child = spawn(process.execPath, ["--import", tsxLoader, cli, "wait", "cmd", "--reason", "registry probe", "--", command], {
      cwd: root,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    const listed = await waitForActiveWait(root, "registry probe");
    expect(listed.target).toContain("cmd:");
    expect(listed.status).toBe("running");
    expect(listed.poll_tier).toBe("local-cmd:2-5s");
    const registryFiles = await readdir(join(root, ".red", "tmp", "waits"));
    const registryBody = await readFile(join(root, ".red", "tmp", "waits", registryFiles[0]!), "utf8");
    expect(registryBody.trimStart().startsWith("{")).toBe(false);
    expect((decode(registryBody) as { reason?: string }).reason).toBe("registry probe");

    const status = await closeWithTimeout(child, normalizedDurationMs(10_000));
    expect(status, Buffer.concat(stderr).toString("utf8")).toBe(0);
    const decoded = decode(Buffer.concat(stdout).toString("utf8")) as { wait: { status: string } };
    expect(decoded.wait.status).toBe("success");
    const after = runRsp(root, ["wait", "ls"], {});
    expect((decode(after.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
  });

  it("prints a content-first live dashboard instead of help when called without arguments", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({
      uri: storeUri,
      ephemeralTtlHours: 720,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });
    try {
      await store.mint(Buffer.from("abc"), {
        command: "cmd",
        loss: { level: "terse", bytes_elided: 3 },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, [], { RSP_STORE_URI: storeUri, RSP_EPHEMERAL_TTL_HOURS: "720" });

    expect(res.status).toBe(0);
    const decoded = decode(res.stdout.toString("utf8")) as {
      executable: { name: string; command: string };
      recovery: {
        pending: number;
        handles: Array<{ handle: string; command: string; age_seconds: number; age_display: string; recover: string }>;
      };
      waits: { active: number; entries: unknown[] };
      store: {
        records: number;
        oldest: string;
        budget: number;
        storage_classes: Record<string, { records: number; bytes: number; raw_bytes: number }>;
      };
      savings: { window_days: number; empty: boolean; invocations: number };
      health: { degradations: number; degradation_rate_display: string };
      latency: { wrapper_ms_p50: null; wrapper_ms_p50_display: string };
      next_steps: string[];
    };
    expect(decoded.executable).toEqual({ name: "rsp", command: "rsp" });
    expect(decoded.recovery.pending).toBe(1);
    expect(decoded.recovery.handles).toEqual([
      expect.objectContaining({
        command: "cmd",
        age_seconds: expect.any(Number),
        age_display: expect.any(String),
        recover: expect.stringMatching(/^rsp show el:[a-f0-9]{12}$/),
      }),
    ]);
    expect(decoded.waits).toEqual({ active: 0, entries: [] });
    expect(decoded.store.records).toBe(1);
    expect(decoded.store.oldest).toBe("2026-07-10T12:00:00.000Z");
    expect(decoded.store.budget).toBe(67108864);
    expect(decoded.store.storage_classes.derivable).toEqual({ records: 0, bytes: 0, raw_bytes: 0 });
    expect(decoded.store.storage_classes["re-executable"]).toEqual({ records: 0, bytes: 0, raw_bytes: 0 });
    expect(decoded.store.storage_classes.ephemeral.records).toBe(1);
    expect(decoded.store.storage_classes.ephemeral.bytes).toBeGreaterThan(0);
    expect(decoded.store.storage_classes.ephemeral.raw_bytes).toBe(3);
    expect(decoded.savings).toMatchObject({ window_days: 30, empty: true, invocations: 0 });
    expect(decoded.health).toMatchObject({ degradations: 0, degradation_rate_display: "0.0" });
    expect(decoded.latency).toMatchObject({ wrapper_ms_p50: null, wrapper_ms_p50_display: "none" });
    expect(decoded.next_steps).toEqual(["rsp show <handle>", "rsp wait cmd -- \"<command>\"", "rsp stats --since <days>d"]);
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("prints scoped help for top-level rsp subcommands", async () => {
    const root = await tempRoot();

    const rootHelp = runRsp(root, ["--help"], {});
    const statsHelp = runRsp(root, ["stats", "--help"], {});
    const gitHelp = runRsp(root, ["git", "--help"], {});

    expect(rootHelp.status).toBe(0);
    expect(rootHelp.stdout.toString("utf8")).toContain("usage: rsp <subcommand> [options]");
    expect(rootHelp.stdout.toString("utf8")).toContain("Examples:");
    expect(statsHelp.status).toBe(0);
    expect(statsHelp.stdout.toString("utf8")).toContain("usage: rsp stats [--since <days>d] [--full]");
    expect(statsHelp.stdout.toString("utf8")).toContain("Defaults: --since 30d");
    expect(gitHelp.status).toBe(0);
    expect(gitHelp.stdout.toString("utf8")).toContain("usage: rsp git <status|log|diff|show|blame|branch|commit|push>");
    expect(gitHelp.stdout.toString("utf8")).toContain("Examples:");
  });

  it("prints a definitive empty telemetry state through rsp stats", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({ uri: storeUri });
    await store.close();

    const res = runRsp(root, ["stats", "--since=7d"], { RSP_STORE_URI: storeUri });
    const decoded = decode(res.stdout.toString("utf8")) as {
      records: number;
      bytes: number;
      oldest: null;
      storage_classes: Record<string, { records: number; bytes: number; raw_bytes: number }>;
      savings: { window_days: number; empty: boolean; invocations: number; top_commands: unknown[] };
      health: { degradations: number; degradation_rate_display: string; most_recent_degradation_at: null };
      latency: { wrapper_ms_p50: null; wrapper_ms_p95: null };
    };

    expect(res.status).toBe(0);
    expect(decoded).toMatchObject({ records: 0, bytes: 0, oldest: null });
    expect(decoded.storage_classes.derivable).toEqual({ records: 0, bytes: 0, raw_bytes: 0 });
    expect(decoded.storage_classes["re-executable"]).toEqual({ records: 0, bytes: 0, raw_bytes: 0 });
    expect(decoded.storage_classes.ephemeral).toEqual({ records: 0, bytes: 0, raw_bytes: 0 });
    expect(decoded.savings).toMatchObject({ window_days: 7, empty: true, invocations: 0, top_commands: [] });
    expect(decoded.health).toMatchObject({ degradations: 0, degradation_rate_display: "0.0", most_recent_degradation_at: null });
    expect(decoded.latency).toMatchObject({ wrapper_ms_p50: null, wrapper_ms_p95: null });
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("rsp show prints original bytes verbatim on hit", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const original = Buffer.from([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x00, 0x62, 0xff]);
    const store = await RspElisionStore.open({ uri: storeUri });
    let handle = "";
    try {
      handle = await store.mint(original, {
        command: "printf bytes",
        loss: { level: "terse", bytes_elided: original.length },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, ["show", handle], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(0);
    expect(res.stdout).toEqual(original);
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("rsp show re-runs re-executable recipes and marks moved state", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeRoot = await tempRoot();
    const storeUri = `file://${join(storeRoot, "red.rdb")}`;
    runGit(["-C", root, "init"]);
    await writeFile(join(root, ".gitignore"), ".red/\n", "utf8");
    await writeFile(join(root, "tracked.txt"), "tracked content\n", "utf8");
    runGit(["-C", root, "add", ".gitignore"]);
    runGit(["-C", root, "add", "tracked.txt"]);

    const store = await RspElisionStore.open({ uri: storeUri });
    let handle = "";
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      const original = Buffer.from("A  .gitignore\nA  tracked.txt\n");
      handle = await store.mint(original, {
        command: "git status --short",
        loss: { level: "terse", bytes_elided: original.length },
      });
    } finally {
      process.chdir(previousCwd);
      await store.close();
    }
    await writeFile(join(root, "moved.txt"), "state moved\n", "utf8");

    const res = runRsp(root, ["show", handle], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(0);
    expect(res.stdout.toString("utf8")).toBe(
      "reconstructed after state moved - current snapshot follows\nA  .gitignore\nA  tracked.txt\n?? moved.txt\n",
    );
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("rsp show prints structured expiry with the original command and exits 1", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    let now = new Date("2026-07-10T12:00:00.000Z");
    const store = await RspElisionStore.open({ uri: storeUri, ttlDays: 1, now: () => now });
    let handle = "";
    try {
      handle = await store.mint(Buffer.from("old"), {
        command: "rerun me",
        loss: { level: "terse", bytes_elided: 3 },
      });
      now = new Date("2026-07-12T12:00:00.000Z");
      await store.mint(Buffer.from("new"), {
        command: "new",
        loss: { level: "terse", bytes_elided: 3 },
      });
    } finally {
      await store.close();
    }

    const res = runRsp(root, ["show", handle], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(1);
    expect(decode(res.stdout.toString("utf8"))).toMatchObject({
      category: "real-error",
      error: "expired 2026-07-10T18:00:00.000Z",
      help: ["rerun me"],
    });
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });
});
