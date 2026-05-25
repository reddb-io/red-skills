import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildWorkFrontier } from "../src/work-frontier.js";
import { buildWorkFrontierViewerArtifact } from "../src/work-frontier-viewer.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-work-frontier-"));
  roots.push(root);
  return root;
}

async function seedFrontierStore(root: string): Promise<MemoryStore> {
  await initGraph(root);
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  const setup = await store.upsertNode({
    label: "setup-env",
    node_type: "task",
    properties: {
      title: "Set up JWT test environment",
      content: "Set up signed JWT fixtures.",
      status: "done",
      importance: 0.9,
      created_at: 1_700_000_000_000,
    },
  });
  const implement = await store.upsertNode({
    label: "implement-jwt-rotation",
    node_type: "issue",
    properties: {
      title: "Implement JWT rotation",
      content: "Rotate JWT signing keys and update cache TTL handling.",
      status: "open",
      importance: 0.8,
      created_at: 1_700_000_100_000,
    },
  });
  const migrate = await store.upsertNode({
    label: "migrate-jwt-cache-ttl",
    node_type: "task",
    properties: {
      title: "Migrate JWT cache TTL",
      content: "Lower JWT cache TTL before release.",
      status: "open",
      importance: 0.7,
      created_at: 1_700_000_200_000,
    },
  });
  const release = await store.upsertNode({
    label: "release-jwt-rotation",
    node_type: "goal",
    properties: {
      title: "Release JWT rotation",
      content: "Ship JWT rotation after implementation and cache TTL migration.",
      status: "open",
      importance: 0.6,
      created_at: 1_700_000_300_000,
    },
  });
  await store.upsertEdge({ from_rid: setup, to_rid: implement, label: "BLOCKS" });
  await store.upsertEdge({
    from_rid: implement,
    to_rid: release,
    label: "PRECEDES",
    properties: { reason: "implementation must land before release" },
  });
  await store.upsertEdge({
    from_rid: migrate,
    to_rid: release,
    label: "BLOCKS",
    properties: { reason: "cache TTL migration gates release" },
  });
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory work frontier", () => {
  test("ranks ready work and explains blocked downstream items", async () => {
    const root = await tempRoot();
    const store = await seedFrontierStore(root);
    try {
      const report = await buildWorkFrontier(store, {
        focus: "jwt",
        now: 1_700_086_400_000,
      });

      expect(report).toMatchObject({
        schema_version: "memory.work_frontier.v1",
        read_only: true,
        status: "ready",
        focus: "jwt",
        summary: {
          candidate_work: 4,
          ready: 2,
          blocked: 1,
          completed: 1,
        },
      });
      expect(report.ready.map((item) => item.title)).toEqual(
        expect.arrayContaining(["Implement JWT rotation", "Migrate JWT cache TTL"]),
      );
      expect(report.blocked[0]).toMatchObject({
        title: "Release JWT rotation",
        blocked_by: [
          expect.objectContaining({ title: "Implement JWT rotation" }),
          expect.objectContaining({ title: "Migrate JWT cache TTL" }),
        ],
      });
      expect(report.completed[0]?.title).toBe("Set up JWT test environment");
      expect(report.markdown).toContain("## Ready Next");
      expect(report.markdown).toContain("Reasons: PRECEDES; BLOCKS");

      const artifact = buildWorkFrontierViewerArtifact(report);
      expect(artifact.contract).toEqual({
        name: "memory.work_frontier.viewer",
        version: "memory.work_frontier.viewer.v1",
        consumes: "memory.work_frontier.v1",
      });
      expect(artifact.html).toContain("Memory Work Frontier");
      expect(artifact.html).toContain("Implement JWT rotation");
      expect(artifact.html).toContain('id="memory-work-frontier-data"');
    } finally {
      await store.close();
    }
  });

  test(
    "CLI emits JSON and writes a local frontier viewer",
    async () => {
      const root = await tempRoot();
      const store = await seedFrontierStore(root);
      await store.close();

      const json = runMemory(["frontier", "jwt", "--root", root, "--json"]);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema_version: "memory.work_frontier.v1",
        status: "ready",
        summary: { ready: 2, blocked: 1 },
      });

      const out = join(root, "frontier.html");
      const result = runMemory(["frontier-viewer", "jwt", "--root", root, "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: work frontier viewer written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Work Frontier");
      expect(html).toContain("Implement JWT rotation");
      expect(html).toContain('id="memory-work-frontier-data"');
      expect(html).not.toContain("<script src=");
    },
    TIMEOUT,
  );
});
