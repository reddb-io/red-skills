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
  it("keeps the cli entrypoint as a small stable barrel", async () => {
    const source = await readFile(cli, "utf8");
    const lineCount = source.split(/\r?\n/).length;
    const exports = await import("../src/cli.js");

    expect(lineCount).toBeLessThanOrEqual(1200);
    expect(Object.keys(exports).sort()).toEqual(["isDirectExecution", "main", "renderSetupResult", "renderStats"]);
  });

  it("prints unknown rsp flags as structured usage errors", async () => {
    const root = await tempRoot();

    const res = runRsp(root, ["--bogus"], {});
    const decoded = decode(res.stdout.toString("utf8")) as { category: string; exit_code: number; valid_flags: string[] };

    expect(res.status).toBe(2);
    expect(res.stderr).toEqual(Buffer.alloc(0));
    expect(decoded.category).toBe("usage");
    expect(decoded.exit_code).toBe(2);
    expect(decoded.valid_flags).toContain("--brief");
  });

  it.each([
    ["compound-stdout-stderr", "printf 'out\\n'; printf 'err\\n' >&2"],
    ["pipeline", "printf 'one\\ntwo\\n' | sed -n '2p'"],
    ["redirect", "printf 'saved\\n' > redirected.txt; cat redirected.txt"],
    ["failing-exit", "printf 'bad\\n' >&2; exit 7"],
    ["signal", "kill -TERM $$"],
  ])("proxies %s with byte-identical shell behavior", async (_label, command) => {
    const rawRoot = await tempRoot();
    const proxyRoot = await tempRoot();
    await enableRsp(proxyRoot);

    const raw = runShellFromCwd(rawRoot, command);
    const proxied = runRsp(proxyRoot, ["proxy", "--", command], {});

    expect(proxied.stdout).toEqual(raw.stdout);
    expect(proxied.stderr).toEqual(raw.stderr);
    expect(proxied.status).toBe(raw.status);
    expect(proxied.signal).toBe(raw.signal);
  });

  it("fails open to raw execution on proxy-internal error and records the decision", async () => {
    const root = await tempRoot();
    await enableRsp(root);

    const res = runRsp(root, ["proxy", "--", "printf 'ok\\n'"], { RSP_PROXY_FAIL_INTERNAL: "1" });

    expect(res.status).toBe(0);
    expect(res.stdout.toString("utf8")).toBe("ok\n");
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(readSpoolEvents(root)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({
        collection: RSP_DECISIONS_COLLECTION,
        decision: "failed-open",
        reason: "proxy-internal-error",
      }),
    ]));
  });

  it("normalizes latency budgets to the sampled baseline and still catches regressions", async () => {
    expect(localBaselineRatio(100)).toBe(4);
    expect(normalizedDurationMs(1_000, 100)).toBe(4_000);
    expect(normalizedTimeoutMs(100, 2, 1_000)).toBe(4_000);

    let attempts = 0;
    await expectLatencyBudget("test budget", budgetSample(200, 50, "first=200.0ms"), 3, async () => {
      attempts++;
      return budgetSample(130, 50, "retry=130.0ms");
    });

    expect(attempts).toBe(1);
    await expect(expectLatencyBudget("test budget", budgetSample(250, 50, "first=250.0ms"), 3, async () => {
      return budgetSample(220, 50, "retry=220.0ms");
    })).rejects.toThrow(/exceeded 3\.00x baseline twice/);
  });

  it("passes wrappers through without creating .red when rsp is not enabled", async () => {
    const root = await initGitRepo();
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "status", "--short"], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(direct.stderr);
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("restores the disabled passthrough notice under RSP_DEBUG", async () => {
    const root = await initGitRepo();
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "status", "--short"], { RSP_DEBUG: "1" });

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: rsp is not enabled in this directory; run /red-setup, passing through\n${direct.stderr.toString("utf8")}`);
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("doctor reports rsp disabled as a definitive finding, not an error", async () => {
    const root = await initGitRepo();

    const res = runRspFromCwd(root, ["doctor"], {});
    const decoded = decode(res.stdout.toString("utf8")) as {
      status: string;
      exit_code: number;
      probes: Array<{ name: string; pass: boolean; finding: string }>;
      errors: unknown[];
    };

    expect(res.status).toBe(0);
    expect(res.stderr).toEqual(Buffer.alloc(0));
    expect(decoded.status).toBe("disabled");
    expect(decoded.exit_code).toBe(0);
    expect(decoded.errors).toEqual([]);
    expect(decoded.probes.map((probe) => probe.name)).toEqual([
      "config_gate_resolution",
      "hook_wiring",
      "proxy_mode",
      "resident_liveness",
      "store_provisioning",
      "recent_degradation_rate",
      "overhead_budget",
    ]);
    expect(decoded.probes.find((probe) => probe.name === "config_gate_resolution")).toMatchObject({
      pass: true,
      finding: "rsp disabled in this directory; run /red-setup to opt in",
    });
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("doctor reports named red plumbing probes with shared structured fix commands", async () => {
    const root = await initGitRepo();
    await enableRsp(root);

    const res = runRspFromCwd(root, ["doctor"], {});
    const decoded = decode(res.stdout.toString("utf8")) as {
      status: string;
      exit_code: number;
      probes: Array<{
        name: string;
        pass: boolean;
        finding: string;
        fix_command?: string;
        error?: { command: string; category: string; exit_code: number; error: string; help: string[] };
      }>;
      errors: Array<{ command: string; category: string; exit_code: number; error: string; help: string[] }>;
    };

    expect(res.status).toBe(1);
    expect(res.stderr).toEqual(Buffer.alloc(0));
    expect(decoded.status).toBe("fail");
    expect(decoded.exit_code).toBe(1);
    expect(decoded.probes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "config_gate_resolution", pass: true, finding: "rsp.enabled resolved true for this directory" }),
      expect.objectContaining({ name: "hook_wiring", pass: true }),
      expect.objectContaining({ name: "proxy_mode", pass: true }),
      expect.objectContaining({ name: "resident_liveness", pass: false, fix_command: "rsp warm-resident" }),
      expect.objectContaining({ name: "store_provisioning", pass: false, fix_command: "rsp setup" }),
      expect.objectContaining({ name: "recent_degradation_rate", pass: true }),
    ]));
    for (const probe of decoded.probes.filter((entry) => !entry.pass)) {
      expect(probe.error).toMatchObject({
        command: `rsp doctor:${probe.name}`,
        category: "real-error",
        exit_code: 1,
        error: probe.finding,
        help: [probe.fix_command],
      });
    }
    expect(decoded.errors).toEqual(decoded.probes.filter((entry) => !entry.pass).map((entry) => entry.error));
  });

  it("doctor turns recent degradation spikes red with count and dominant reason", async () => {
    const root = await initGitRepo();
    await enableRsp(root);
    const storeUri = `file://${join(root, ".red", "state", "red-skills.rdb")}`;
    const store = await RspElisionStore.open({ uri: storeUri, allowResidentOpen: true });
    await store.close();
    const db = await connect(storeUri);
    try {
      await db.kv(RSP_ACCOUNTING_EVENTS_COLLECTION).put("ok", {
        created_at: new Date().toISOString(),
        event_type: "invocation",
        command: "git status",
        raw_bytes: 20,
        emitted_bytes: 20,
      });
      await db.kv(RSP_ACCOUNTING_EVENTS_COLLECTION).put("degraded-one", {
        created_at: new Date().toISOString(),
        event_type: "invocation",
        command: "git log",
        degradation_reason: "wrapper-crash",
        wrapper_family: "git",
        wrapper_exit_code: 1,
        stderr_head: "boom",
      });
      await db.kv(RSP_ACCOUNTING_EVENTS_COLLECTION).put("degraded-two", {
        created_at: new Date().toISOString(),
        event_type: "invocation",
        command: "git diff",
        degradation_reason: "wrapper-crash",
        wrapper_family: "git",
        wrapper_exit_code: 1,
        stderr_head: "boom",
      });
    } finally {
      await db.close();
    }

    const res = runRspFromCwd(root, ["doctor", "--since", "1d"], {});
    const decoded = decode(res.stdout.toString("utf8")) as {
      status: string;
      probes: Array<{
        name: string;
        pass: boolean;
        finding: string;
        fix_command?: string;
        error?: { category: string; help: string[] };
      }>;
    };
    const degradation = decoded.probes.find((probe) => probe.name === "recent_degradation_rate");

    expect(res.status).toBe(1);
    expect(decoded.status).toBe("fail");
    expect(degradation).toMatchObject({
      pass: false,
      finding: "2 degradation(s) in the recent 1d window; dominant reason wrapper-crash (2)",
      fix_command: "rsp stats --since 1d --full",
      error: { category: "real-error", help: ["rsp stats --since 1d --full"] },
    });
  });

  it("built bundle keeps disabled passthrough silent, debuggable, and distinct from enabled degradation", async () => {
    buildBundleOnce();
    const disabledRoot = await initGitRepo();
    await writeFile(join(disabledRoot, "untracked.txt"), "raw stdout\n", "utf8");
    const disabledDirect = runGit(["-C", disabledRoot, "status"]);

    const disabled = runBundleFromCwd(disabledRoot, ["git", "status"], { RSP_DEBUG: "0" });

    expect(disabled.status).toBe(disabledDirect.status);
    expect(disabled.stdout).toEqual(disabledDirect.stdout);
    expect(disabled.stderr).toEqual(disabledDirect.stderr);
    await expect(stat(join(disabledRoot, ".red"))).rejects.toMatchObject({ code: "ENOENT" });

    const debug = runBundleFromCwd(disabledRoot, ["git", "status"], { RSP_DEBUG: "1" });

    expect(debug.status).toBe(disabledDirect.status);
    expect(debug.stdout).toEqual(disabledDirect.stdout);
    expect(debug.stderr.toString("utf8")).toBe(`rsp: rsp is not enabled in this directory; run /red-setup, passing through\n${disabledDirect.stderr.toString("utf8")}`);

    const degradedRoot = await initGitRepo();
    await enableRsp(degradedRoot);
    await writeFile(join(degradedRoot, "untracked.txt"), "raw stdout\n", "utf8");
    const degradedDirect = runGit(["-C", degradedRoot, "status", "--short"]);

    const degraded = runBundleFromCwd(degradedRoot, ["git", "-C", degradedRoot, "status", "--short"], {
      RSP_DEBUG: "0",
    });

    expect(degraded.status).toBe(degradedDirect.status);
    expect(degraded.stdout).toEqual(degradedDirect.stdout);
    expect(degraded.stderr.toString("utf8")).toBe(`rsp: wrapper failed, passing through\n${degradedDirect.stderr.toString("utf8")}`);
  }, 120_000);

  it("server exits inert without creating a socket when rsp is not enabled", async () => {
    const root = await tempRoot();

    const res = runRspFromCwd(root, ["server", "--idle-ms", "10"], {});

    expect(res.status).toBe(0);
    expect(res.stdout.toString("utf8")).toBe("rsp is not enabled in this directory; run /red-setup\n");
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mcp boots inert with no config and answers status without side effects", async () => {
    const root = await tempRoot();

    const responses = await runMcpRequests(root, [
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "0" } },
      },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rsp_status", arguments: {} } },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "rsp_compress", arguments: { payload: Array.from({ length: 30 }, (_, i) => ({ id: i })) } },
      },
    ]);

    const list = responses.find((response) => response.id === 2) as { result: { tools: Array<{ name: string }> } };
    const status = responses.find((response) => response.id === 3) as { result: { content: Array<{ text: string }> } };
    const compress = responses.find((response) => response.id === 4) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status"]);
    expect(decode(status.result.content[0]!.text)).toMatchObject({
      tool: "rsp_status",
      enabled: false,
      status: "disabled",
      help: ["/red-setup"],
    });
    expect(compress.result.isError).toBe(true);
    expect(decode(compress.result.content[0]!.text)).toMatchObject({
      tool: "rsp_status",
      enabled: false,
      status: "disabled",
    });
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("mcp stays inert when config lacks an rsp block or disables rsp", async () => {
    const noRsp = await tempRoot();
    await mkdir(join(noRsp, ".red"), { recursive: true });
    await writeFile(join(noRsp, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n", "utf8");
    const disabled = await tempRoot();
    await mkdir(join(disabled, ".red"), { recursive: true });
    await writeFile(join(disabled, ".red", "config.yaml"), "rsp:\n  enabled: false\n", "utf8");

    for (const root of [noRsp, disabled]) {
      const responses = await runMcpRequests(root, [
        { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
        { jsonrpc: "2.0", id: 2, method: "tools/list" },
      ]);
      const list = responses.find((response) => response.id === 2) as { result: { tools: Array<{ name: string }> } };
      expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status"]);
      await expect(stat(join(root, ".red", "tmp", "rsp.sock"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, ".red", "state", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("mcp exposes resident tools and returns TOON tool responses when rsp is enabled", async () => {
    const root = await tempRoot();
    await enableRsp(root);

    const responses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "rsp_status", arguments: {} } },
      { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "rsp_stats", arguments: {} } },
      { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "rsp_show", arguments: { handle: "el:missing" } } },
    ]);

    const list = responses.find((response) => response.id === 2) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status", "rsp_stats", "rsp_show", "rsp_compress"]);
    const status = responses.find((response) => response.id === 3) as { result: { content: Array<{ text: string }> } };
    expect(decode(status.result.content[0]!.text)).toMatchObject({ tool: "rsp_status", enabled: true, status: "enabled" });
    const stats = responses.find((response) => response.id === 4) as { result: { content: Array<{ text: string }> } };
    expect(decode(stats.result.content[0]!.text)).toMatchObject({ tool: "rsp_stats", records: 0, bytes: 0 });
    const missing = responses.find((response) => response.id === 5) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(missing.result.isError).toBe(true);
    expect(decode(missing.result.content[0]!.text)).toMatchObject({
      tool: "rsp_show",
      handle: "el:missing",
      found: false,
      error: "not found",
    });
  });

  it("mcp compresses large JSON and rsp_show round-trips the elided original", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const payload = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      status: i === 27 ? 500 : 200,
      latency: i === 33 ? 4_500 : i,
      label: `row-${i}`,
    }));
    const original = JSON.stringify(payload);

    const compressedResponses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rsp_compress", arguments: { payload: original, level: "terse" } },
      },
    ]);

    const compressed = compressedResponses.find((response) => response.id === 2) as {
      result: { content: Array<{ text: string }> };
    };
    const text = compressed.result.content[0]!.text;
    expect(text).toContain("items:");
    expect(text).toContain("items[");
    expect(text).toContain("{id,status,latency,label}");
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const shownResponses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rsp_show", arguments: { handle } },
      },
    ]);

    const shown = shownResponses.find((response) => response.id === 2) as {
      result: { content: Array<{ text: string }> };
    };
    expect(decode(shown.result.content[0]!.text)).toMatchObject({
      tool: "rsp_show",
      found: true,
      text: original,
    });
  });

  it("built bundle mcp compress honors disabled gates and round-trips large JSON", async () => {
    const disabledRoot = await tempRoot();
    const disabledResponses = await runMcpRequests(disabledRoot, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rsp_compress", arguments: { payload: [{ id: 1 }], level: "brief" } },
      },
    ], "bundle");
    const disabled = disabledResponses.find((response) => response.id === 2) as {
      result: { content: Array<{ text: string }>; isError?: boolean };
    };
    expect(disabled.result.isError).toBe(true);
    expect(decode(disabled.result.content[0]!.text)).toMatchObject({
      tool: "rsp_status",
      enabled: false,
      status: "disabled",
    });
    await expect(stat(join(disabledRoot, ".red"))).rejects.toMatchObject({ code: "ENOENT" });

    const root = await tempRoot();
    await enableRsp(root);
    const payload = Array.from({ length: 60 }, (_, i) => ({ id: i, value: i, error: i === 41 ? "boom" : "" }));
    const original = JSON.stringify(payload);
    const compressedResponses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rsp_compress", arguments: { payload: original, level: "terse" } },
      },
    ], "bundle");
    const compressed = compressedResponses.find((response) => response.id === 2) as {
      result: { content: Array<{ text: string }> };
    };
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(compressed.result.content[0]!.text)?.[1];
    expect(handle).toBeTruthy();

    const shownResponses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "rsp_show", arguments: { handle } },
      },
    ], "bundle");
    const shown = shownResponses.find((response) => response.id === 2) as {
      result: { content: Array<{ text: string }> };
    };
    expect(decode(shown.result.content[0]!.text)).toMatchObject({
      tool: "rsp_show",
      found: true,
      text: original,
    });
  }, 120_000);

});
