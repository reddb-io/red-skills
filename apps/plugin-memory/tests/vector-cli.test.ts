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

      const search = runMemory([
        "vector",
        "search",
        "readiness",
        "--root",
        root,
        "--json",
      ]);
      expect(search.status).toBe(0);
      const searchBody = JSON.parse(search.stdout) as {
        status: string;
        hits: unknown[];
        read_only: boolean;
        error?: string;
      };
      expect(searchBody).toMatchObject({
        status: "unavailable",
        hits: [],
        read_only: true,
      });
      expect(searchBody.error).toContain("RED_MEMORY_VECTOR_PROVIDER");

      const strict = runMemory(["vector", "maintain", "--root", root, "--strict"]);
      expect(strict.status).not.toBe(0);
      expect(strict.stderr).toContain("vector projection");
    },
    TIMEOUT,
  );

  test(
    "can maintain and search a local deterministic vector projection",
    async () => {
      const root = await initRoot();
      const stored = runMemory([
        "store",
        "Local vector search finds auth token rotation guidance.",
        "--root",
        root,
      ]);
      expect(stored.status).toBe(0);

      const maintain = runMemory(["vector", "maintain", "--root", root, "--local", "--json"]);
      expect(maintain.status, maintain.stderr).toBe(0);
      const statusBody = JSON.parse(maintain.stdout) as {
        overall: string;
        total: number;
        ready: number;
      };
      expect(statusBody).toMatchObject({
        overall: "ready",
        total: 1,
        ready: 1,
      });

      const rememberedStatus = runMemory(["vector", "status", "--root", root, "--json"]);
      expect(rememberedStatus.status, rememberedStatus.stderr).toBe(0);
      expect(JSON.parse(rememberedStatus.stdout)).toMatchObject({
        overall: "ready",
        total: 1,
        ready: 1,
      });

      const search = runMemory([
        "vector",
        "search",
        "token",
        "rotation",
        "--root",
        root,
        "--local",
        "--json",
      ]);
      expect(search.status, search.stderr).toBe(0);
      const searchBody = JSON.parse(search.stdout) as {
        status: string;
        hits: Array<{ title: string; score: number }>;
        read_only: boolean;
      };
      expect(searchBody.status).toBe("available");
      expect(searchBody.read_only).toBe(true);
      expect(searchBody.hits[0]?.title).toContain("Local vector search");
      expect(searchBody.hits[0]?.score).toBeGreaterThan(0);

      const rememberedSearch = runMemory([
        "vector",
        "search",
        "token",
        "rotation",
        "--root",
        root,
        "--json",
      ]);
      expect(rememberedSearch.status, rememberedSearch.stderr).toBe(0);
      expect(JSON.parse(rememberedSearch.stdout)).toMatchObject({
        status: "available",
        read_only: true,
      });
    },
    TIMEOUT,
  );
});
