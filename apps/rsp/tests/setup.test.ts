import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_RSP_HEAVY_GIT_BYTE_THRESHOLD } from "../src/config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/elision-store.js";
import { mergeRspBlock, provisionRspRepoStore } from "../src/setup.js";

const roots: string[] = [];

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
});
