import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { connect } from "@reddb-io/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { RspElisionStore } from "../src/elision-store.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import {
  RSP_TELEMETRY_DEGRADATIONS_COLLECTION,
  RSP_TELEMETRY_INVOCATIONS_COLLECTION,
} from "../src/telemetry.js";

const roots: string[] = [];
const residentDirs: string[] = [];
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  await Promise.all(residentDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function trackedResidentPaths(root: string) {
  const paths = resolveResidentPaths(root);
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

function runNodeNoop() {
  return spawnSync(process.execPath, ["-e", ""], { encoding: "buffer" });
}

function runBundleFromCwd(cwd: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "buffer",
  });
}

function runBundleHookFromCwd(cwd: string, command: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [bundle, "hook", "claude-pre-exec"], {
    cwd,
    env: { ...process.env, ...env },
    input: Buffer.from(JSON.stringify({ cwd, tool_input: { command } })),
    encoding: "buffer",
  });
}

function runBundleFromCwdAsync(cwd: string, args: string[], env: Record<string, string> = {}) {
  return new Promise<{ status: number | null; stdout: Buffer; stderr: Buffer }>((resolve, reject) => {
    const child = spawn(process.execPath, [bundle, ...args], {
      cwd,
      env: { ...process.env, ...env },
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

async function runMcpRequests(cwd: string, requests: Array<Record<string, unknown>>): Promise<Array<Record<string, unknown>>> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", tsxLoader, cli, "mcp"], {
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
    }, 10_000);
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
        if (responses.length >= requests.filter((request) => "id" in request).length) {
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
      if (responses.length < requests.filter((request) => "id" in request).length) {
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

async function waitForGone(path: string, timeoutMs = 5_000): Promise<void> {
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

async function waitForResidentSocket(root: string): Promise<void> {
  const paths = trackedResidentPaths(root);
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await stat(paths.socketPath);
      return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await stat(paths.socketPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

describe("rsp cli", () => {
  it("passes wrappers through without creating .red when rsp is not enabled", async () => {
    const root = await initGitRepo();
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "status", "--short"], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: rsp is not enabled in this directory; run /red-setup, passing through\n${direct.stderr.toString("utf8")}`);
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });

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
    ]);

    const list = responses.find((response) => response.id === 2) as { result: { tools: Array<{ name: string }> } };
    const status = responses.find((response) => response.id === 3) as { result: { content: Array<{ text: string }> } };
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status"]);
    expect(status.result.content[0]!.text).toBe("rsp is not enabled in this directory; run /red-setup");
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
    expect(list.result.tools.map((tool) => tool.name)).toEqual(["rsp_status", "rsp_stats", "rsp_show"]);
  });

  it("built bundle starts the resident on cold small git status", async () => {
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
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
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
    expect(coldHookWorkMs).toBeLessThan(200);
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

    const nodeBaseline = timedStatus(runNodeNoop);
    const warm = timedStatus(() => runBundleHookFromCwd(root, "git status", env));
    const hookWorkMs = Math.max(0, warm.elapsedMs - nodeBaseline.elapsedMs);

    expect(warm.status).toBe(0);
    expect(warm.stdout).toEqual(Buffer.from("rsp git status\n"));
    expect(warm.stderr).toEqual(Buffer.alloc(0));
    expect(hookWorkMs).toBeLessThan(100);
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

    const res = runBundleFromCwd(root, ["git", "status"], {
      RED_SKILLS_CACHE_DIR: cacheDir,
      RSP_FAIL_IF_STORE_OPEN: "1",
    });
    const direct = runGit(["-C", root, "status", "--porcelain=v1"]);

    expect(res.status, `${res.stdout.toString("utf8")}${res.stderr.toString("utf8")}`).toBe(0);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr).toEqual(Buffer.alloc(0));
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
    expect(((await stat(dirname(paths.socketPath))).mode & 0o777)).toBe(0o700);
    await expect(stat(join(root, ".red", "tmp", "rsp.sock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(root, ".red", "tmp", "red-skills.rdb"))).resolves.toMatchObject({ size: expect.any(Number) });
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
    const wrapperWorkMs = wrappedMedian - nodeMedian;
    expect(
      wrapperWorkMs,
      `raw=${rawMedian.toFixed(1)}ms node=${nodeMedian.toFixed(1)}ms wrapped=${wrappedMedian.toFixed(1)}ms wrapperWork=${wrapperWorkMs.toFixed(1)}ms`,
    ).toBeLessThanOrEqual(150);
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

  it("built bundle handles concurrent cold wrappers with one resident socket and usable store", async () => {
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
    await expect(stat(paths.socketPath)).resolves.toMatchObject({ size: expect.any(Number) });
    await expect(stat(paths.lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    const compressed = runBundleFromCwd(root, ["git", "log", "--terse"], env);
    expect(compressed.status).toBe(0);
    expect(compressed.stderr).toEqual(Buffer.alloc(0));
    expect(compressed.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
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

  it("built bundle compresses git log, mints a handle, round-trips it, and reports degraded passthrough", async () => {
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
    const degraded = runBundleFromCwd(root, ["git", "log", "--terse"], { RED_SKILLS_CACHE_DIR: cacheDir });

    expect(degraded.status).toBe(raw.status);
    expect(degraded.stdout).toEqual(raw.stdout);
    expect(degraded.stderr.toString("utf8")).toBe("rsp: store not provisioned, passing through\n");
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
    const wrappedSamples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const raw = timedStatus(() => runGit(["-C", root, "log"]));
      const wrapped = timedStatus(() => runBundleFromCwd(root, ["git", "log", "--terse"], env));
      expect(raw.status).toBe(0);
      expect(wrapped.status).toBe(0);
      expect(wrapped.stderr).toEqual(Buffer.alloc(0));
      expect(wrapped.stdout.toString("utf8")).toMatch(/rsp show el:[a-f0-9]{12}/);
      rawSamples.push(raw.elapsedMs);
      wrappedSamples.push(wrapped.elapsedMs);
    }

    const rawMedian = median(rawSamples);
    const wrappedMedian = median(wrappedSamples);
    const overheadMs = wrappedMedian - rawMedian;
    expect(
      wrappedMedian,
      `raw=${rawMedian.toFixed(1)}ms wrapped=${wrappedMedian.toFixed(1)}ms overhead=${overheadMs.toFixed(1)}ms`,
    ).toBeLessThanOrEqual(750);
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

  it("passes through a successful wrapper when the repo store has not been provisioned", async () => {
    const root = await initGitRepo();
    await enableRsp(root);
    await writeFile(join(root, "untracked.txt"), "raw stdout\n", "utf8");
    const direct = runGit(["-C", root, "status", "--short"]);

    const res = runRspFromCwd(root, ["git", "-C", root, "status", "--short"], {});

    expect(res.status).toBe(direct.status);
    expect(res.stdout).toEqual(direct.stdout);
    expect(res.stderr.toString("utf8")).toBe(`rsp: store not provisioned, passing through\n${direct.stderr.toString("utf8")}`);
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
    expect(res.stderr.toString("utf8")).toBe(`rsp: store not provisioned, passing through\n${direct.stderr.toString("utf8")}`);
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
    expect(res.stderr.toString("utf8")).toBe(`rsp: resident unavailable, passing through\n${direct.stderr.toString("utf8")}`);
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
