import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RSP_EPHEMERAL_TTL_HOURS, DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "../src/config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/elision-store.js";
import { resolveResidentPaths } from "../src/resident-client.js";
import { sendResidentRequest } from "../src/resident-protocol.js";
import { mergeRspBlock, provisionRspRepoStore } from "../src/setup.js";

const roots: string[] = [];
const cli = join(import.meta.dirname, "..", "src", "cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-setup-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  const rootsToRemove = roots.splice(0);
  await Promise.all(rootsToRemove.map((root) => stopResidentForRoot(root)));
  await Promise.all(rootsToRemove.map((root) => rm(root, { recursive: true, force: true })));
  delete process.env.REDDB_BIN;
});

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => stopResidentForRoot(root)));
});

async function stopResidentForRoot(root: string): Promise<void> {
  const paths = resolveResidentPaths(root);
  const pid = await readPid(paths.pidPath);
  if (await pathExists(paths.socketPath)) {
    await sendResidentRequest(
      { socketPath: paths.socketPath, timeoutMs: 500 },
      { id: randomUUID(), op: "handover", clientVersion: "9999.0.0" },
    ).catch(() => undefined);
  }
  if (pid != null && isPidAlive(pid)) {
    killResidentPid(pid, "SIGTERM");
    await waitForPidGone(pid, 1_000).catch(() => killResidentPid(pid, "SIGKILL"));
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

describe("mergeRspBlock", () => {
  it("adds an explicit rsp enablement block with retention defaults", () => {
    expect(mergeRspBlock("plugins:\n  dev:\n    enabled: true\n", {
      enabled: true,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      ephemeralTtlHours: DEFAULT_RSP_EPHEMERAL_TTL_HOURS,
      heavyGitByteThreshold: DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
    })).toBe([
      "plugins:",
      "  dev:",
      "    enabled: true",
      "",
      "rsp:",
      "  enabled: true",
      "  ttlDays: 7",
      "  ephemeralTtlHours: 6",
      "  byteBudget: 67108864",
      "  heavyGitByteThreshold: 8192",
      "",
    ].join("\n"));
  });

  it("replaces only the rsp subtree on rerun", () => {
    const existing = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "rsp:",
      "  enabled: false",
      "  ttlDays: 1",
      "other: kept",
      "",
    ].join("\n");

    const out = mergeRspBlock(existing, {
      enabled: true,
      ttlDays: 7,
      ephemeralTtlHours: 6,
      byteBudget: 64,
      heavyGitByteThreshold: 128,
    });

    expect(out).toContain("plugins:\n  dev:\n    enabled: true");
    expect(out).toContain("rsp:\n  enabled: true\n  ttlDays: 7\n  ephemeralTtlHours: 6\n  byteBudget: 64\n  heavyGitByteThreshold: 128");
    expect(out).toContain("other: kept");
    expect(out).not.toContain("ttlDays: 1");
  });
});

describe("provisionRspRepoStore", () => {
  it("creates .red/tmp/red-skills.rdb and is idempotent on rerun", async () => {
    const root = await tempRoot();
    const first = await provisionRspRepoStore(root);
    const firstStat = await stat(first.storePath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await provisionRspRepoStore(root);
    const secondStat = await stat(second.storePath);

    expect(first.storeCreated).toBe(true);
    expect(second.storeCreated).toBe(false);
    expect(firstStat.mtimeMs).toBe(secondStat.mtimeMs);
    expect(first.storePath).toBe(join(root, ".red", "tmp", "red-skills.rdb"));
    await expect(readFile(join(root, ".red", "config.yaml"), "utf8")).resolves.toContain("rsp:\n  enabled: true");
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not touch an existing store file", async () => {
    const root = await tempRoot();
    await provisionRspRepoStore(root);
    const marker = Buffer.from("existing store marker");
    await writeFile(join(root, ".red", "tmp", "red-skills.rdb"), marker);

    const result = await provisionRspRepoStore(root);

    expect(result.storeCreated).toBe(false);
    await expect(readFile(join(root, ".red", "tmp", "red-skills.rdb"))).resolves.toEqual(marker);
  });

  it("copies and repoints the memory graph store into the shared rsp store", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "memory"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), [
      "plugins:",
      "  memory:",
      "    enabled: true",
      "    mode: graph",
      "    storePath: .red/memory/graph.rdb",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(root, ".red", "memory", "graph.rdb"), "legacy graph data", "utf8");

    const result = await provisionRspRepoStore(root);

    expect(result.storeCreated).toBe(true);
    expect(result.memoryStoreMigrated).toBe(true);
    await expect(readFile(join(root, ".red", "memory", "graph.rdb"), "utf8")).resolves.toBe("legacy graph data");
    await expect(readFile(join(root, ".red", "tmp", "red-skills.rdb"), "utf8")).resolves.toBe("legacy graph data");
    await expect(readFile(join(root, ".red", "config.yaml"), "utf8")).resolves.toContain("    storePath: .red/tmp/red-skills.rdb");
    await expect(stat(join(root, ".red", "red.rdb"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not set REDDB_BIN while provisioning rsp", async () => {
    const root = await tempRoot();
    await provisionRspRepoStore(root);
    expect(process.env.REDDB_BIN).toBeUndefined();
  });
});

describe("rsp setup CLI", () => {
  it("provisions the repo store and enables bare rsp wrappers", async () => {
    const root = await tempRoot();

    const before = spawnSync(process.execPath, ["--import", tsxLoader, cli, "git", "status"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(before.status).not.toBe(0);
    expect(before.stdout).not.toContain("rsp repo store is not provisioned");
    expect(before.stderr).toContain("not a git repository");

    const setup = spawnSync(process.execPath, ["--import", tsxLoader, cli, "setup"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(setup.status).toBe(0);
    expect(setup.stdout).toContain("store: created");
    await expect(readFile(join(root, ".red", "config.yaml"), "utf8")).resolves.toContain("rsp:\n  enabled: true");

    const rerun = spawnSync(process.execPath, ["--import", tsxLoader, cli, "setup"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(rerun.status).toBe(0);
    expect(rerun.stdout).toContain("store: existing");

    const after = spawnSync(process.execPath, ["--import", tsxLoader, cli, "git", "status"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(after.stdout).not.toContain("rsp repo store is not provisioned");
    expect(after.stderr).toContain("not a git repository");
  }, 20_000);
});
