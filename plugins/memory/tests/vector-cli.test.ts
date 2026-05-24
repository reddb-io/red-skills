import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-vector-cli-"));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status).toBe(0);
  return root;
}

describe("memory vector CLI", () => {
  test(
    "reports projection status and fails strict maintenance when vectors are not ready",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "Vector readiness is a graph-mode diagnostic.",
        "--root",
        root,
      ]);
      expect(stored.status).toBe(0);

      const status = runMemory(["vector", "status", "--root", root, "--json"]);
      expect(status.status).toBe(0);
      const body = JSON.parse(status.stdout) as {
        total: number;
        overall: string;
        nodes: Array<{ status: string }>;
      };
      expect(body.total).toBe(1);
      expect(["unavailable", "failed"]).toContain(body.overall);
      expect(body.nodes[0]?.status).toBe(body.overall);

      const strict = runMemory(["vector", "maintain", "--root", root, "--strict"]);
      expect(strict.status).not.toBe(0);
      expect(strict.stderr).toContain("vector projection");
    },
    TIMEOUT,
  );
});
