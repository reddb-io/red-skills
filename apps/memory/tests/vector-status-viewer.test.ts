import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildVectorStatusViewerArtifact } from "../src/vector-status-viewer.js";

const roots: string[] = [];
const stores: MemoryStore[] = [];
const pkgRoot = resolve(__dirname, "..");
const TIMEOUT = 40_000;

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-vector-status-viewer-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  await store.upsertNode({
    label: "vector-readiness",
    node_type: "concept",
    properties: {
      title: "Vector readiness",
      content: "Vector status should remain inspectable without maintaining embeddings.",
      confidence: "EXTRACTED",
    },
  });
  return { root, store };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory vector status viewer", () => {
  test("builds a self-contained viewer over vector projection status", async () => {
    const { store } = await graphRoot();
    const report = await store.vectorStatus();

    const artifact = buildVectorStatusViewerArtifact(report);

    expect(artifact.contract).toEqual({
      name: "memory.vector_status.viewer",
      version: "memory.vector_status.viewer.v1",
      consumes: "memory.vector_status.v1",
    });
    expect(artifact.report.schema_version).toBe("memory.vector_status.v1");
    expect(artifact.html).toContain("Vector Status");
    expect(artifact.html).toContain("Memory Nodes");
    expect(artifact.html).toContain("vector-readiness");
    expect(artifact.html).toContain('id="vector-status-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test("CLI writes vector status viewer HTML", async () => {
    const { root, store } = await graphRoot();
    await store.close();
    stores.pop();
    const out = join(root, "vector-status.html");

    const result = runMemory(["vector", "status-viewer", "--root", root, "--out", out]);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory: vector status viewer written");
    expect(result.stdout).toContain("contract: memory.vector_status.v1");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Vector Status");
    expect(html).toContain('id="vector-status-data"');
  });
});
