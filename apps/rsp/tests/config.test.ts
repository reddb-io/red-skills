import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRspConfig } from "../src/config.js";
import { DEFAULT_RSP_BYTE_BUDGET, DEFAULT_RSP_TTL_DAYS } from "../src/elision-store.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("resolveRspConfig", () => {
  it("reads retention knobs from the top-level rsp block", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  ttlDays: 3\n  byteBudget: 42\n", "utf8");

    expect(resolveRspConfig(join(root, "nested"), {}, undefined)).toEqual({
      enabled: false,
      storeUri: `file://${join(root, ".red", "red.rdb")}`,
      ttlDays: 3,
      byteBudget: 42,
    });
  });

  it("exposes the explicit enablement flag and defaults absent retention keys", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), "rsp:\n  enabled: true\n", "utf8");

    expect(resolveRspConfig(root, {}, undefined)).toEqual({
      enabled: true,
      storeUri: `file://${join(root, ".red", "red.rdb")}`,
      ttlDays: DEFAULT_RSP_TTL_DAYS,
      byteBudget: DEFAULT_RSP_BYTE_BUDGET,
    });
  });

  it("does not create .red or red.rdb while resolving runtime config", async () => {
    const root = await tempRoot();
    const config = resolveRspConfig(root, {}, undefined);

    expect(config.enabled).toBe(false);
    await expect(stat(join(root, ".red"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
