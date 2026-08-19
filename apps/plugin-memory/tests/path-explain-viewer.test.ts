import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildPathExplainReport } from "../src/path-explain.js";
import { buildPathExplainViewerArtifact } from "../src/path-explain-viewer.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-path-explain-viewer-"));
  roots.push(root);
  return root;
}

async function seedStore(root: string): Promise<MemoryStore> {
  await initGraph(root);
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  const auth = await store.upsertNode({
    label: "auth-service",
    node_type: "concept",
    properties: { title: "Auth service", content: "Auth service issues JWT tokens." },
  });
  const jwt = await store.upsertNode({
    label: "jwt-rotation",
    node_type: "decision",
    properties: { title: "JWT rotation", content: "JWT tokens rotate every 90 days." },
  });
  await store.upsertEdge({ from_rid: auth, to_rid: jwt, label: "REFERENCES" });
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory path explanation viewer", () => {
  test("renders a self-contained HTML viewer", async () => {
    const root = await tempRoot();
    const store = await seedStore(root);
    try {
      const report = await buildPathExplainReport(store, {
        from: "auth-service",
        to: "jwt-rotation",
      });
      const artifact = buildPathExplainViewerArtifact(report);

      expect(artifact.contract).toEqual({
        name: "memory.path_explain.viewer",
        version: "memory.path_explain.viewer.v1",
        consumes: "memory.path_explain.v1",
      });
      expect(artifact.html).toContain("<!doctype html>");
      expect(artifact.html).toContain("Path Explanation");
      expect(artifact.html).toContain("Auth service");
      expect(artifact.html).toContain("--REFERENCES-->");
      expect(artifact.html).toContain('id="path-explain-data"');
      expect(artifact.html).not.toContain("<script src=");
    } finally {
      await store.close();
    }
  });

  test(
    "CLI writes the local viewer",
    async () => {
      const root = await tempRoot();
      const store = await seedStore(root);
      await store.close();
      const out = join(root, "path.html");

      const result = runMemory([
        "path-explain-viewer",
        "auth-service",
        "jwt-rotation",
        "--root",
        root,
        "--out",
        out,
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: path explanation viewer written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Path Explanation");
      expect(html).toContain("path-explain-data");
    },
    TIMEOUT,
  );
});
