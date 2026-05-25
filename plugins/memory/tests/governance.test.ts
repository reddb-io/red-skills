import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryGovernanceReport } from "../src/governance.js";
import { buildMemoryGovernanceViewerArtifact } from "../src/governance-viewer.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-governance-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
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

describe("Memory governance", () => {
  test("summarizes provenance, privacy, lint, contradictions, and supersession", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const active = await store.upsertNode({
      label: "deploys-on-tuesday",
      node_type: "decision",
      properties: {
        title: "Deploys happen on Tuesday",
        content: "Deploys happen on Tuesday.",
        scope: "project",
        tier: "durable",
        provenance: { source_kind: "manual", writer: "test", confidence: "EXTRACTED" },
      },
    });
    const stale = await store.upsertNode({
      label: "deploys-on-friday",
      node_type: "decision",
      properties: {
        title: "Deploys happen on Friday",
        content: "Deploys happen on Friday. api_key: sk-test000000000000000000000000",
        api_key: "sk-test000000000000000000000000",
      },
    });
    await store.upsertEdge({
      label: "CONTRADICTS",
      from_rid: active,
      to_rid: stale,
      properties: { reason: "schedule changed" },
    });
    await store.supersede(stale, active, "Tuesday replaced Friday");

    const report = await buildMemoryGovernanceReport(store, {
      now: Date.UTC(2026, 4, 22),
    });

    expect(report.schema_version).toBe("memory.governance.v1");
    expect(report.read_only).toBe(true);
    expect(report.status).toBe("degraded");
    expect(report.summary.total_nodes).toBe(2);
    expect(report.summary.nodes_with_provenance).toBe(1);
    expect(report.summary.missing_provenance).toBe(1);
    expect(report.summary.privacy_findings).toBeGreaterThanOrEqual(1);
    expect(report.summary.lint_findings).toBeGreaterThanOrEqual(1);
    expect(report.summary.resolved_contradictions).toBe(1);
    expect(report.summary.superseded_nodes).toBe(1);
    expect(report.provenance.by_source_kind).toContainEqual({ source_kind: "manual", count: 1 });
    expect(report.recommended_next_actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("memory privacy scan"),
        expect.stringContaining("memory lint"),
      ]),
    );

    const artifact = buildMemoryGovernanceViewerArtifact(report);
    expect(artifact.contract).toMatchObject({
      name: "memory.governance.viewer",
      version: "memory.governance.viewer.v1",
      consumes: "memory.governance.v1",
    });
    expect(artifact.html).toContain("Memory Governance");
    expect(artifact.html).toContain('id="memory-governance-data"');
    expect(artifact.html).toContain("Deploys happen on Friday");
  });

  test("writes a self-contained CLI governance viewer", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await store.upsertNode({
      label: "governance-viewer",
      node_type: "concept",
      properties: {
        title: "Governance viewer",
        content: "Governance viewer evidence.",
        scope: "project",
        tier: "durable",
        provenance: { source_kind: "manual", writer: "test", confidence: "EXTRACTED" },
      },
    });
    await store.close();

    const out = join(root, "governance.html");
    const result = runMemory(["governance-viewer", "--root", root, "--out", out]);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("memory: governance viewer written");
    expect(result.stdout).toContain("contract: memory.governance.v1");
    const html = await readFile(out, "utf8");
    expect(html).toContain("Memory Governance");
    expect(html).toContain('id="memory-governance-data"');
  }, TIMEOUT);
});
