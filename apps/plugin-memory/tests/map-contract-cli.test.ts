import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("memory map-contract CLI", () => {
  test.each([{ flags: [] }, { flags: ["--json"] }])(
    "routes the documented report command with flags $flags",
    async ({ flags }) => {
      const root = await mkdtemp(join(tmpdir(), "memory-map-contract-cli-"));
      roots.push(root);
      await initGraph(root);

      const result = runMemory(["map-contract", "--root", root, ...flags]);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        version: "2.0.0",
        stats: { node_count: 0, edge_count: 0 },
      });
    },
  );
});
