import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { resolveRspConfig } from "../src/config.js";

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
      storeUri: `file://${join(root, ".red", "red.rdb")}`,
      ttlDays: 3,
      byteBudget: 42,
    });
  });
});
