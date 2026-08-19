import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { HistoricalMemoryStore } from "../src/historical-memory-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 60_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const RED = join(PLUGIN_ROOT, "node_modules", "@reddb-io", "sdk", "bin", "red");
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-as-of-recall-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function runRedVcs(root: string, args: string[]) {
  const result = spawnSync(
    RED,
    ["vcs", ...args, "--path", join(root, ".red/memory/graph.rdb"), "--json"],
    { encoding: "utf8", timeout: TIMEOUT },
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout) as { data: Record<string, unknown> };
}

describe("AS OF Memory recall", () => {
  test(
    "recalls a historical commit, branch, and tag reproducibly without current-store side effects",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      const store = await openStore(root);
      await store.upsertNode({
        label: "decision:historical-alpha",
        node_type: "decision",
        properties: {
          title: "Historical Alpha",
          content: "Historical alpha policy says deploy with the blue pipeline.",
        },
      });
      await store.close();

      const committed = runMemory(["commit", "--root", root, "--message", "alpha", "--json"]);
      expect(committed.status, committed.stderr).toBe(0);
      const commit = JSON.parse(committed.stdout).commit.hash as string;
      runRedVcs(root, ["branch", "alpha-branch", "--from", commit]);
      runRedVcs(root, ["tag", "alpha-tag", commit]);

      const current = await openStore(root);
      await current.upsertNode({
        label: "decision:current-beta",
        node_type: "decision",
        properties: {
          title: "Current Beta",
          content: "Current beta policy says deploy with the green pipeline.",
        },
      });
      await current.kvPut("session:current", { query: "historical alpha" });
      await current.kvPut("cache:recall", { query: "historical alpha" });
      await current.kvPut("event-log:last", { query: "historical alpha" });
      await current.close();

      for (const ref of [commit, "alpha-branch", "alpha-tag"]) {
        const first = runMemory(["recall", "historical alpha", "--root", root, "--as-of", ref]);
        const second = runMemory(["recall", "historical alpha", "--root", root, "--as-of", ref]);

        expect(first.status, first.stderr).toBe(0);
        expect(second.status, second.stderr).toBe(0);
        expect(second.stdout).toEqual(first.stdout);
        expect(first.stdout).toContain("decision:historical-alpha");
        expect(first.stdout).not.toContain("decision:current-beta");
        expect(first.stdout).not.toContain("session:current");
        expect(first.stdout).not.toContain("cache:recall");
        expect(first.stdout).not.toContain("event-log:last");
      }

      const after = await openStore(root);
      expect(await after.accessRecords()).toEqual(new Map());
      await after.close();

      const historical = await HistoricalMemoryStore.open({
        uri: `file://${join(root, ".red/memory/graph.rdb")}`,
        ref: commit,
      });
      expect("recordAccess" in historical).toBe(false);
      expect("kvPut" in historical).toBe(false);
      await historical.close();
    },
    TIMEOUT,
  );
});
