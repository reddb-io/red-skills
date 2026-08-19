import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";
import { appendMemoryEvent, hookLifecycleToMemoryEvent } from "../src/memory-events.js";
import { buildMemoryLayersReport } from "../src/memory-layers.js";
import { buildMemoryLayersViewerArtifact } from "../src/memory-layers-viewer.js";

const TIMEOUT = 30_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function graphRoot(): Promise<{ root: string; store: MemoryStore }> {
  const root = await mkdtemp(join(tmpdir(), "memory-layers-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { hooks: true, skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return { root, store };
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory layers", () => {
  test("summarizes RedDB-backed short-term, durable, reasoning, docs/code, and vector layers", async () => {
    const { root, store } = await graphRoot();
    const decision = await store.upsertNode({
      label: "jwt-rotation",
      node_type: "decision",
      properties: {
        title: "JWT rotation",
        content: "Rotate JWT signing keys every 90 days.",
        confidence: "EXTRACTED",
      },
    });
    await store.recordReasoning(
      {
        label: "why-jwt-rotation",
        properties: {
          title: "Why JWT rotation stays enforced",
          content: "The security review requires replayable rationale.",
          confidence: "EXTRACTED",
        },
      },
      [decision],
    );
    const file = await store.upsertNode({
      label: "src/auth.ts",
      node_type: "file",
      properties: { title: "src/auth.ts", content: "auth code", confidence: "EXTRACTED" },
    });
    const symbol = await store.upsertNode({
      label: "rotateJwt",
      node_type: "symbol",
      properties: { title: "rotateJwt", content: "rotates jwt", confidence: "EXTRACTED" },
    });
    await store.upsertEdge({ from_rid: file, to_rid: symbol, label: "CONTAINS" });
    const doc = join(root, "docs", "auth.md");
    await mkdir(join(root, "docs"), { recursive: true });
    await writeFile(doc, "# Auth\n\nJWT rotation references signed fixtures.\n", "utf8");
    await indexFile(store, doc);
    await appendMemoryEvent(
      store,
      hookLifecycleToMemoryEvent(
        {
          event: "SessionStart",
          runner: "codex",
          sessionId: "session-layers",
          cwd: root,
          changedFiles: [],
          goal: "jwt rotation",
        },
        { noop: false, inject: "# Memory context\n" },
        { timestamp: "2026-05-24T10:00:00.000Z", eventId: "hook:layers:start" },
      ),
    );

    const report = await buildMemoryLayersReport(store, { now: 1_700_000_000_000 });

    expect(report).toMatchObject({
      schema_version: "memory.memory_layers.v1",
      read_only: true,
      summary: {
        total_layers: 5,
        ready_layers: expect.any(Number),
        red_db_backed_layers: 5,
      },
    });
    expect(report.layers.map((layer) => layer.id)).toEqual([
      "short-term",
      "long-term",
      "reasoning",
      "docs-code",
      "vectors",
    ]);
    expect(report.layers.find((layer) => layer.id === "short-term")?.counts).toMatchObject({
      events: 1,
      sessions: 1,
      hook_events: 1,
    });
    expect(report.layers.find((layer) => layer.id === "long-term")?.counts).toMatchObject({
      decisions: 1,
    });
    expect(report.layers.find((layer) => layer.id === "reasoning")?.counts).toMatchObject({
      reasoning_nodes: 1,
      touched_edges: 1,
    });
    expect(report.layers.find((layer) => layer.id === "docs-code")?.counts).toMatchObject({
      docs: 1,
      files: 1,
      symbols: 1,
      code_edges: expect.any(Number),
    });
    expect(report.reference_alignment.map((item) => item.reference)).toContain(
      "neo4j-labs/agent-memory",
    );

    const artifact = buildMemoryLayersViewerArtifact(report);
    expect(artifact.contract).toEqual({
      name: "memory.layers.viewer",
      version: "memory.layers.viewer.v1",
      consumes: "memory.memory_layers.v1",
    });
    expect(artifact.html).toContain("Memory Layers");
    expect(artifact.html).toContain("Reasoning traces and why-notes");
    expect(artifact.html).toContain("neo4j-labs/agent-memory");
    expect(artifact.html).toContain('id="memory-layers-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI emits JSON, human summaries, and the viewer artifact",
    async () => {
      const { root, store } = await graphRoot();
      await store.upsertNode({
        label: "cache-policy",
        node_type: "concept",
        properties: { title: "Cache policy", content: "Cache TTL is 30 seconds." },
      });
      await store.close();
      stores.pop();

      const json = runMemory(["layers", "--root", root, "--json"]);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema_version: "memory.memory_layers.v1",
        read_only: true,
        summary: { total_layers: 5 },
      });

      const text = runMemory(["layers", "--root", root]);
      expect(text.status, text.stderr).toBe(0);
      expect(text.stdout).toContain("memory layers:");
      expect(text.stdout).toContain("long-term:");

      const out = join(root, "layers.html");
      const viewer = runMemory(["layers-viewer", "--root", root, "--out", out]);
      expect(viewer.status, viewer.stderr).toBe(0);
      expect(viewer.stdout).toContain("memory: layers viewer written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Layers");
      expect(html).toContain('id="memory-layers-data"');
    },
    TIMEOUT,
  );
});
