import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "../src/config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/elision-store.js";
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
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("mergeRspBlock", () => {
  it("adds an explicit rsp enablement block with retention defaults", () => {
    expect(mergeRspBlock("plugins:\n  dev:\n    enabled: true\n", {
      enabled: true,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
      heavyGitByteThreshold: DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD,
    })).toBe([
      "plugins:",
      "  dev:",
      "    enabled: true",
      "",
      "rsp:",
      "  enabled: true",
      "  ttlDays: 7",
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

    const out = mergeRspBlock(existing, { enabled: true, ttlDays: 7, byteBudget: 64, heavyGitByteThreshold: 128 });

    expect(out).toContain("plugins:\n  dev:\n    enabled: true");
    expect(out).toContain("rsp:\n  enabled: true\n  ttlDays: 7\n  byteBudget: 64\n  heavyGitByteThreshold: 128");
    expect(out).toContain("other: kept");
    expect(out).not.toContain("ttlDays: 1");
  });
});

describe("provisionRspRepoStore", () => {
  it("creates .red/red.rdb and is idempotent on rerun", async () => {
    const root = await tempRoot();
    const first = await provisionRspRepoStore(root);
    const firstStat = await stat(first.storePath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await provisionRspRepoStore(root);
    const secondStat = await stat(second.storePath);

    expect(first.storeCreated).toBe(true);
    expect(second.storeCreated).toBe(false);
    expect(firstStat.mtimeMs).toBe(secondStat.mtimeMs);
    await expect(readFile(join(root, ".red", "config.yaml"), "utf8")).resolves.toContain("rsp:\n  enabled: true");
  });

  it("does not touch an existing store file", async () => {
    const root = await tempRoot();
    await provisionRspRepoStore(root);
    const marker = Buffer.from("existing store marker");
    await writeFile(join(root, ".red", "red.rdb"), marker);

    const result = await provisionRspRepoStore(root);

    expect(result.storeCreated).toBe(false);
    await expect(readFile(join(root, ".red", "red.rdb"))).resolves.toEqual(marker);
  });

  it("copies the legacy memory graph store into the shared repo store before creating a new store", async () => {
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

    expect(result.storeCreated).toBe(false);
    expect(result.memoryStoreMigrated).toBe(true);
    await expect(readFile(join(root, ".red", "red.rdb"), "utf8")).resolves.toBe("legacy graph data");
    await expect(readFile(join(root, ".red", "config.yaml"), "utf8")).resolves.toContain("    storePath: .red/red.rdb");
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
  });
});
