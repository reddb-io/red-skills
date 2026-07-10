import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { encodingForModel } from "js-tiktoken";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { decode } from "@reddb-io/toon";
import contextPackCorpus from "./fixtures/context-pack-toon-corpus.json" with { type: "json" };
import dashboardCorpus from "./fixtures/dashboard-toon-corpus.json" with { type: "json" };
import timelineCorpus from "./fixtures/timeline-toon-corpus.json" with { type: "json" };
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { renderToonOutput } from "../src/toon-output.js";

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

async function graphRoot(prefix = "memory-batch2-toon-"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  const init = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);
  expect(init.status, init.stderr).toBe(0);
  return root;
}

async function seedContextPackRoot(): Promise<string> {
  const root = await graphRoot("memory-context-pack-toon-");
  const stored = runMemory([
    "store",
    "Decision: JWT token work must update docs/security.md and use signed fixtures.",
    "--root",
    root,
  ]);
  expect(stored.status, stored.stderr).toBe(0);
  return root;
}

async function seedTimelineRoot(): Promise<string> {
  const root = await graphRoot("memory-timeline-toon-");
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  try {
    const oldRid = await store.upsertNode({
      label: "deploy-friday",
      node_type: "decision",
      properties: {
        title: "deploy-friday",
        content: "deploy policy friday",
        created_at: 1,
        updated_at: 1,
      },
    });
    const newRid = await store.upsertNode({
      label: "deploy-tuesday",
      node_type: "decision",
      properties: {
        title: "deploy-tuesday",
        content: "deploy policy tuesday",
        created_at: 2,
        updated_at: 2,
      },
    });
    await store.supersede(oldRid, newRid, "policy changed");
  } finally {
    await store.close();
  }
  return root;
}

function tokenReduction(jsonPayload: unknown, toon: string): number {
  const tokenizer = encodingForModel("gpt-4o");
  const jsonTokens = tokenizer.encode(JSON.stringify(jsonPayload, null, 2)).length;
  const toonTokens = tokenizer.encode(toon).length;
  return ((jsonTokens - toonTokens) / jsonTokens) * 100;
}

describe("memory CLI batch 2 TOON output", () => {
  test("context-pack defaults to decodable TOON and keeps legacy JSON bytes under --json", async () => {
    const root = await seedContextPackRoot();

    const json = runMemory(["context-pack", "jwt token work", "--root", root, "--budget", "1200", "--json"]);
    expect(json.status, json.stderr).toBe(0);

    const toon = runMemory(["context-pack", "jwt token work", "--root", root, "--budget", "1200"]);
    expect(toon.status, toon.stderr).toBe(0);
    const decoded = decode(toon.stdout) as {
      entries: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    const legacy = JSON.parse(json.stdout) as {
      status: string;
      entries: Array<{ citation: { urn: string }; reason: string }>;
    };

    expect(decoded.summary).toMatchObject({
      status: legacy.status,
      goal: "jwt token work",
      entries: legacy.entries.length,
    });
    expect(decoded.entries[0]).toMatchObject({
      citation: legacy.entries[0].citation.urn,
      reason: legacy.entries[0].reason,
    });
  });

  test("context-pack empty state is definitive and suggests a next step", async () => {
    const root = await graphRoot("memory-context-pack-empty-toon-");

    const result = runMemory(["context-pack", "missing topic", "--root", root]);

    expect(result.status, result.stderr).toBe(0);
    const decoded = decode(result.stdout) as { summary: Record<string, unknown>; next: string };
    expect(decoded.summary).toMatchObject({ status: "insufficient-context", entries: 0 });
    expect(decoded.next).toBe("run `memory store \"...\" --root <root>` or `memory ingest . --root <root>`, then rerun context-pack");
  });

  test("timeline defaults to decodable TOON and keeps legacy JSON bytes under --json", async () => {
    const root = await seedTimelineRoot();

    const json = runMemory(["timeline", "friday", "--root", root, "--json"]);
    expect(json.status, json.stderr).toBe(0);

    const toon = runMemory(["timeline", "friday", "--root", root]);
    expect(toon.status, toon.stderr).toBe(0);
    const decoded = decode(toon.stdout) as {
      entries: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    const legacy = JSON.parse(json.stdout) as { entries: Array<{ rid: number; status: string }> };

    expect(decoded.entries.map((entry) => entry.rid)).toEqual(legacy.entries.map((entry) => entry.rid));
    expect(decoded.summary).toMatchObject({
      topic: "friday",
      entries: legacy.entries.length,
      active: 1,
      superseded: 1,
    });
  });

  test("timeline empty state is definitive and suggests a next step", async () => {
    const root = await graphRoot("memory-timeline-empty-toon-");

    const result = runMemory(["timeline", "missing topic", "--root", root]);

    expect(result.status, result.stderr).toBe(0);
    const decoded = decode(result.stdout) as { summary: Record<string, unknown>; next: string };
    expect(decoded.summary).toMatchObject({ status: "0 entries", entries: 0, topic: "missing topic" });
    expect(decoded.next).toBe("store or ingest topic evidence, then rerun `memory timeline <topic>`");
  });

  test("dashboard defaults to decodable TOON and keeps legacy JSON bytes under --json", async () => {
    const root = await graphRoot("memory-dashboard-toon-");

    const json = runMemory(["dashboard", "--root", root, "--json"]);
    expect(json.status, json.stderr).toBe(0);

    const toon = runMemory(["dashboard", "--root", root]);
    expect(toon.status, toon.stderr).toBe(0);
    const decoded = decode(toon.stdout) as {
      sections: Array<Record<string, unknown>>;
      summary: Record<string, unknown>;
    };
    const legacy = JSON.parse(json.stdout) as {
      schema_version: string;
      state: string;
      stats: { nodes: number; edges: number; docs: number };
    };

    expect(decoded.summary).toMatchObject({
      schema: legacy.schema_version,
      state: legacy.state,
      nodes: legacy.stats.nodes,
      edges: legacy.stats.edges,
      docs: legacy.stats.docs,
    });
    expect(decoded.sections.map((section) => section.area)).toEqual([
      "stats",
      "vector",
      "docs",
      "hooks",
      "extraction",
      "stale",
      "decay",
    ]);
  });

  test("dashboard empty state is definitive and suggests a next step", async () => {
    const root = await graphRoot("memory-dashboard-empty-toon-");

    const result = runMemory(["dashboard", "--root", root]);

    expect(result.status, result.stderr).toBe(0);
    const decoded = decode(result.stdout) as { summary: Record<string, unknown>; next: Array<Record<string, unknown>> };
    expect(decoded.summary).toMatchObject({ status: "empty", nodes: 0, docs: 0 });
    expect(decoded.next.some((item) => item.action === "run `memory ingest . --root <root>` to populate dashboard evidence")).toBe(true);
  });

  test("token-delta fixtures report measured percentages for all three surfaces", () => {
    const contextPackToon = renderToonOutput({
      rowsKey: "entries",
      rows: contextPackCorpus.entries,
      fields: ["section", "title", "nodeType", "importance", "confidence", "trust", "citation", "reason", "excerpt", "expandHandle"],
      summary: contextPackCorpus.summary,
      extra: { warnings: contextPackCorpus.warnings },
    });
    const timelineToon = renderToonOutput({
      rowsKey: "entries",
      rows: timelineCorpus.entries,
      fields: ["rid", "status", "activeRid", "nodeType", "label", "title", "content"],
      summary: timelineCorpus.summary,
      extra: { auditLinks: timelineCorpus.auditLinks },
    });
    const dashboardToon = renderToonOutput({
      rowsKey: "sections",
      rows: dashboardCorpus.sections,
      fields: ["area", "status", "metric", "value", "detail"],
      summary: dashboardCorpus.summary,
      extra: { warnings: dashboardCorpus.warnings, next: dashboardCorpus.next },
    });

    for (const [name, payload, toon] of [
      ["context-pack", contextPackCorpus, contextPackToon],
      ["timeline", timelineCorpus, timelineToon],
      ["dashboard", dashboardCorpus, dashboardToon],
    ] as const) {
      const reduction = tokenReduction(payload, toon);
      console.info(`memory ${name} token delta: reduction=${reduction.toFixed(1)}%`);
      expect(Number.isFinite(reduction)).toBe(true);
      expect(decode(toon)).toEqual(payload);
    }
  });
});
