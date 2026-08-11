import { describe, expect, it } from "vitest";
import { chmod } from "node:fs/promises";
import type { JsonObject } from "@reddb-io/toon";
import { encodeSnapshotToon } from "@reddb-io/shared/toon-migration.js";
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
  hangingGhPath,
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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Poll until no tracked pid is alive. Termination is asynchronous by nature —
 * the kernel reaps after the signal — so asserting "gone" needs a bounded wait,
 * not an instantaneous read that would be flaky in either direction.
 */
async function waitForNoLivePids(livePids: () => Promise<number[]>): Promise<void> {
  const deadline = Date.now() + normalizedDurationMs(10_000);
  let remaining = await livePids();
  while (Date.now() < deadline && remaining.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    remaining = await livePids();
  }
  expect(remaining).toEqual([]);
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + normalizedDurationMs(10_000);
  while (Date.now() < deadline) {
    if (await readFile(path, "utf8").then(() => true, () => false)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`file never appeared: ${path}`);
}

function encodeWaitRecord(record: JsonObject): string {
  return `${encodeSnapshotToon(record)}\n`;
}

describe("rsp cli", () => {
  it("prints rsp wait help with the standardized waiting contract", async () => {
    const root = await tempRoot();
    const actual = runRsp(root, ["wait", "--help"], {});

    expect(actual.status).toBe(0);
    const stdout = actual.stdout.toString("utf8");
    expect(stdout).toContain("usage: rsp wait <subcommand> [options]");
    expect(stdout).toContain("rsp wait pr 123");
    expect(stdout).toContain("rsp wait run --branch feature/wait --latest");
    expect(stdout).toContain("rsp wait job 93919316178");
    expect(stdout).toContain("rsp wait release --tag \"v2.*\" --existing");
    expect(stdout).toContain("rsp wait cmd -- \"pnpm -C apps/rsp build\"");
    expect(stdout).toContain("Exit codes: 0 = success verdict, 1 = failure verdict, 2 = timeout/indeterminate.");
  });

  it("wait rejects an invalid completion signal through the indeterminate semaphore", async () => {
    const root = await tempRoot();
    const actual = runRsp(root, ["wait", "cmd", "--json", "--signal", "NOPE", "--", "true"], {});

    expect(actual.status).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      schema: "rsp.wait.result",
      version: 1,
      wait: { kind: "cmd", status: "indeterminate" },
      verdict: { exit_code: 2, target_exit_code: 2, summary: "invalid signal: SIGNOPE" },
    });
    expect(actual.stderr.toString("utf8")).toBe("");
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

    expect(actual.status, `${actual.stderr.toString("utf8")}\n${actual.stdout.toString("utf8")}`).toBe(0);
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

    expect(actual.status, `${actual.stderr.toString("utf8")}\n${actual.stdout.toString("utf8")}`).toBe(0);
    expect(Number(await readFile(fakeGh.countFile, "utf8"))).toBeGreaterThan(1);
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { status: string };
      verdict: { summary: string; details: { checks: number; mergeable: string } };
    };
    expect(decoded.wait.status).toBe("success");
    expect(decoded.verdict.summary).toBe("PR #123 has no checks configured");
    expect(decoded.verdict.details).toMatchObject({ checks: 0, mergeable: "MERGEABLE" });
  });

  it("wait pr treats a CLEAN pr with zero checks as a genuine no-check repository", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [{ number: 123, state: "OPEN", mergeable: "CLEAN", statusCheckRollup: [] }]);

    const actual = runRsp(root, ["wait", "pr", "123", "--timeout", "4s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
      RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS: "100ms",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { status: string };
      verdict: { summary: string; details: { checks: number; mergeable: string } };
    };
    expect(decoded.wait.status).toBe("success");
    expect(decoded.verdict.summary).toBe("PR #123 has no checks configured");
    expect(decoded.verdict.details).toMatchObject({ checks: 0, mergeable: "CLEAN" });
  });

  it("wait pr keeps polling a BLOCKED pr with zero checks until its required checks register", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [
      { number: 123, state: "OPEN", mergeable: "BLOCKED", statusCheckRollup: [] },
      { number: 123, state: "OPEN", mergeable: "BLOCKED", statusCheckRollup: [] },
      { number: 123, state: "OPEN", mergeable: "BLOCKED", statusCheckRollup: [] },
      { number: 123, state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
    ]);

    const actual = runRsp(root, ["wait", "pr", "123", "--timeout", "4s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
      // The grace window is already spent by the first poll, so only the
      // BLOCKED reading itself can keep this wait running.
      RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS: "1ms",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    expect(Number(await readFile(fakeGh.countFile, "utf8"))).toBeGreaterThan(3);
    const decoded = decode(actual.stdout.toString("utf8")) as {
      wait: { status: string };
      verdict: { summary: string; details: { checks: number; mergeable: string } };
    };
    expect(decoded.wait.status).toBe("success");
    // Never "has no checks configured": BLOCKED with zero checks proves checks
    // are required, so the only success it may reach is a real green rollup.
    expect(decoded.verdict.summary).toBe("PR #123 checks passed");
    expect(decoded.verdict.details).toMatchObject({ checks: 1, mergeable: "MERGEABLE" });
  });

  it("wait pr times out indeterminate when a BLOCKED pr never registers its checks", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [{ number: 123, state: "OPEN", mergeable: "BLOCKED", statusCheckRollup: [] }]);

    const actual = runRsp(root, ["wait", "pr", "123", "--json", "--timeout", "1s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
      RSP_WAIT_PR_EMPTY_CHECKS_GRACE_MS: "1ms",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "timeout" },
      verdict: { exit_code: 2, target_exit_code: 2 },
    });
  });

  it("wait pr fails when checks pass but the PR conflicts", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [
      { number: 123, state: "OPEN", mergeable: "CONFLICTING", statusCheckRollup: [{ conclusion: "SUCCESS" }] },
    ]);

    const actual = runRsp(root, ["wait", "pr", "123", "--json", "--timeout", "2s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_PR_POLL_MS: "10ms",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(1);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "failure" },
      verdict: { exit_code: 1, summary: "PR #123 has merge conflicts", details: { mergeable: "CONFLICTING" } },
    });
  });

  it("two concurrent PR waits both exit with sealed verdicts and no registry leak", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    const bin = join(root, "bin");
    const readyFile = join(root, "pr-ready");
    const forwarderPids = join(root, "forwarder-pids");
    const gh = join(bin, "gh");
    await mkdir(bin, { recursive: true });
    await writeFile(
      gh,
      [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        'if [ "${1:-}" = "webhook" ] && [ "${2:-}" = "forward" ]; then',
        '  printf "%s\\n" "$$" >> "$GH_FORWARDER_PIDS"',
        "  exec \"$GH_NODE_BIN\" -e 'setInterval(() => {}, 1000)'",
        "fi",
        'if [ -f "$GH_PR_READY_FILE" ]; then',
        '  printf \'%s\\n\' \'{"number":123,"state":"OPEN","mergeable":"MERGEABLE","statusCheckRollup":[{"conclusion":"SUCCESS"}]}\'',
        "else",
        '  printf \'%s\\n\' \'{"number":123,"state":"OPEN","mergeable":"UNKNOWN","statusCheckRollup":[{"conclusion":null,"status":"IN_PROGRESS"}]}\'',
        "fi",
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(gh, 0o755);

    const reasons = ["concurrent wait one", "concurrent wait two"];
    const resultFiles = reasons.map((_, index) => join(root, `wait-${index + 1}.json`));
    const env = {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      GH_FORWARDER_PIDS: forwarderPids,
      GH_NODE_BIN: process.execPath,
      GH_PR_READY_FILE: readyFile,
      RSP_WAIT_PR_POLL_MS: "10ms",
    };
    const children = reasons.map((reason, index) => {
      const child = spawn(process.execPath, [
        "--import", tsxLoader, cli, "wait", "pr", "123", "--json",
        "--reason", reason, "--result-file", resultFiles[index]!, "--timeout", "60s",
      ], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      return { child, stdout, stderr };
    });

    try {
      const active = await Promise.all(reasons.map((reason) => waitForActiveWait(root, reason)));
      expect(new Set(active.map((entry) => entry.id)).size).toBe(2);
      await writeFile(readyFile, "ready\n", "utf8");

      const closed = await Promise.allSettled(
        children.map(({ child }) => closeWithTimeout(child, normalizedDurationMs(2_000))),
      );
      for (const [index, outcome] of closed.entries()) {
        expect(outcome.status, children[index]!.stderr.toString()).toBe("fulfilled");
        if (outcome.status === "fulfilled") expect(outcome.value).toBe(0);
      }
      for (const [index, resultFile] of resultFiles.entries()) {
        expect(JSON.parse(await readFile(resultFile, "utf8"))).toMatchObject({
          wait: { target: "pr:123", status: "success", reason: reasons[index] },
          verdict: { target_exit_code: 0, exit_code: 0, delivery: { status: "success" } },
        });
      }
      expect((decode(runRsp(root, ["wait", "ls"], {}).stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
      const pids = (await readFile(forwarderPids, "utf8"))
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      expect(pids).toHaveLength(2);
      expect(pids.filter(isPidAlive)).toEqual([]);
    } finally {
      for (const { child } of children) {
        if (isPidAlive(child.pid ?? 0)) child.kill("SIGKILL");
      }
      const pids = (await readFile(forwarderPids, "utf8").catch(() => ""))
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      for (const pid of pids) {
        if (isPidAlive(pid)) process.kill(pid, "SIGKILL");
      }
    }
  });

  it("wait run pins branch latest to one run id before polling", async () => {
    const root = await tempRoot();
    const fakeGh = await fakeGhPath(root, [
      { workflow_runs: [{ id: 111 }] },
      { id: 111, status: "in_progress", conclusion: null, name: "CI", head_branch: "feature/wait" },
      { id: 111, status: "completed", conclusion: "success", name: "CI", head_branch: "feature/wait" },
    ]);

    const actual = runRsp(root, ["wait", "run", "--branch", "feature/wait", "--latest", "--json", "--timeout", "2s"], {
      PATH: fakeGh.path,
      GH_FAKE_RESPONSES: fakeGh.responsesDir,
      RSP_WAIT_RUN_POLL_MS: "10ms",
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    expect(Number(await readFile(fakeGh.countFile, "utf8"))).toBe(3);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { target: "run:111", status: "success" },
      verdict: { exit_code: 0, summary: "run 111 succeeded" },
    });
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

  it("wait cmd writes a versioned JSON result with bounded stdout and stderr capture", async () => {
    const root = await tempRoot();
    const resultFile = join(root, "wait-result.json");
    const command = `${shellQuote(process.execPath)} -e "process.stdout.write('hello'); process.stderr.write('warning')"`;

    const actual = runRsp(root, [
      "wait", "cmd", "--json", "--result-file", resultFile, "--capture-bytes", "64", "--", command,
    ], {});

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const stdoutResult = JSON.parse(actual.stdout.toString("utf8")) as Record<string, unknown>;
    const fileResult = JSON.parse(await readFile(resultFile, "utf8")) as Record<string, unknown>;
    expect(stdoutResult).toEqual(fileResult);
    expect(stdoutResult).toMatchObject({
      schema: "rsp.wait.result",
      version: 1,
      wait: { kind: "cmd", status: "success" },
      verdict: {
        exit_code: 0,
        delivery: { status: "success" },
        details: {
          stdout: { bytes: 5, inline: "hello", truncated: false },
          stderr: { bytes: 7, inline: "warning", truncated: false },
        },
      },
    });
    expect((await readdir(root)).some((name) => name.includes("wait-result.json.tmp"))).toBe(false);
  });

  it("wait cmd gives truncated output an elision handle with byte-exact recovery", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "wait-store.json")}`;
    const command = `${shellQuote(process.execPath)} -e "process.stdout.write('abcdefghijklmnopqrstuvwxyz')"`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--capture-bytes", "5", "--", command], {
      RSP_STORE_URI: storeUri,
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const result = JSON.parse(actual.stdout.toString("utf8")) as {
      verdict: { details: { stdout: { bytes: number; inline: string; truncated: boolean; handle: string } } };
    };
    expect(result.verdict.details.stdout).toMatchObject({ bytes: 26, inline: "abcde", truncated: true });
    expect(result.verdict.details.stdout.handle).toMatch(/^el:[a-f0-9]{12}$/);
    const recovered = runRsp(root, ["show", result.verdict.details.stdout.handle], { RSP_STORE_URI: storeUri });
    expect(recovered.status).toBe(0);
    expect(recovered.stdout.toString("utf8")).toBe("abcdefghijklmnopqrstuvwxyz");
  });

  it("wait cmd kills the complete descendant process group on timeout", async () => {
    const root = await tempRoot();
    const pidFile = join(root, "descendant.pid");
    const script = [
      "const { spawn } = require('node:child_process')",
      "const { writeFileSync } = require('node:fs')",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })",
      `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid))`,
      "setInterval(() => {}, 1000)",
    ].join(";");
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--timeout", "300ms", "--terminate-grace", "100ms", "--", command], {});

    expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "timeout" },
      verdict: { exit_code: 2, target_exit_code: 2 },
    });
    const descendantPid = Number(await readFile(pidFile, "utf8"));
    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("wait handles SIGTERM as an indeterminate result and cleans up the command tree", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    const command = `${shellQuote(process.execPath)} -e "setInterval(() => {}, 1000)"`;
    const child = spawn(process.execPath, [
      "--import", tsxLoader, cli, "wait", "cmd", "--json", "--reason", "interrupt probe", "--", command,
    ], { cwd: root, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    await waitForActiveWait(root, "interrupt probe");
    child.kill("SIGTERM");
    const status = await closeWithTimeout(child, normalizedDurationMs(10_000));

    expect(status, Buffer.concat(stderr).toString("utf8")).toBe(2);
    expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({
      wait: { status: "indeterminate" },
      verdict: { exit_code: 2, summary: "wait interrupted by SIGTERM" },
    });
    expect((decode(runRsp(root, ["wait", "ls"], {}).stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
  });

  it("wait ls sweeps the registry record left by an externally killed wait", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    const fakeGh = await fakeGhPath(root, [{}]);
    const child = spawn(process.execPath, [
      "--import", tsxLoader, cli, "wait", "release", "--tag", "never-*",
      "--reason", "external kill probe", "--timeout", "60s",
    ], {
      cwd: root,
      env: { ...process.env, PATH: fakeGh.path, GH_FAKE_RESPONSES: fakeGh.responsesDir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.resume();
    child.stderr.resume();

    await waitForActiveWait(root, "external kill probe");
    child.kill("SIGKILL");
    await closeWithTimeout(child, normalizedDurationMs(10_000));
    const waitsDir = join(root, ".red", "tmp", "waits");
    expect(await readdir(waitsDir)).toHaveLength(1);

    const listed = runRsp(root, ["wait", "ls"], {});
    expect(listed.status).toBe(0);
    expect((decode(listed.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
    expect(await readdir(waitsDir)).toEqual([]);
  });

  it("wait reports notify delivery failure without losing the successful target verdict", async () => {
    const root = await tempRoot();
    const command = `${shellQuote(process.execPath)} -e "process.exit(0)"`;
    const notify = `${shellQuote(process.execPath)} -e "process.exit(7)"`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--notify-cmd", notify, "--", command], {});

    expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "success" },
      verdict: {
        exit_code: 2,
        target_exit_code: 0,
        delivery: { status: "failure", errors: [{ hook: "notify-cmd", status: 7 }] },
      },
    });
  });

  it("wait keeps timeout a real upper bound when a GitHub probe hangs, and reclaims the gh process", async () => {
    const root = await tempRoot();
    const hanging = await hangingGhPath(root);

    const started = Date.now();
    const actual = runRsp(root, ["wait", "pr", "123", "--json", "--timeout", "2s", "--probe-timeout", "300ms"], {
      PATH: hanging.path,
      RSP_WAIT_PR_POLL_MS: "10ms",
    });
    const elapsedMs = Date.now() - started;

    expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "timeout" },
      verdict: { exit_code: 2, target_exit_code: 2 },
    });
    // The wait honored its own deadline instead of blocking on `sleep 600`.
    expect(elapsedMs).toBeLessThan(normalizedDurationMs(30_000));
    // The probe attempted repeatedly rather than hanging on the first call.
    const result = JSON.parse(actual.stdout.toString("utf8")) as { verdict: { details?: { attempts?: number } } };
    expect(result.verdict.details?.attempts ?? 0).toBeGreaterThan(1);
    await waitForNoLivePids(hanging.livePids);
  });

  it("wait terminates a hung GitHub probe when SIGTERM arrives mid-poll", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    const hanging = await hangingGhPath(root);
    const child = spawn(process.execPath, [
      "--import", tsxLoader, cli, "wait", "pr", "123", "--json", "--reason", "probe interrupt", "--timeout", "60s",
    ], {
      cwd: root,
      env: { ...process.env, PATH: hanging.path, RSP_WAIT_PR_POLL_MS: "10ms" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));

    await waitForActiveWait(root, "probe interrupt");
    child.kill("SIGTERM");
    const status = await closeWithTimeout(child, normalizedDurationMs(20_000));

    expect(status, Buffer.concat(stderr).toString("utf8")).toBe(2);
    expect(JSON.parse(Buffer.concat(stdout).toString("utf8"))).toMatchObject({
      wait: { status: "indeterminate" },
      verdict: { exit_code: 2, summary: "wait interrupted by SIGTERM" },
    });
    await waitForNoLivePids(hanging.livePids);
    expect((decode(runRsp(root, ["wait", "ls"], {}).stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
  });

  it("wait cmd reaps a deep detached descendant tree, repeatedly", async () => {
    const root = await tempRoot();
    // Two runs of the same scenario: cleanup must be reliable, not lucky.
    for (const attempt of [1, 2]) {
      const pidFile = join(root, `descendants-${attempt}.pids`);
      const script = [
        "const { spawn } = require('node:child_process')",
        "const { appendFileSync } = require('node:fs')",
        "let depth = 0",
        "const spawnChild = () => spawn(process.execPath, ['-e', \"setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' })",
        "for (depth = 0; depth < 5; depth++) {",
        `  appendFileSync(${JSON.stringify(pidFile)}, String(spawnChild().pid) + '\\n')`,
        "}",
        "setInterval(() => {}, 1000)",
      ].join(";");
      const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

      const actual = runRsp(root, [
        "wait", "cmd", "--json", "--timeout", "500ms", "--terminate-grace", "150ms", "--", command,
      ], {});

      expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
      expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({ wait: { status: "timeout" } });
      const pids = (await readFile(pidFile, "utf8"))
        .split("\n")
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
      expect(pids.length).toBe(5);
      await waitForNoLivePids(async () => pids.filter(isPidAlive));
    }
  });

  it("wait cmd keeps large stdout byte-exact through a bounded capture", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "wait-store.json")}`;
    // 2 MiB through a 64-byte inline window: memory stays bounded, bytes do not.
    const script = "const line = 'x'.repeat(1023) + '\\n'; for (let i = 0; i < 2048; i++) process.stdout.write(line)";
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--capture-bytes", "64", "--", command], {
      RSP_STORE_URI: storeUri,
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const stdout = (JSON.parse(actual.stdout.toString("utf8")) as {
      verdict: { details: { stdout: { bytes: number; inline: string; truncated: boolean; handle: string } } };
    }).verdict.details.stdout;
    expect(stdout.bytes).toBe(2048 * 1024);
    expect(stdout.truncated).toBe(true);
    expect(stdout.inline).toBe("x".repeat(64));
    expect(stdout.handle).toMatch(/^el:[a-f0-9]{12}$/);

    // Recovered through the store rather than a pipe: 2 MiB exceeds spawnSync's
    // maxBuffer, and a truncated pipe would prove nothing about the bytes.
    const store = await RspElisionStore.open({ uri: storeUri });
    try {
      const record = await store.get(stdout.handle);
      expect(isRecord(record) && "original" in record).toBe(true);
      const original = (record as { original: Buffer }).original;
      expect(original.length).toBe(2048 * 1024);
      expect(original.equals(Buffer.from(("x".repeat(1023) + "\n").repeat(2048), "utf8"))).toBe(true);
    } finally {
      await store.close();
    }
    // The spool is a staging area, not a leak: it is gone once the store has the bytes.
    expect(await readdir(join(root, ".red", "tmp", "waits", "spool")).catch(() => [])).toEqual([]);
  });

  it("wait cmd preserves binary stdout exactly and labels the inline encoding", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "wait-store.json")}`;
    // 0x80-0xFF is not valid UTF-8, so a naive string round trip would corrupt it.
    const script = "process.stdout.write(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))";
    const command = `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--capture-bytes", "16", "--", command], {
      RSP_STORE_URI: storeUri,
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const stdout = (JSON.parse(actual.stdout.toString("utf8")) as {
      verdict: { details: { stdout: { bytes: number; inline: string; inline_encoding?: string; handle: string } } };
    }).verdict.details.stdout;
    expect(stdout.bytes).toBe(256);
    expect(stdout.inline_encoding).toBe("base64");
    expect(Buffer.from(stdout.inline, "base64").equals(Buffer.from(Array.from({ length: 16 }, (_, i) => i)))).toBe(true);

    const recovered = runRsp(root, ["show", stdout.handle], { RSP_STORE_URI: storeUri });
    expect(recovered.status).toBe(0);
    expect(recovered.stdout.equals(Buffer.from(Array.from({ length: 256 }, (_, i) => i)))).toBe(true);
  });

  it("wait cmd keeps elided bytes on disk when the elision store is unavailable", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    // The store path's parent is a regular FILE, so the store can never be
    // opened there — a faithful stand-in for "the store is unavailable".
    await writeFile(join(root, "blocker"), "not a directory\n", "utf8");
    const storeUri = `file://${join(root, "blocker", "red.rdb")}`;
    const command = `${shellQuote(process.execPath)} -e "process.stdout.write('abcdefghijklmnopqrstuvwxyz')"`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--capture-bytes", "5", "--", command], {
      RSP_STORE_URI: storeUri,
    });

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const stdout = (JSON.parse(actual.stdout.toString("utf8")) as {
      verdict: { details: { stdout: { bytes: number; inline: string; truncated: boolean; handle?: string; recovery_error?: string; spool_path?: string } } };
    }).verdict.details.stdout;
    expect(stdout).toMatchObject({ bytes: 26, inline: "abcde", truncated: true });
    // No handle is claimed that could not be minted...
    expect(stdout.handle).toBeUndefined();
    expect(stdout.recovery_error).toBeTruthy();
    // ...and not one byte was lost: the spool still holds the original stream.
    expect(stdout.spool_path).toBeTruthy();
    expect(await readFile(stdout.spool_path!, "utf8")).toBe("fghijklmnopqrstuvwxyz");
  });

  it("wait exposes a stable complete result to the process it wakes", async () => {
    const root = await tempRoot();
    const resultFile = join(root, "wake-result.toon");
    const observed = join(root, "observed.toon");
    // The notify hook stands in for the sleeper: it reads the result file at the
    // instant it is woken, so whatever it sees is what a real sleeper sees.
    const notify = `${shellQuote(process.execPath)} -e ${shellQuote(
      `require('node:fs').copyFileSync(process.env.RSP_WAIT_RESULT_FILE, ${JSON.stringify(observed)})`,
    )}`;
    const command = `${shellQuote(process.execPath)} -e "process.exit(0)"`;

    const actual = runRsp(root, [
      "wait", "cmd", "--result-file", resultFile, "--notify-cmd", notify, "--", command,
    ], {});

    expect(actual.status, actual.stderr.toString("utf8")).toBe(0);
    const atWake = decode(await readFile(observed, "utf8")) as {
      schema: string;
      wait: { status: string; completed_at: string };
      verdict: { target_exit_code: number; delivery: { status: string } };
    };
    // Complete and already decided about the TARGET at the moment of the wake...
    expect(atWake.schema).toBe("rsp.wait.result");
    expect(atWake.wait.status).toBe("success");
    expect(atWake.verdict.target_exit_code).toBe(0);
    expect(atWake.wait.completed_at).toBeTruthy();
    // ...while delivery is honestly still in flight, never a provisional success.
    expect(atWake.verdict.delivery.status).toBe("pending");

    const settled = decode(await readFile(resultFile, "utf8")) as {
      wait: { status: string; completed_at: string };
      verdict: { target_exit_code: number; exit_code: number; delivery: { status: string } };
    };
    // The target verdict is identical before and after delivery settles.
    expect(settled.wait.status).toBe(atWake.wait.status);
    expect(settled.wait.completed_at).toBe(atWake.wait.completed_at);
    expect(settled.verdict.target_exit_code).toBe(atWake.verdict.target_exit_code);
    expect(settled.verdict.delivery.status).toBe("success");
    expect(settled.verdict.exit_code).toBe(0);
  });

  it("wait refuses to signal a pid that is no longer the process it was given", async () => {
    const root = await tempRoot();
    // A process that is alive at parse time and gone before delivery: the only
    // safe move is to report a delivery failure rather than signal whoever
    // inherits that pid number next.
    //
    // It must be ORPHANED, not our own child: an unreaped child lingers as a
    // zombie, and a zombie still answers `kill(pid, 0)`, so the test would be
    // asserting against a process that never really went away.
    const victimPidFile = join(root, "victim.pid");
    const victimScript = [
      `require('node:fs').writeFileSync(${JSON.stringify(victimPidFile)}, String(process.pid))`,
      "setTimeout(() => process.exit(0), 4000)",
    ].join(";");
    const spawned = runShellFromCwd(
      root,
      `setsid ${shellQuote(process.execPath)} -e ${shellQuote(victimScript)} >/dev/null 2>&1 &`,
    );
    expect(spawned.status).toBe(0);
    // The orphan reports its OWN pid: `$!` would name the short-lived `setsid`
    // wrapper, which is already gone by the time the wait validates it.
    await waitForFile(victimPidFile);
    const victimPid = Number((await readFile(victimPidFile, "utf8")).trim());
    expect(isPidAlive(victimPid)).toBe(true);
    // The victim must outlive CLI startup (so parse-time validation passes) and
    // die before the command finishes (so delivery meets a vacated pid).
    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 9000)"`;

    const actual = runRsp(root, ["wait", "cmd", "--json", "--signal-pid", String(victimPid), "--", command], {});

    expect(actual.status, actual.stderr.toString("utf8")).toBe(2);
    expect(JSON.parse(actual.stdout.toString("utf8"))).toMatchObject({
      wait: { status: "success" },
      verdict: {
        target_exit_code: 0,
        exit_code: 2,
        delivery: { status: "failure", errors: [{ hook: "signal-pid", pid: victimPid }] },
      },
    });
  });

  it("wait ls drops a record whose pid was recycled by another process", async () => {
    const root = await tempRoot();
    const waits = join(root, ".red", "tmp", "waits");
    await mkdir(waits, { recursive: true });
    // This process is alive, but the recorded start time belongs to a different
    // process that merely held the same pid earlier.
    await writeFile(
      join(waits, `${randomUUID()}.toon`),
      encodeWaitRecord({
        schema: "rsp.wait.registry",
        version: 1,
        id: randomUUID(),
        kind: "cmd",
        target: "cmd:recycled",
        reason: "recycled pid",
        pid: process.pid,
        pid_start_time: "1",
        started_at: new Date().toISOString(),
        deadline_at: new Date().toISOString(),
        timeout_ms: 1000,
        poll_tier: "local-cmd:event-driven",
        status: "running",
        attempts: 0,
      }),
      "utf8",
    );

    const listed = runRsp(root, ["wait", "ls"], {});

    expect(listed.status).toBe(0);
    expect((decode(listed.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
    expect(await readdir(waits)).toEqual([]);
  });

  it("wait ls survives a corrupted registry record and removes it", async () => {
    const root = await tempRoot();
    const waits = join(root, ".red", "tmp", "waits");
    await mkdir(waits, { recursive: true });
    await writeFile(join(waits, "corrupt.toon"), "this is not: [a valid record\n ", "utf8");
    await writeFile(join(waits, "truncated.json"), '{"pid": 1234, "target": "cmd:hal', "utf8");

    const listed = runRsp(root, ["wait", "ls"], {});

    expect(listed.status, listed.stderr.toString("utf8")).toBe(0);
    expect((decode(listed.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
    expect(await readdir(waits)).toEqual([]);
  });

  it("wait shares one registry identity between a linked worktree and its main checkout", async () => {
    const root = await initGitRepo();
    await writeFile(join(root, "seed.txt"), "seed\n", "utf8");
    expect(runGit(["-C", root, "add", "seed.txt"]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", "seed"]).status).toBe(0);
    const linked = join(root, "linked-worktree");
    expect(runGit(["-C", root, "worktree", "add", "-b", "wait-identity", linked]).status).toBe(0);

    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 8000)"`;
    const child = spawn(process.execPath, [
      "--import", tsxLoader, cli, "wait", "cmd", "--reason", "worktree probe", "--", command,
    ], { cwd: linked, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.resume();
    child.stderr.resume();

    try {
      // Started in the linked worktree, but visible from the main checkout:
      // both resolve to the same repo identity, so there is only ONE registry.
      const fromMain = await waitForActiveWait(root, "worktree probe");
      expect(fromMain.target).toContain("cmd:");
      const fromLinked = await waitForActiveWait(linked, "worktree probe");
      expect(fromLinked.id).toBe(fromMain.id);
      expect(await readdir(join(root, ".red", "tmp", "waits"))).toHaveLength(1);
    } finally {
      child.kill("SIGTERM");
      await closeWithTimeout(child, normalizedDurationMs(15_000)).catch(() => undefined);
    }
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
    expect(listed).toMatchObject({
      schema: "rsp.wait.registry",
      version: 1,
      kind: "cmd",
      pid: expect.any(Number),
      pid_start_time: expect.any(String),
      deadline_at: expect.any(String),
      timeout_ms: 1_800_000,
      attempts: 0,
    });
    expect(listed.status).toBe("running");
    expect(listed.poll_tier).toBe("local-cmd:event-driven");
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
    const mintedAt = new Date();
    const store = await RspElisionStore.open({
      uri: storeUri,
      ephemeralTtlHours: 720,
      now: () => mintedAt,
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
    expect(decoded.store.oldest).toBe(mintedAt.toISOString());
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
