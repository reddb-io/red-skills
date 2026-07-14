import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import { connect } from "@reddb-io/sdk";
import { decode } from "@reddb-io/toon";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { RspElisionStore } from "../src/elision-store.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import {
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
  telemetrySpoolPath,
} from "../src/telemetry.js";

const roots: string[] = [];
const residentDirs: string[] = [];
const residentPathsBySocket = new Map<string, ReturnType<typeof resolveResidentPaths>>();
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const packageRoot = join(import.meta.dirname, "..");
const repoRoot = join(packageRoot, "..", "..");
const bundle = join(repoRoot, "dist", "rsp.bundle.min.mjs");
const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");
let bundleBuilt = false;

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-cli-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const rootsToRemove = roots.splice(0);
  await stopTrackedResidents(rootsToRemove);
  const residentDirsToRemove = residentDirs.splice(0);
  await Promise.all(rootsToRemove.map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(residentDirsToRemove.map((dir) => rm(dir, { recursive: true, force: true })));
});

afterAll(async () => {
  await stopTrackedResidents([]);
});

function trackedResidentPaths(root: string) {
  const paths = resolveResidentPaths(root);
  residentPathsBySocket.set(paths.socketPath, paths);
  residentDirs.push(dirname(paths.socketPath));
  return paths;
}

function runRsp(root: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    encoding: "buffer",
  });
}

function runRspFromCwd(cwd: string, args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "buffer",
  });
}

function runGit(args: string[]) {
  return spawnSync("git", args, { encoding: "buffer" });
}

function runShellFromCwd(cwd: string, command: string) {
  return spawnSync(command, {
    cwd,
    shell: true,
    encoding: "buffer",
  });
}

function runNodeNoop() {
  return spawnSync(process.execPath, ["-e", ""], { encoding: "buffer" });
}

function runBundleFromCwd(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    env: { ...process.env, RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(TEST_TELEMETRY_DRAIN_TIMEOUT_MS), ...env },
    encoding: "buffer",
  });
}

function runBundleHookFromCwd(cwd: string, command: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundle, "hook", "claude-pre-exec"], {
    cwd,
    env: { ...process.env, RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(TEST_TELEMETRY_DRAIN_TIMEOUT_MS), ...env },
    input: Buffer.from(JSON.stringify({ cwd, tool_input: { command } })),
    encoding: "buffer",
  });
}

function runBundleCodexHookFromCwd(cwd: string, command: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundle, "hook", "codex-pre-exec"], {
    cwd,
    env: { ...process.env, RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(TEST_TELEMETRY_DRAIN_TIMEOUT_MS), ...env },
    input: Buffer.from(JSON.stringify({ cwd, tool_name: "bash", tool_input: { command } })),
    encoding: "buffer",
  });
}

function runBundleFromCwdAsync(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd,
      env: { ...process.env, RSP_TELEMETRY_DRAIN_TIMEOUT_MS: String(TEST_TELEMETRY_DRAIN_TIMEOUT_MS), ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) }));
  });
}

function timedStatus(command: () => ReturnType<typeof spawnSync>): {
  status: number | null;
  elapsedMs: number;
  stdout: Buffer;
  stderr: Buffer;
} {
  const started = process.hrtime.bigint();
  const result = command();
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1_000_000;
  return { status: result.status, elapsedMs, stdout: result.stdout as Buffer, stderr: result.stderr as Buffer };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

type LatencyBudgetSample = { valueMs: number; baselineMs: number; details: string };

function budgetSample(valueMs: number, baselineMs: number, details: string): LatencyBudgetSample {
  return { valueMs, baselineMs, details };
}

function latencyRatio(sample: LatencyBudgetSample): number {
  return sample.valueMs / Math.max(1, sample.baselineMs);
}

function latencyBudgetDetails(sample: LatencyBudgetSample): string {
  return `${sample.details}; ratio=${latencyRatio(sample).toFixed(2)}x baseline=${sample.baselineMs.toFixed(1)}ms`;
}

function normalizedTimeoutMs(baselineMs: number, multiplier: number, minMs: number): number {
  return Math.max(normalizedDurationMs(minMs, baselineMs), Math.ceil(Math.max(1, baselineMs) * multiplier));
}

const REFERENCE_NODE_NOOP_MS = 25;
const TEST_NODE_NOOP_BASELINE_MS = timedStatus(runNodeNoop).elapsedMs;

function localBaselineRatio(baselineMs = TEST_NODE_NOOP_BASELINE_MS): number {
  return Math.max(1, Math.max(1, baselineMs) / REFERENCE_NODE_NOOP_MS);
}

function normalizedDurationMs(durationMs: number, baselineMs = TEST_NODE_NOOP_BASELINE_MS): number {
  return Math.ceil(durationMs * localBaselineRatio(baselineMs));
}

function normalizedLatencyRatio(maxRatio: number): number {
  return maxRatio * localBaselineRatio();
}

function normalizedDeadlineMs(durationMs = 5_000): number {
  return Date.now() + normalizedDurationMs(durationMs);
}

const TEST_TELEMETRY_DRAIN_TIMEOUT_MS = normalizedTimeoutMs(TEST_NODE_NOOP_BASELINE_MS, 250, 2_000);

async function idleBeat(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function expectLatencyBudget(
  label: string,
  first: LatencyBudgetSample,
  maxRatio: number,
  retry: () => LatencyBudgetSample | Promise<LatencyBudgetSample>,
): Promise<void> {
  if (latencyRatio(first) <= maxRatio) return;

  await idleBeat();
  const second = await retry();
  expect(
    latencyRatio(second),
    `${label} exceeded ${maxRatio.toFixed(2)}x baseline twice; ` +
      `first ${latencyBudgetDetails(first)}; retry ${latencyBudgetDetails(second)}`,
  ).toBeLessThanOrEqual(maxRatio);
}

function buildBundleOnce() {
  if (bundleBuilt) return;
  const res = spawnSync("pnpm", ["-C", "apps/rsp", "build"], {
    cwd: repoRoot,
    encoding: "buffer",
  });
  expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
  bundleBuilt = true;
}

async function initGitRepo(): Promise<string> {
  const root = await tempRoot();
  const init = runGit(["-C", root, "init"]);
  expect(init.status).toBe(0);
  expect(runGit(["-C", root, "config", "user.email", "rsp-test@example.invalid"]).status).toBe(0);
  expect(runGit(["-C", root, "config", "user.name", "Rsp Test"]).status).toBe(0);
  return root;
}

async function enableRsp(root: string): Promise<void> {
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");
}

async function commitMany(root: string, count: number): Promise<void> {
  for (let i = 1; i <= count; i++) {
    await writeFile(join(root, `file-${i}.txt`), `line ${i}\n`, "utf8");
    expect(runGit(["-C", root, "add", `file-${i}.txt`]).status).toBe(0);
    expect(runGit(["-C", root, "commit", "-m", `commit ${i}`]).status).toBe(0);
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function runMcpRequests(
  cwd: string,
  requests: Array<Record<string, unknown>>,
  entry: "source" | "bundle" = "source",
): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const timeoutMs = normalizedTimeoutMs(timedStatus(runNodeNoop).elapsedMs, 250, 10_000);
    const expectedResponses = requests.filter((request) => "id" in request).length;
    if (entry === "bundle") buildBundleOnce();
    const childArgs = entry === "bundle" ? [bundle, "mcp"] : ["--import", tsxLoader, cli, "mcp"];
    const child = spawn(process.execPath, childArgs, {
      cwd,
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const responses: Array<Record<string, unknown>> = [];
    let stdout = "";
    let stderr = "";
    let buffer = "";
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`timed out waiting for rsp mcp responses; stderr=${stderr}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      buffer += chunk;
      let idx: number;
      while ((idx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) continue;
        responses.push(JSON.parse(line) as Record<string, unknown>);
        if (responses.filter((response) => response.id != null).length >= expectedResponses) {
          clearTimeout(timeout);
          child.kill();
          resolve(responses);
        }
      }
    });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (status) => {
      if (responses.filter((response) => response.id != null).length < expectedResponses) {
        clearTimeout(timeout);
        reject(new Error(`rsp mcp exited early with ${status}; stdout=${stdout}; stderr=${stderr}`));
      }
    });
    for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

async function seedWarmRedCache(): Promise<string> {
  const root = await tempRoot();
  const cacheDir = join(root, "bundles");
  const runtimeDir = join(cacheDir, "reddb", "1.7.0");
  await mkdir(runtimeDir, { recursive: true });
  const redPath = join(packageRoot, "node_modules", "@reddb-io", "sdk", "bin", process.platform === "win32" ? "red.exe" : "red");
  const redBytes = await readFile(redPath);
  await copyFile(redPath, join(runtimeDir, process.platform === "win32" ? "red.exe" : "red"));
  const checksum = createHash("sha256").update(redBytes).digest("hex");
  await writeFile(join(runtimeDir, `${process.platform === "win32" ? "red.exe" : "red"}.sha256`), `${checksum}  red\n`, "utf8");
  return cacheDir;
}

async function waitForGone(path: string, timeoutMs = normalizedDurationMs(5_000)): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`still present after ${timeoutMs}ms: ${path}`);
}

async function waitForActiveWait(root: string, reason: string): Promise<Record<string, unknown>> {
  const deadline = normalizedDeadlineMs();
  let last: unknown[] = [];
  while (Date.now() < deadline) {
    const listed = runRsp(root, ["wait", "ls"], {});
    expect(listed.status).toBe(0);
    last = (decode(listed.stdout.toString("utf8")) as { waits: unknown[] }).waits;
    const match = last.find((entry) => isRecord(entry) && entry.reason === reason);
    if (isRecord(match)) return match;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`active wait not found for ${reason}; last=${JSON.stringify(last)}`);
}

async function closeWithTimeout(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`process did not exit within ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve(status);
    });
  });
}

async function waitForResidentSocket(root: string): Promise<void> {
  const paths = trackedResidentPaths(root);
  const deadline = normalizedDeadlineMs();
  while (Date.now() < deadline) {
    try {
      await stat(paths.socketPath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stat(paths.socketPath);
}

async function waitForSummaryTokens(root: string, minTokens: number): Promise<number> {
  const summaryPath = resolveResidentPaths(root).summaryPath;
  const deadline = normalizedDeadlineMs();
  let last = 0;
  while (Date.now() < deadline) {
    try {
      const summary = JSON.parse(await readFile(summaryPath, "utf8")) as { tokens_saved_today?: unknown };
      last = typeof summary.tokens_saved_today === "number" ? summary.tokens_saved_today : 0;
      if (last > minTokens) return last;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(last).toBeGreaterThan(minTokens);
  return last;
}

async function readResidentVersion(root: string): Promise<string | undefined> {
  const socketPath = trackedResidentPaths(root).socketPath;
  const deadline = normalizedDeadlineMs();
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await sendResidentRequest(
        { socketPath, timeoutMs: 500 },
        { id: "version", op: "ping" },
      );
      const value = response.ok && isRecord(response.value) ? response.value : {};
      return typeof value.version === "string" ? value.version : undefined;
    } catch (err) {
      last = err;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw last instanceof Error ? last : new Error("resident version probe failed");
}

async function startHungOldResident(socketPath: string, version: string): Promise<Server> {
  await mkdir(dirname(socketPath), { recursive: true });
  const server = createServer((socket) => handleHungOldResidentSocket(socket, version));
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

function handleHungOldResidentSocket(socket: Socket, version: string): void {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("error", () => {});
  socket.on("data", (chunk) => {
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    const request = JSON.parse(buffer.slice(0, newline)) as { id?: string; op?: string };
    if (request.op === "ping") {
      socket.write(`${JSON.stringify({ id: request.id, ok: true, value: { pong: true, version } })}\n`, () => {});
      socket.end();
    }
  });
}

async function readTelemetryRecords(storeUri: string, collection: string): Promise<unknown[]> {
  const db = await connect(storeUri);
  try {
    const raw = await db.kv(collection).list({ limit: 1000 }).catch((err) => {
      if (err instanceof Error && /\bnot found\b/i.test(err.message)) return { items: [] };
      throw err;
    });
    return raw.items.map((entry) => typeof entry.value === "string" ? JSON.parse(entry.value) as unknown : entry.value);
  } finally {
    await db.close();
  }
}

async function waitForTelemetryInvocations(storeUri: string, command: string, minCount: number): Promise<unknown[]> {
  const deadline = normalizedDeadlineMs();
  let records: unknown[] = [];
  while (Date.now() < deadline) {
    records = await readTelemetryRecords(storeUri, RSP_TELEMETRY_INVOCATIONS_COLLECTION);
    if (records.filter((entry) => isRecord(entry) && entry.command === command).length >= minCount) return records;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  expect(records.filter((entry) => isRecord(entry) && entry.command === command).length).toBeGreaterThanOrEqual(minCount);
  return records;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function extractHandle(output: Buffer): string {
  const match = /rsp show (el:[a-f0-9]{12})/.exec(output.toString("utf8"));
  expect(match?.[1]).toBeTruthy();
  return match![1];
}

async function stopTrackedResidents(extraRoots: string[]): Promise<void> {
  const paths = uniqueResidentPaths(extraRoots);
  residentPathsBySocket.clear();
  await Promise.all(paths.map((path) => stopResident(path)));
}

function uniqueResidentPaths(extraRoots: string[]): Array<ReturnType<typeof resolveResidentPaths>> {
  const paths = new Map(residentPathsBySocket);
  for (const root of extraRoots) {
    const resolved = resolveResidentPaths(root);
    paths.set(resolved.socketPath, resolved);
  }
  return [...paths.values()];
}

async function countTrackedResidentProcesses(extraRoots: string[] = []): Promise<number> {
  let count = 0;
  for (const paths of uniqueResidentPaths(extraRoots)) {
    const pid = await readPid(paths.pidPath);
    if (pid != null && isPidAlive(pid)) count++;
  }
  return count;
}

async function stopResident(paths: ReturnType<typeof resolveResidentPaths>): Promise<void> {
  const pid = await readPid(paths.pidPath);
  if (await pathExists(paths.socketPath)) {
    await sendResidentRequest(
      { socketPath: paths.socketPath, timeoutMs: 500 },
      { id: randomUUID(), op: "handover", clientVersion: "9999.0.0" },
    ).catch(() => undefined);
    await waitForGone(paths.socketPath, normalizedDurationMs(2_000)).catch(() => undefined);
  }
  if (pid != null && pid !== process.pid && isPidAlive(pid)) {
    killResidentPid(pid, "SIGTERM");
    await waitForPidGone(pid, normalizedDurationMs(1_000)).catch(() => {
      killResidentPid(pid, "SIGKILL");
    });
    await waitForPidGone(pid, normalizedDurationMs(1_000)).catch(() => undefined);
  }
  await rm(paths.socketPath, { force: true });
  await rm(paths.pidPath, { force: true });
}

async function readPid(path: string): Promise<number | null> {
  const text = await readFile(path, "utf8").catch(() => "");
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killResidentPid(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {}
  }
}

async function waitForPidGone(pid: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isPidAlive(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isPidAlive(pid)) throw new Error(`process ${pid} still alive after ${timeoutMs}ms`);
}

describe("rsp cli", () => {
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
    expect(status.result.content[0]!.text).toBe("rsp is not enabled in this directory; run /red-setup");
    expect(compress.result.isError).toBe(true);
    expect(compress.result.content[0]!.text).toBe("rsp is not enabled in this directory; run /red-setup");
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
      await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("mcp exposes resident tools when rsp is enabled", async () => {
    const root = await tempRoot();
    await enableRsp(root);

    const responses = await runMcpRequests(root, [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]);

    const list = responses.find((response) => response.id === 2) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status", "rsp_stats", "rsp_show", "rsp_compress"]);
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
    expect(text).toContain("items: 15 of 60 kept");
    expect(text).toContain("items[15]{id,status,latency,label}");
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
    expect(shown.result.content[0]!.text).toBe(original);
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
    expect(disabled.result.content[0]!.text).toBe("rsp is not enabled in this directory; run /red-setup");
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
    expect(shown.result.content[0]!.text).toBe(original);
  }, 120_000);

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
    expect(res.stdout).toEqual(direct.stdout.length === 0 ? Buffer.from("git empty\n") : direct.stdout);
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
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    await mkdir(join(root, ".red", "tmp"), { recursive: true });
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
    expect(wrapped.stdout).toEqual(raw.stdout.length === 0 ? Buffer.from("git empty\n") : raw.stdout);
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

  it("built bundle pre-exec hook passes through while cold, warms once, then rewrites when healthy", async () => {
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

    expect(cold.status).toBe(1);
    expect(cold.stdout).toEqual(Buffer.alloc(0));
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

        expect(retryCold.status).toBe(1);
        expect(retryCold.stdout).toEqual(Buffer.alloc(0));
        expect(retryCold.stderr).toEqual(Buffer.alloc(0));
        return budgetSample(
          retryColdHookWorkMs,
          retryNodeBaseline.elapsedMs,
          `node=${retryNodeBaseline.elapsedMs.toFixed(1)}ms cold=${retryCold.elapsedMs.toFixed(1)}ms hookWork=${retryColdHookWorkMs.toFixed(1)}ms`,
        );
      },
    );
    await expect(stat(paths.wakeLockPath)).resolves.toMatchObject({ size: expect.any(Number) });

    for (let i = 0; i < 4; i++) {
      const repeat = runBundleHookFromCwd(root, "git status", env);
      expect([0, 1]).toContain(repeat.status);
      if (repeat.status === 0) {
        expect(repeat.stdout).toEqual(Buffer.from("rsp git status\n"));
      } else {
        expect(repeat.stdout).toEqual(Buffer.alloc(0));
      }
      expect(repeat.stderr).toEqual(Buffer.alloc(0));
    }

    await waitForResidentSocket(root);
    // The warmer removes the wake lock only after ensure returns, which is
    // also the moment the socket starts answering — poll instead of racing it.
    await waitForGone(paths.wakeLockPath);

    const measureWarmHookWork = () => {
      const nodeSamples: number[] = [];
      const warmSamples: number[] = [];
      for (let i = 0; i < 5; i++) {
        const node = timedStatus(runNodeNoop);
        const warm = timedStatus(() => runBundleHookFromCwd(root, "git status", env));

        expect(warm.status).toBe(0);
        expect(warm.stdout).toEqual(Buffer.from("rsp git status\n"));
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
    expect(cold.status).toBe(1);
    expect(cold.stdout).toEqual(Buffer.alloc(0));
    expect(cold.stderr).toEqual(Buffer.alloc(0));
    await waitForResidentSocket(root);
    await waitForGone(paths.wakeLockPath);

    await new Promise((resolve) => setTimeout(resolve, normalizedDurationMs(2_000)));
    const warm = runBundleHookFromCwd(root, "git status", env);
    expect(warm.status).toBe(0);
    expect(warm.stdout).toEqual(Buffer.from("rsp git status\n"));
    expect(warm.stderr).toEqual(Buffer.alloc(0));

    await waitForGone(paths.socketPath, idleMs + normalizedDurationMs(5_000));
    await waitForGone(paths.registryPath);
    const expired = runBundleHookFromCwd(root, "git status", env);
    expect(expired.status).toBe(1);
    expect(expired.stdout).toEqual(Buffer.alloc(0));
    expect(expired.stderr).toEqual(Buffer.alloc(0));
  }, 120_000);

  it("built bundle Codex pre-exec rewrite records telemetry when the rewritten command runs", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const env = { RED_SKILLS_CACHE_DIR: cacheDir };
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const resident = runBundleFromCwdAsync(root, ["server", "--idle-ms", "1000"], env);
    await waitForResidentSocket(root);

    const hook = runBundleCodexHookFromCwd(root, "git status", env);
    expect(hook.status, `${hook.stdout.toString("utf8")}${hook.stderr.toString("utf8")}`).toBe(0);
    expect(hook.stderr).toEqual(Buffer.alloc(0));
    expect(JSON.parse(hook.stdout.toString("utf8"))).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        updatedInput: { command: "rsp git status" },
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
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
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
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
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

    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    await waitForTelemetryInvocations(storeUri, "git log", 2);
    const invocations = await waitForTelemetryInvocations(storeUri, "git status", 3);
    const stats = runBundleFromCwd(root, ["stats", "--since", "7d"], env);
    const statsText = stats.stdout.toString("utf8");
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsText).toContain("command: git log invocations:");

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
      expect(res.stdout.toString("utf8")).toBe("git empty\n");
      expect(res.stderr).toEqual(Buffer.alloc(0));
    }
    const paths = trackedResidentPaths(root);
    await expect(stat(paths.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
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
    const oldRegistry = JSON.parse(await readFile(trackedResidentPaths(root).registryPath, "utf8")) as {
      pid: number;
      resident_version: string;
    };
    expect(oldRegistry.resident_version).toBe(oldVersion);

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status, `${compressed.stdout.toString("utf8")}${compressed.stderr.toString("utf8")}`).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(compressed.stdout.toString("utf8"))?.[1];
    expect(handle).toBeTruthy();
    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(shown.status, `${shown.stdout.toString("utf8")}${shown.stderr.toString("utf8")}`).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(compressed.stdout.length);
    expect(await readResidentVersion(root)).not.toBe(oldVersion);
    const nextRegistry = JSON.parse(await readFile(trackedResidentPaths(root).registryPath, "utf8")) as {
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

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(raw.status);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.length).toBeLessThan(raw.stdout.length);
    const text = compressed.stdout.toString("utf8");
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const stats = runBundleFromCwd(root, [], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(stats.status).toBe(0);
    expect(stats.stdout.toString("utf8")).toContain("records: 1\n");

    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(shown.status).toBe(0);
    expect(shown.stdout.length).toBeGreaterThan(compressed.stdout.length);
    expect(shown.stderr).toEqual(Buffer.alloc(0));

    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    await rm(join(root, ".red", "tmp", "red-skills.rdb"));
    const cold = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(cold.status).toBe(raw.status);
    expect(cold.stderr).toEqual(Buffer.alloc(0));
    expect(cold.stdout.length).toBeLessThan(raw.stdout.length);
    const coldText = cold.stdout.toString("utf8");
    expect(coldText).toContain("summary: 12 commits");
    expect(coldText).toContain("recovery unavailable (cold store) — re-run: git log");
    expect(coldText).not.toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toContain('"command":"git log"');
  }, 120_000);

  it("built bundle elides final stdout from rsp exec pipelines and recovers original bytes", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 80);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const command = "git log | head -c 400000";
    const direct = runShellFromCwd(root, command);

    const compressed = runBundleFromCwd(root, ["exec", "--", command], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(direct.status);
    expect(compressed.stderr).toEqual(direct.stderr);
    expect(compressed.stdout.length).toBeLessThan(direct.stdout.length);
    const text = compressed.stdout.toString("utf8");
    expect(text).toContain("stdout summary");
    expect(text).toContain("rsp show el:");
    const handle = /rsp show (el:[a-f0-9]{12})/.exec(text)?.[1];
    expect(handle).toBeTruthy();

    const shown = runBundleFromCwd(root, ["show", handle!], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(shown.status).toBe(0);
    expect(shown.stdout).toEqual(direct.stdout);
    expect(shown.stderr).toEqual(Buffer.alloc(0));
    await expect(readFile(telemetrySpoolPath(root), "utf8")).resolves.toContain(`"command":"${command}"`);
  }, 120_000);

  it("built bundle renders rsp cat code outlines and recovers original file bytes", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
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

  it("built bundle preserves rsp exec redirects, stderr, and exit code", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);

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

    expect(failing.status).toBe(direct.status);
    expect(failing.stderr).toEqual(direct.stderr);
    expect(failing.stdout).toEqual(direct.stdout);
  }, 120_000);

  it("built bundle records invocation and degradation telemetry through the resident", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const resident = runBundleFromCwdAsync(root, ["server", "--idle-ms", "1000"], { RED_SKILLS_CACHE_DIR: cacheDir });
    await waitForResidentSocket(root);

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
    const degraded = runBundleFromCwd(root, ["git", "--version"], { RED_SKILLS_CACHE_DIR: cacheDir });
    const direct = runGit(["--version"]);
    expect(degraded.status).toBe(direct.status);
    expect(degraded.stdout).toEqual(direct.stdout);
    expect(degraded.stderr.toString("utf8")).toBe("rsp: wrapper failed, passing through\n");
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
      command: "git --version",
      reason: "wrapper failed",
    }));

    const stats = runBundleFromCwd(root, ["stats", "--since", "7d", "--full"], { RED_SKILLS_CACHE_DIR: cacheDir });
    const statsText = stats.stdout.toString("utf8");
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsText).toContain("records: 1\n");
    expect(statsText).toContain("savings:\n");
    expect(statsText).toContain("  window_days: 7\n");
    expect(statsText).toMatch(/  invocations: [1-9]\d*\n/);
    expect(statsText).toContain("  elided: 1\n");
    expect(statsText).toMatch(/  raw_bytes: [1-9]\d*\n/);
    expect(statsText).toMatch(/  emitted_bytes: [1-9]\d*\n/);
    expect(statsText).toMatch(/  tokens_saved: [1-9]\d*\n/);
    expect(statsText).toContain("  dollars_saved_estimate_usd: $");
    expect(statsText).toContain("  pricing_model_family: gpt-5\n");
    expect(statsText).toContain("  top_commands:\n");
    expect(statsText).toContain("command: git log");
    expect(statsText).toContain("health:\n");
    expect(statsText).toContain("  degradations: 1\n");
    expect(statsText).toContain("  degradation_rate: 0.3333\n");
    expect(statsText).toContain("  most_recent_degradation_reason: wrapper failed\n");
    expect(statsText).toContain("latency:\n");
    expect(statsText).toMatch(/  wrapper_ms_p50: [0-9.]+\n/);
    expect(statsText).toMatch(/  wrapper_ms_p95: [0-9.]+\n/);
  }, 120_000);

  it("built bundle renders rsp gains TOON from synthetic telemetry", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    const cacheDir = await seedWarmRedCache();
    const setup = runBundleFromCwd(root, ["setup"], { RED_SKILLS_CACHE_DIR: cacheDir });
    expect(setup.status, `${setup.stdout.toString("utf8")}${setup.stderr.toString("utf8")}`).toBe(0);
    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
    const db = await connect(storeUri);
    try {
      await db.kv(RSP_TELEMETRY_INVOCATIONS_COLLECTION).put("big", {
        created_at: "2026-07-05T12:00:00.000Z",
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
        created_at: "2026-07-06T13:30:00.000Z",
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
        created_at: "2026-07-06T14:00:00.000Z",
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
    await mkdir(join(root, ".red", "tmp"), { recursive: true });
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

    const storeUri = `file://${join(root, ".red", "tmp", "red-skills.rdb")}`;
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
    expect(stats.status, `${statsText}${stats.stderr.toString("utf8")}`).toBe(0);
    expect(statsText).toContain("invocations: 3\n");
    expect(statsText).toMatch(/tokens_saved: [1-9]\d*\n/);
    expect(statsText).toContain("command: git log --terse invocations: 1");
    expect(statsText).toContain("command: gh pr list invocations: 1");
    expect(statsText).toContain("degradations: 1\n");
    const summary = JSON.parse(await readFile(resolveResidentPaths(root).summaryPath, "utf8")) as {
      version: number;
      tokens_saved_today: number;
      updated_at: string;
    };
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

  it("fails closed instead of creating the default Repo store when setup has not provisioned it", async () => {
    const root = await tempRoot();
    await enableRsp(root);

    const res = runRspFromCwd(root, [], {});

    expect(res.status).toBe(1);
    expect(res.stdout).toEqual(Buffer.from("error: rsp repo store is not provisioned - run /red-setup\n"));
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
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
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
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

    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readFile(join(root, ".red", "red.rdb"))).resolves.toEqual(redBytes);
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
  }, 120_000);

  it("built bundle redirects a configured legacy RedDB store to JSON without mutating it", async () => {
    buildBundleOnce();
    const root = await initGitRepo();
    await commitMany(root, 12);
    await enableRsp(root);
    const legacyPath = join(root, ".red", "red.rdb");
    const legacyBytes = Buffer.concat([Buffer.from("RDBSBLK1", "ascii"), Buffer.from("legacy graph bytes")]);
    await writeFile(legacyPath, legacyBytes);

    const compressed = runBundleFromCwd(root, ["--store-uri", `file://${legacyPath}`, "git", "log", "--terse"]);

    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
    await expect(readFile(legacyPath)).resolves.toEqual(legacyBytes);
    await expect(stat(join(root, ".red", "tmp", "rsp-elisions.json"))).resolves.toMatchObject({ size: expect.any(Number) });
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
    expect(debug.stdout.toString("utf8")).toContain("error: unsupported git subcommand");
  });

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

  it("wait cmd exits with TOON success and removes its registry entry", async () => {
    const root = await tempRoot();
    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 120)"`;
    const actual = timedStatus(() => runRsp(root, ["wait", "cmd", "--timeout", "5s", "--reason", "test wait", "--", command], {}));

    expect(actual.status).toBe(0);
    expect(actual.elapsedMs).toBeGreaterThanOrEqual(normalizedDurationMs(80));
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
    const command = `${shellQuote(process.execPath)} -e "setTimeout(() => process.exit(0), 700)"`;
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

    const status = await closeWithTimeout(child, normalizedDurationMs(5_000));
    expect(status, Buffer.concat(stderr).toString("utf8")).toBe(0);
    const decoded = decode(Buffer.concat(stdout).toString("utf8")) as { wait: { status: string } };
    expect(decoded.wait.status).toBe("success");
    const after = runRsp(root, ["wait", "ls"], {});
    expect((decode(after.stdout.toString("utf8")) as { waits: unknown[] }).waits).toEqual([]);
  });

  it("prints store stats instead of help when called without arguments", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({
      uri: storeUri,
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

    const res = runRsp(root, [], { RSP_STORE_URI: storeUri });

    expect(res.status).toBe(0);
    const text = res.stdout.toString("utf8");
    expect(text).toContain("records: 1\nbytes: 3\noldest: 2026-07-10T12:00:00.000Z\nbudget: 67108864\n");
    expect(text).toContain("savings:\n  window_days: 30\n  empty: true\n  invocations: 0\n");
    expect(text).toContain("health:\n  degradations: 0\n  degradation_rate: 0.0\n");
    expect(text).toContain("latency:\n  wrapper_ms_p50: none\n");
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });

  it("prints a definitive empty telemetry state through rsp stats", async () => {
    const root = await tempRoot();
    await enableRsp(root);
    const storeUri = `file://${join(root, "red.rdb")}`;
    const store = await RspElisionStore.open({ uri: storeUri });
    await store.close();

    const res = runRsp(root, ["stats", "--since=7d"], { RSP_STORE_URI: storeUri });
    const text = res.stdout.toString("utf8");

    expect(res.status).toBe(0);
    expect(text).toContain("records: 0\nbytes: 0\noldest: none\n");
    expect(text).toContain("savings:\n  window_days: 7\n  empty: true\n  invocations: 0\n");
    expect(text).toContain("  top_commands:\n    empty: true\n");
    expect(text).toContain("health:\n  degradations: 0\n  degradation_rate: 0.0\n");
    expect(text).toContain("  most_recent_degradation_at: none\n");
    expect(text).toContain("latency:\n  wrapper_ms_p50: none\n  wrapper_ms_p95: none\n");
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
    expect(res.stdout).toEqual(Buffer.from("expired 2026-07-11T12:00:00.000Z — re-run: rerun me\n"));
    expect(res.stderr).toEqual(Buffer.alloc(0));
  });
});
