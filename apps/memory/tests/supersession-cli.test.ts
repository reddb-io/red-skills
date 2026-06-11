import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-supersession-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function seedConflict(root: string): Promise<{ oldRid: number; newRid: number }> {
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  const oldRid = await store.upsertNode({
    label: "deploy-friday",
    node_type: "decision",
    properties: { title: "deploy friday", content: "deploys happen friday" },
  });
  const newRid = await store.upsertNode({
    label: "deploy-tuesday",
    node_type: "decision",
    properties: { title: "deploy tuesday", content: "deploys happen tuesday" },
  });
  await store.upsertEdge({
    label: "CONTRADICTS",
    from_rid: oldRid,
    to_rid: newRid,
    properties: { reason: "date changed" },
  });
  await store.close();
  stores.pop();
  return { oldRid, newRid };
}

describe("memory supersession CLI", () => {
  test(
    "lists contradictions, supersedes stale guidance, and prints an audit timeline",
    async () => {
      const root = await tempRoot();
      const { oldRid, newRid } = await seedConflict(root);

      const conflicts = runMemory(["conflicts", "--root", root]);
      expect(conflicts.status).toBe(0);
      expect(conflicts.stdout).toContain("deploy-friday");
      expect(conflicts.stdout).toContain("deploy-tuesday");

      const supersede = runMemory([
        "supersede",
        String(oldRid),
        String(newRid),
        "--root",
        root,
        "--reason",
        "policy changed",
      ]);
      expect(supersede.status).toBe(0);
      expect(supersede.stdout).toContain(`superseded ${oldRid} -> ${newRid}`);

      const activeConflicts = runMemory(["conflicts", "--root", root]);
      expect(activeConflicts.status).toBe(0);
      expect(activeConflicts.stdout).toContain("no unresolved contradictions");

      const timeline = runMemory(["timeline", "friday", "--root", root, "--include-audit"]);
      expect(timeline.status).toBe(0);
      expect(timeline.stdout).toContain("superseded");
      expect(timeline.stdout).toContain("active");
      expect(timeline.stdout).toContain("SUPERSEDED_BY");
      expect(timeline.stdout).toContain("CONTRADICTS");
    },
    TIMEOUT,
  );
});
