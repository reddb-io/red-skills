import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
} from "../src/operational-dashboard.js";
import { MemoryStore } from "../src/graph-store.js";
import { indexFile } from "../src/ingest.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-operational-dashboard-"));
  roots.push(root);
  return root;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function seedDoc(root: string): Promise<string> {
  const doc = join(root, "docs", "security.md");
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    doc,
    "# Security\n\nJWT rotation references `JWT_SECRET` and signed fixtures.\n",
    "utf8",
  );
  return doc;
}

describe("Memory operational dashboard", () => {
  test("aggregates stats, doc coverage, hook coverage, vectors, and stale summary", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const doc = await seedDoc(root);
    const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
    try {
      await indexFile(store, doc);
      const active = await store.upsertNode({
        label: "cache-ttl-300",
        node_type: "decision",
        properties: {
          title: "Cache TTL is 300 seconds",
          content: "Current cache TTL is 300 seconds.",
          scope: "project",
          tier: "durable",
        },
      });
      const superseded = await store.upsertNode({
        label: "cache-ttl-60",
        node_type: "decision",
        properties: {
          title: "Cache TTL is 60 seconds",
          content: "Old cache TTL was 60 seconds.",
          scope: "project",
          tier: "durable",
        },
      });
      await store.supersede(superseded, active, "newer TTL decision");
      const dashboard = await buildMemoryOperationalDashboard(store, root, {
        now: 1_700_000_000_000,
      });

      expect(dashboard).toMatchObject({
        schema_version: "memory.operational_dashboard.v1",
        read_only: true,
        stats: { docs: 1 },
        docs: {
          total: 1,
          grounded: 1,
          with_references: 1,
        },
        hooks: {
          mode: "graph",
          enabled_events: 7,
          wired_events: 7,
          total_events: 8,
        },
        extraction: {
          inferred_available: false,
          inferred_facts: 0,
        },
        decay: {
          status: "attention",
          deprecate: 1,
          superseded: 1,
        },
      });
      expect(["attention", "degraded"]).toContain(dashboard.state);
      expect(dashboard.vector.overall).toMatch(/unavailable|failed/);
      expect(dashboard.sources.doc_coverage.schema_version).toBe("memory.doc_coverage.v1");
      expect(dashboard.sources.hook_coverage.schema_version).toBe("memory.hook_coverage.v1");
      expect(dashboard.sources.extraction_status.schema_version).toBe("memory.extraction_status.v1");
      expect(dashboard.sources.decay_plan.schema_version).toBe("memory.decay_plan.v1");
      expect(dashboard.recommended_next_actions).toContain(
        "prefer superseding or newer Memory evidence before relying on deprecate candidates",
      );

      const artifact = buildMemoryOperationalDashboardArtifact(dashboard);
      expect(artifact.contract).toEqual({
        name: "memory.operational_dashboard.viewer",
        version: "memory.operational_dashboard.viewer.v1",
        consumes: "memory.operational_dashboard.v1",
      });
      expect(artifact.html).toContain("Memory Operational Dashboard");
      expect(artifact.html).toContain("Extraction");
      expect(artifact.html).toContain("Decay");
      expect(artifact.html).toContain("memory.decay_plan.v1");
      expect(artifact.html).toContain('id="memory-dashboard-data"');
    } finally {
      await store.close();
    }
  });

  test(
    "CLI writes a self-contained local dashboard",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { hooks: true });
      await seedDoc(root);

      const ingest = runMemory(["ingest", root, "--root", root]);
      expect(ingest.status, ingest.stderr).toBe(0);

      const out = join(root, "dashboard.html");
      const result = runMemory(["dashboard", "--root", root, "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: operational dashboard written");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Operational Dashboard");
      expect(html).toContain("memory-dashboard-data");

      const json = runMemory(["dashboard", "--root", root, "--json"]);
      expect(json.status, json.stderr).toBe(0);
      expect(JSON.parse(json.stdout)).toMatchObject({
        schema_version: "memory.operational_dashboard.v1",
        stats: { docs: 1 },
        decay: expect.any(Object),
        sources: {
          decay_plan: { schema_version: "memory.decay_plan.v1" },
        },
      });
    },
    TIMEOUT,
  );
});
