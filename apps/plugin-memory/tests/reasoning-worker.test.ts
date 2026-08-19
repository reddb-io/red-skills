import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { readConfig, resolveStoreUri } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph, initMarkdownOnly } from "../src/init.js";
import {
  workerNodeLabel,
  fileNodeLabel,
  issueNodeLabel,
  parseParentPrdFromBody,
  prdNodeLabel,
  recordReasoningWorker,
  validationNodeLabel,
  type ReasoningWorkerPayload,
} from "../src/reasoning/worker-writer.js";
import { defaultTier } from "../src/schema.js";
import { graphRecallResult } from "../src/graph-recall.js";
import { recall } from "../src/engine.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function openStore(): Promise<MemoryStore> {
  const dir = await mkdtemp(join(tmpdir(), "memory-attempt-"));
  roots.push(dir);
  const store = await MemoryStore.open({
    uri: `file://${join(dir, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

async function openProjectStore(root: string): Promise<MemoryStore> {
  const config = await readConfig(root);
  if (!config) throw new Error("expected memory config");
  const store = await MemoryStore.open({
    uri: resolveStoreUri(root, config),
    project: "test",
  });
  stores.push(store);
  return store;
}

async function projectStats(root: string): Promise<{ nodes: number; edges: number }> {
  const store = await openProjectStore(root);
  try {
    return await store.stats();
  } finally {
    await store.close();
  }
}

function runMemory(args: string[], input?: string) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    input,
    timeout: TIMEOUT,
  });
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const samplePayload: ReasoningWorkerPayload = {
  repository: "reddb-io/red-skills",
  issueNumber: 96,
  attemptNumber: 1,
  status: "done",
  issueType: "bug",
  modelTier: "simple",
  outcome: "success",
  issueTitle: "Record a single Reasoning attempt into Memory Graph",
  issueUrl: "https://github.com/reddb-io/red-skills/issues/96",
  workerId: "claude",
  branch: "afk/wGYFQ/96-record-a-single-reasoning-attempt-into-m",
  durationMs: 412_000,
  diffstat: "3 files changed, 220 insertions(+), 4 deletions(-)",
  envelopeRef: "https://github.com/reddb-io/red-skills/issues/96#issuecomment-1",
  envelopeHash: "envh-deadbeef",
  mergeCommit: "abc1234",
  touchedFiles: [
    "plugins/memory/src/schema.ts",
    "plugins/memory/src/reasoning/attempt-writer.ts",
  ],
  notes: "first slice of the engineering semantic graph",
  errorClass: undefined,
  validationSummary: "tests pass, typecheck pass, build pass",
  summary: "recorded attempt #96/1 into the graph",
};

describe("parseParentPrdFromBody", () => {
  test("returns null for an empty / undefined body", () => {
    expect(parseParentPrdFromBody(undefined)).toBeNull();
    expect(parseParentPrdFromBody("")).toBeNull();
    expect(parseParentPrdFromBody("just some prose")).toBeNull();
  });

  test("parses `prd: #N` as a marker line", () => {
    expect(parseParentPrdFromBody("prd: #95")).toBe(95);
    expect(parseParentPrdFromBody("## Header\n\nprd: #42\n\nbody")).toBe(42);
  });

  test("parses `parent-prd: #N` and prefers it over `prd:`", () => {
    expect(parseParentPrdFromBody("parent-prd: #7")).toBe(7);
    expect(parseParentPrdFromBody("prd: #99\nparent-prd: #7")).toBe(7);
  });

  test("accepts the marker without the `#` prefix", () => {
    expect(parseParentPrdFromBody("prd: 95")).toBe(95);
    expect(parseParentPrdFromBody("parent-prd: 95")).toBe(95);
  });

  test("is case-insensitive and tolerates leading whitespace", () => {
    expect(parseParentPrdFromBody("  PRD: #95")).toBe(95);
    expect(parseParentPrdFromBody("\tParent-PRD: #95")).toBe(95);
  });

  test("does not match weak signals (prose mentions, links, titles)", () => {
    // The marker must be a line; references in prose, code fences, or links
    // never count. The parser only sees the body, so labels/title/branch are
    // already out of scope by construction.
    expect(parseParentPrdFromBody("This grew out of #95")).toBeNull();
    expect(
      parseParentPrdFromBody("See https://github.com/x/y/issues/95 for context"),
    ).toBeNull();
    expect(parseParentPrdFromBody("Parent: #95")).toBeNull();
    expect(parseParentPrdFromBody("(parent-prd: #95 inline)")).toBeNull();
    expect(parseParentPrdFromBody("the prd #95 is related")).toBeNull();
  });
});

describe("schema: engineering-graph node types (PRD #95)", () => {
  test("attempt defaults to the reasoning tier; issue/prd/validation default to durable", () => {
    expect(defaultTier("worker")).toBe("reasoning");
    expect(defaultTier("issue")).toBe("durable");
    expect(defaultTier("prd")).toBe("durable");
    expect(defaultTier("validation")).toBe("durable");
  });
});

describe("recordReasoningWorker", () => {
  test(
    "records an attempt node defaulting to the reasoning tier",
    async () => {
      const store = await openStore();
      const { workerRid } = await recordReasoningWorker(store, samplePayload);

      const node = await store.getNode(workerRid);
      expect(node?.node_type).toBe("worker");
      expect(node?.properties.tier).toBe("reasoning");
      expect(node?.properties.expires_at).toBeUndefined();
      expect(node?.label).toBe(
        workerNodeLabel("reddb-io/red-skills", 96, 1, "claude"),
      );
    },
    TIMEOUT,
  );

  test(
    "keeps operational evidence inspectable as attempt properties",
    async () => {
      const store = await openStore();
      const { workerRid } = await recordReasoningWorker(store, samplePayload);
      const node = await store.getNode(workerRid);
      const props = (node?.properties ?? {}) as Record<string, unknown>;

      expect(props.status).toBe("done");
      expect(props.issue_type).toBe(samplePayload.issueType);
      expect(props.model_tier).toBe(samplePayload.modelTier);
      expect(props.outcome).toBe(samplePayload.outcome);
      expect(props.branch).toBe(samplePayload.branch);
      expect(props.duration_ms).toBe(samplePayload.durationMs);
      expect(props.diffstat).toBe(samplePayload.diffstat);
      expect(props.envelope_ref).toBe(samplePayload.envelopeRef);
      expect(props.envelope_hash).toBe(samplePayload.envelopeHash);
      expect(props.merge_commit).toBe(samplePayload.mergeCommit);
      expect(props.notes).toBe(samplePayload.notes);
      expect(props.validation_summary).toBe(samplePayload.validationSummary);
      expect(props.summary).toBe(samplePayload.summary);
      expect(props.touched_files).toEqual(samplePayload.touchedFiles);
    },
    TIMEOUT,
  );

  test(
    "stamps user-hook executions onto the attempt node and drops the field when none ran",
    async () => {
      const store = await openStore();
      const withHooks = await recordReasoningWorker(store, {
        ...samplePayload,
        hooks: [
          { lifecycle: "pre_pick", command: "scripts/filter.sh --label ready-for-agent", exit_code: 0 },
          { lifecycle: "post_pick", command: "scripts/audit.sh", exit_code: 1 },
          // Junk entries are dropped instead of forwarded so the node never
          // carries half-filled triples.
          { lifecycle: "", command: "noop", exit_code: 0 } as never,
          { lifecycle: "post_merge", command: "", exit_code: 0 } as never,
        ],
      });
      const node = await store.getNode(withHooks.workerRid);
      expect(node?.properties.hooks).toEqual([
        { lifecycle: "pre_pick", command: "scripts/filter.sh --label ready-for-agent", exit_code: 0 },
        { lifecycle: "post_pick", command: "scripts/audit.sh", exit_code: 1 },
      ]);

      const withoutHooks = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-no-hooks",
        hooks: undefined,
      });
      const empty = await store.getNode(withoutHooks.workerRid);
      expect(empty?.properties.hooks).toBeUndefined();

      const withEmptyArray = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 3,
        envelopeHash: "envh-empty-hooks",
        hooks: [],
      });
      const stillEmpty = await store.getNode(withEmptyArray.workerRid);
      expect(stillEmpty?.properties.hooks).toBeUndefined();
    },
    TIMEOUT,
  );

  test(
    "recall surfaces include the attempt hooks field in CLI hits and context_md",
    async () => {
      const store = await openStore();
      await recordReasoningWorker(store, {
        ...samplePayload,
        summary: "filterhook attempt for recall coverage",
        hooks: [
          { lifecycle: "pre_pick", command: "scripts/filter.sh", exit_code: 0 },
          { lifecycle: "post_pick", command: "scripts/audit.sh", exit_code: 2 },
        ],
      });
      const { hits } = await graphRecallResult(store, "filterhook recall coverage", 10);
      const attemptHit = hits.find((h) => h.node_type === "worker");
      expect(attemptHit?.hooks).toEqual([
        { lifecycle: "pre_pick", command: "scripts/filter.sh", exit_code: 0 },
        { lifecycle: "post_pick", command: "scripts/audit.sh", exit_code: 2 },
      ]);
      const { context_md } = await recall(store, "filterhook recall coverage", { k: 10 });
      expect(context_md).toContain("hooks: pre_pick=0, post_pick=2");
    },
    TIMEOUT,
  );

  test(
    "creates durable validation nodes from structured sidecar records and links them with TESTED_BY",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        validationRecords: [
          {
            name: "test:plugins/memory",
            command: "pnpm -C apps/plugin-memory test",
            status: "passed",
            durationMs: 1234,
            summary: "vitest run completed",
          },
          {
            name: "typecheck:plugins/memory",
            command: "pnpm -C apps/plugin-memory typecheck",
            status: "failed",
            durationMs: 456,
            summary: "TS2322 in attempt-writer.ts",
          },
        ],
      });

      expect(r.validationRids).toHaveLength(2);
      expect(r.testedByEdges).toHaveLength(2);

      const first = await store.getNode(r.validationRids[0]);
      expect(first?.node_type).toBe("validation");
      expect(first?.label).toBe(
        validationNodeLabel("reddb-io/red-skills", 96, 1, "test:plugins/memory"),
      );
      expect(first?.properties.tier).toBe("durable");
      expect(first?.properties.name).toBe("test:plugins/memory");
      expect(first?.properties.command).toBe("pnpm -C apps/plugin-memory test");
      expect(first?.properties.status).toBe("passed");
      expect(first?.properties.duration_ms).toBe(1234);
      expect(first?.properties.summary).toBe("vitest run completed");

      const edge = await store.findEdge(r.workerRid, r.validationRids[0], "TESTED_BY");
      expect(edge).toBe(r.testedByEdges[0]);

      const attempt = await store.getNode(r.workerRid);
      expect(attempt?.properties.validation_summary).toBe(samplePayload.validationSummary);
    },
    TIMEOUT,
  );

  test(
    "re-recording the same structured validations is idempotent",
    async () => {
      const store = await openStore();
      const payload: ReasoningWorkerPayload = {
        ...samplePayload,
        validationRecords: [
          {
            name: "test:plugins/memory",
            command: "pnpm -C apps/plugin-memory test",
            status: "passed",
          },
        ],
      };

      const first = await recordReasoningWorker(store, payload);
      const second = await recordReasoningWorker(store, {
        ...payload,
        validationRecords: [
          {
            name: "test:plugins/memory",
            command: "pnpm -C apps/plugin-memory test",
            status: "failed",
            summary: "refined failure summary",
          },
        ],
      });

      expect(second.validationRids).toEqual(first.validationRids);
      expect(second.testedByEdges).toEqual(first.testedByEdges);

      const { nodes, edges } = await store.stats();
      // 1 issue + 1 attempt + 2 files + 1 validation.
      expect(nodes).toBe(5);
      // 1 CONTAINS + 2 TOUCHED + 1 TESTED_BY.
      expect(edges).toBe(4);
    },
    TIMEOUT,
  );

  test(
    "missing or malformed validation records create no validation graph data",
    async () => {
      const store = await openStore();
      const missing = await recordReasoningWorker(store, {
        ...samplePayload,
        touchedFiles: [],
        validationRecords: undefined,
      });
      const malformed = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-malformed",
        touchedFiles: [],
        validationRecords: [
          null,
          "not an object",
          { name: "", status: "passed" },
          { name: "test:plugins/memory" },
        ] as unknown as ReasoningWorkerPayload["validationRecords"],
      });

      expect(missing.validationRids).toEqual([]);
      expect(missing.testedByEdges).toEqual([]);
      expect(malformed.validationRids).toEqual([]);
      expect(malformed.testedByEdges).toEqual([]);

      const nodes = await store.listNodes();
      expect(nodes.filter((n) => n.node_type === "validation")).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "creates a minimal issue node and connects it to the attempt with CONTAINS",
    async () => {
      const store = await openStore();
      const { workerRid, issueRid, containsEdge } = await recordReasoningWorker(
        store,
        samplePayload,
      );

      const issue = await store.getNode(issueRid);
      expect(issue?.node_type).toBe("issue");
      expect(issue?.label).toBe(issueNodeLabel("reddb-io/red-skills", 96));
      expect(issue?.properties.issue_number).toBe(96);
      expect(issue?.properties.source).toBe("github-issues");
      expect(issue?.properties.url).toBe(samplePayload.issueUrl);

      // CONTAINS: issue → attempt (work hierarchy).
      expect(containsEdge).toBeGreaterThan(0);
      const found = await store.findEdge(issueRid, workerRid, "CONTAINS");
      expect(found).toBe(containsEdge);
    },
    TIMEOUT,
  );

  test(
    "creates minimal file nodes for touched paths and TOUCHED edges from attempt → file",
    async () => {
      const store = await openStore();
      const { workerRid, fileRids, touchedEdges } = await recordReasoningWorker(
        store,
        samplePayload,
      );

      expect(fileRids).toHaveLength(samplePayload.touchedFiles!.length);
      expect(touchedEdges).toHaveLength(samplePayload.touchedFiles!.length);

      for (let i = 0; i < fileRids.length; i++) {
        const path = samplePayload.touchedFiles![i];
        const file = await store.getNode(fileRids[i]);
        expect(file?.node_type).toBe("file");
        expect(file?.label).toBe(fileNodeLabel(path));
        expect(file?.properties.title).toBe(path);
        // Minimal node: no language / symbols / extracted source.
        expect(file?.properties.language).toBeUndefined();

        const edge = await store.findEdge(workerRid, fileRids[i], "TOUCHED");
        expect(edge).toBe(touchedEdges[i]);
      }
    },
    TIMEOUT,
  );

  test(
    "is idempotent: re-recording the same attempt does not duplicate nodes or edges",
    async () => {
      const store = await openStore();
      const first = await recordReasoningWorker(store, samplePayload);

      // Re-record with refined notes / validation summary — identity is stable
      // on AFK coordinates, not on observational evidence.
      const second = await recordReasoningWorker(store, {
        ...samplePayload,
        notes: "refined notes after the fact",
        validationSummary: "tests pass (rerun)",
      });

      expect(second.workerRid).toBe(first.workerRid);
      expect(second.issueRid).toBe(first.issueRid);
      expect(second.fileRids).toEqual(first.fileRids);
      expect(second.touchedEdges).toEqual(first.touchedEdges);
      expect(second.containsEdge).toBe(first.containsEdge);

      const { nodes, edges } = await store.stats();
      // 1 issue + 1 attempt + 2 files = 4 nodes; 1 CONTAINS + 2 TOUCHED = 3 edges.
      expect(nodes).toBe(4);
      expect(edges).toBe(3);
    },
    TIMEOUT,
  );

  test(
    "reuses the same file node across attempts that touched the same path",
    async () => {
      const store = await openStore();
      const r1 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-aaa",
        touchedFiles: ["plugins/memory/src/schema.ts"],
      });
      const r2 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-bbb",
        touchedFiles: ["plugins/memory/src/schema.ts"],
      });

      expect(r1.fileRids[0]).toBe(r2.fileRids[0]);
      // Two distinct attempts on the same issue.
      expect(r1.workerRid).not.toBe(r2.workerRid);
      expect(r1.issueRid).toBe(r2.issueRid);

      const { nodes } = await store.stats();
      // 1 issue + 2 attempts + 1 file = 4 nodes.
      expect(nodes).toBe(4);
    },
    TIMEOUT,
  );

  test(
    "an empty touched-files list still records the attempt and issue",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        touchedFiles: [],
      });
      expect(r.fileRids).toEqual([]);
      expect(r.touchedEdges).toEqual([]);
      const attempt = await store.getNode(r.workerRid);
      expect(attempt?.properties.touched_files).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "parses prd: #N from the issue body and creates a minimal prd node + prd CONTAINS issue",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        issueBody: "## Parent\n\nprd: #95\n\nbody body",
      });

      expect(r.parentPrd).toBe(95);
      expect(r.prdRid).toBeGreaterThan(0);
      expect(r.prdContainsIssueEdge).toBeGreaterThan(0);

      const prd = await store.getNode(r.prdRid!);
      expect(prd?.node_type).toBe("prd");
      expect(prd?.label).toBe(prdNodeLabel("reddb-io/red-skills", 95));
      expect(prd?.properties.prd_number).toBe(95);

      const issue = await store.getNode(r.issueRid);
      expect(issue?.properties.parent_prd).toBe(95);

      const attempt = await store.getNode(r.workerRid);
      expect(attempt?.properties.parent_prd).toBe(95);

      const edge = await store.findEdge(r.prdRid!, r.issueRid, "CONTAINS");
      expect(edge).toBe(r.prdContainsIssueEdge);
    },
    TIMEOUT,
  );

  test(
    "accepts parent-prd: #N as the alternate marker form",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        issueBody: "parent-prd: #95\n\n## What to build\n\n…",
      });
      expect(r.parentPrd).toBe(95);
      expect(r.prdRid).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test(
    "does not infer a parent PRD from labels, title text, comments, links, or branch names",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        // Every weak signal at once: hash-style mentions in prose, an issue
        // link, a parent-looking phrase, a markdown reference. None of these
        // is the `prd: #N` / `parent-prd: #N` marker.
        issueTitle: "Fix #95 follow-up",
        branch: "afk/x/prd-95-followup",
        issueBody: [
          "## Background",
          "",
          "This grew out of #95 and references https://github.com/reddb-io/red-skills/issues/95.",
          "Parent: #95 (informational only — not the marker).",
          "",
          "Body mentions prd #95 inline but no marker line.",
        ].join("\n"),
      });

      expect(r.parentPrd).toBeUndefined();
      expect(r.prdRid).toBeUndefined();
      expect(r.prdContainsIssueEdge).toBeUndefined();

      const issue = await store.getNode(r.issueRid);
      expect(issue?.properties.parent_prd).toBeUndefined();

      const { nodes } = await store.stats();
      // 1 issue + 1 attempt + 2 files = 4 nodes, no prd node added.
      expect(nodes).toBe(4);
    },
    TIMEOUT,
  );

  test(
    "still creates issue CONTAINS attempt when no parent PRD is declared",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        issueBody: undefined,
      });
      expect(r.prdRid).toBeUndefined();
      expect(r.containsEdge).toBeGreaterThan(0);
      const edge = await store.findEdge(r.issueRid, r.workerRid, "CONTAINS");
      expect(edge).toBe(r.containsEdge);
    },
    TIMEOUT,
  );

  test(
    "links attempts on the same issue with deterministic PRECEDES edges in attempt-number order",
    async () => {
      const store = await openStore();
      // Record out of order — 2 first, then 1, then 3 — to prove the chain is
      // rebuilt deterministically each time rather than recording-time linked.
      const r2 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        touchedFiles: [],
      });
      const r1 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        touchedFiles: [],
      });
      const r3 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 3,
        envelopeHash: "envh-3",
        touchedFiles: [],
      });

      // Chain after final record: 1 → 2 → 3.
      expect(r3.precedesEdges).toHaveLength(2);
      const e12 = await store.findEdge(r1.workerRid, r2.workerRid, "PRECEDES");
      const e23 = await store.findEdge(r2.workerRid, r3.workerRid, "PRECEDES");
      expect(e12).not.toBeNull();
      expect(e23).not.toBeNull();

      // No skip edges and no reverse edges.
      const e13 = await store.findEdge(r1.workerRid, r3.workerRid, "PRECEDES");
      const e21 = await store.findEdge(r2.workerRid, r1.workerRid, "PRECEDES");
      expect(e13).toBeNull();
      expect(e21).toBeNull();
    },
    TIMEOUT,
  );

  test(
    "re-recording does not duplicate PRD, hierarchy, or PRECEDES edges",
    async () => {
      const store = await openStore();
      const body = "prd: #95\n\nbody";
      const a1 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        issueBody: body,
        touchedFiles: [],
      });
      const a2 = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        issueBody: body,
        touchedFiles: [],
      });

      // Re-record both, in either order, with refined notes.
      const a2b = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        issueBody: body,
        touchedFiles: [],
        notes: "refined",
      });
      const a1b = await recordReasoningWorker(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        issueBody: body,
        touchedFiles: [],
        notes: "refined",
      });

      expect(a1b.workerRid).toBe(a1.workerRid);
      expect(a2b.workerRid).toBe(a2.workerRid);
      expect(a1b.issueRid).toBe(a1.issueRid);
      expect(a1b.prdRid).toBe(a1.prdRid);

      const { nodes, edges } = await store.stats();
      // 1 prd + 1 issue + 2 attempts = 4 nodes.
      expect(nodes).toBe(4);
      // 1 prd→issue CONTAINS + 2 issue→attempt CONTAINS + 1 PRECEDES = 4 edges.
      expect(edges).toBe(4);
    },
    TIMEOUT,
  );

  test(
    "dedupes repeated paths in the touched-files input",
    async () => {
      const store = await openStore();
      const r = await recordReasoningWorker(store, {
        ...samplePayload,
        touchedFiles: ["a.ts", "a.ts", "  ", "b.ts"],
      });
      expect(r.touchedFiles).toEqual(["a.ts", "b.ts"]);
      expect(r.fileRids).toHaveLength(2);
    },
    TIMEOUT,
  );
});

describe("CLI attempt record", () => {
  test(
    "records one attempt into a graph-mode project from stdin",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-attempt-cli-"));
      roots.push(root);
      await initGraph(root);

      const result = runMemory(
        ["attempt", "record", "--root", root],
        JSON.stringify(samplePayload),
      );
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("memory: recorded attempt");
      expect(result.stdout).toContain("reddb-io/red-skills#96/1");
      expect(result.stderr).toBe("");
    },
    TIMEOUT,
  );

  test(
    "rejects the write outside graph mode",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-attempt-cli-markdown-"));
      roots.push(root);
      await initMarkdownOnly(root);

      const result = runMemory(
        ["attempt", "record", "--root", root],
        JSON.stringify(samplePayload),
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("this verb needs graph mode");
    },
    TIMEOUT,
  );
});

describe("CLI attempt learn", () => {
  test(
    "reports approval-gated learning proposals without mutating Memory by default",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-attempt-learn-"));
      roots.push(root);
      await initGraph(root);

      const done = runMemory(
        ["attempt", "record", "--root", root],
        JSON.stringify({
          ...samplePayload,
          attemptNumber: 1,
          envelopeHash: "envh-learn-1",
          summary: "Claim-check verifies claims against local recall evidence without provider ASK.",
          notes: "running pnpm test; raw stdout in /tmp/bg-task.output",
          validationRecords: [
            {
              name: "pnpm test",
              command: "pnpm test",
              status: "passed",
              summary: "vitest suite passed; raw stdout in /tmp/bg-task.output",
            },
          ],
        } satisfies ReasoningWorkerPayload),
      );
      expect(done.status, done.stderr).toBe(0);

      const blocked = runMemory(
        ["attempt", "record", "--root", root],
        JSON.stringify({
          ...samplePayload,
          attemptNumber: 2,
          status: "blocked",
          envelopeHash: "envh-learn-2",
          touchedFiles: ["skills/core/recall/SKILL.md"],
          summary: "memory:recall skill failed during verify because graph mode was not initialized.",
          notes: "WIP: test still running before the next validation pass",
          errorClass: "ValidationError",
          validationRecords: [
            {
              name: "pnpm typecheck",
              command: "pnpm typecheck",
              status: "failed",
              summary: "TS2322 in recall.ts",
            },
            {
              name: "progress note",
              status: "skipped",
              summary: "WIP: test still running before the next validation pass",
            },
          ],
        } satisfies ReasoningWorkerPayload),
      );
      expect(blocked.status, blocked.stderr).toBe(0);

      const result = runMemory(["attempt", "learn", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        state: string;
        proposals: Array<{ kind: string; evidence: unknown[] }>;
        rejected: Array<{ kind: string; action: string }>;
      };

      expect(body.state).toBe("proposal-ready");
      expect(body.proposals.map((p) => p.kind)).toEqual(
        expect.arrayContaining(["durable_fact", "failure", "validation", "skill_improvement"]),
      );
      expect(body.proposals[0].evidence.length).toBeGreaterThan(0);
      expect(body.rejected).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "raw_operational_log",
            action: "rejected",
          }),
          expect.objectContaining({
            kind: "temporary_progress",
            action: "downgraded",
          }),
        ]),
      );

      const after = await openProjectStore(root);
      const afterNodes = await after.listNodes();
      expect(afterNodes.some((n) => n.properties.source === "attempt-learning")).toBe(false);
      await expect(readdir(join(root, ".red", "memory", "proposals"))).rejects.toThrow();
    },
    TIMEOUT,
  );

  test(
    "writes proposal files without mutating Memory and applies them only with explicit approval",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "memory-attempt-learn-apply-"));
      roots.push(root);
      await initGraph(root);

      const recorded = runMemory(
        ["attempt", "record", "--root", root],
        JSON.stringify({
          ...samplePayload,
          attemptNumber: 1,
          envelopeHash: "envh-learn-apply",
          summary: "Attempt learning proposals must stay approval-gated until reviewed.",
          validationRecords: [
            {
              name: "pnpm test",
              command: "pnpm test",
              status: "passed",
              summary: "vitest suite passed",
            },
          ],
        } satisfies ReasoningWorkerPayload),
      );
      expect(recorded.status, recorded.stderr).toBe(0);

      const beforeStats = await projectStats(root);

      const generated = runMemory(["attempt", "learn", "--root", root, "--write-proposal", "--json"]);
      expect(generated.status, generated.stderr).toBe(0);
      const generatedBody = JSON.parse(generated.stdout) as {
        state: string;
        proposalFile: string;
      };
      expect(generatedBody.state).toBe("proposal-written");
      expect(generatedBody.proposalFile).toContain(".red/memory/proposals/attempt-learning-");
      expect((await projectStats(root)).nodes).toBe(beforeStats.nodes);

      const proposal = await readFile(join(root, generatedBody.proposalFile), "utf8");
      expect(proposal).toContain("# Attempt Learning Proposal");
      expect(proposal).toContain("```json memory-learning-proposal");
      expect(proposal).toContain("## Evidence");
      expect(proposal).toContain("approval-gated");

      const blocked = runMemory(["attempt", "learn", "apply", generatedBody.proposalFile, "--root", root, "--json"]);
      expect(blocked.status).not.toBe(0);
      expect((await projectStats(root)).nodes).toBe(beforeStats.nodes);

      const applied = runMemory([
        "attempt",
        "learn",
        "apply",
        generatedBody.proposalFile,
        "--root",
        root,
        "--yes",
        "--json",
      ]);
      expect(applied.status, applied.stderr).toBe(0);
      const appliedBody = JSON.parse(applied.stdout) as { state: string; applied: number };
      expect(appliedBody.state).toBe("applied");
      expect(appliedBody.applied).toBeGreaterThan(0);

      const store = await openProjectStore(root);
      const afterNodes = await store.listNodes();
      expect(afterNodes.some((n) => n.properties.source === "attempt-learning")).toBe(true);
      expect((await store.stats()).nodes).toBeGreaterThan(beforeStats.nodes);
    },
    TIMEOUT,
  );
});
