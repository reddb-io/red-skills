import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  attemptNodeLabel,
  fileNodeLabel,
  issueNodeLabel,
  parseParentPrdFromBody,
  prdNodeLabel,
  recordReasoningAttempt,
  type ReasoningAttemptPayload,
} from "../src/reasoning/attempt-writer.js";
import { defaultTier } from "../src/schema.js";

// RedDB connects by spawning the bundled `red` binary; give each test room.
const TIMEOUT = 30_000;

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

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const samplePayload: ReasoningAttemptPayload = {
  repository: "reddb-io/red-skills",
  issueNumber: 96,
  attemptNumber: 1,
  status: "done",
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
  test("attempt defaults to the reasoning tier; issue/prd default to durable", () => {
    expect(defaultTier("attempt")).toBe("reasoning");
    expect(defaultTier("issue")).toBe("durable");
    expect(defaultTier("prd")).toBe("durable");
  });
});

describe("recordReasoningAttempt", () => {
  test(
    "records an attempt node defaulting to the reasoning tier",
    async () => {
      const store = await openStore();
      const { attemptRid } = await recordReasoningAttempt(store, samplePayload);

      const node = await store.getNode(attemptRid);
      expect(node?.node_type).toBe("attempt");
      expect(node?.properties.tier).toBe("reasoning");
      expect(node?.properties.expires_at).toBeUndefined();
      expect(node?.label).toBe(
        attemptNodeLabel("reddb-io/red-skills", 96, 1, "claude"),
      );
    },
    TIMEOUT,
  );

  test(
    "keeps operational evidence inspectable as attempt properties",
    async () => {
      const store = await openStore();
      const { attemptRid } = await recordReasoningAttempt(store, samplePayload);
      const node = await store.getNode(attemptRid);
      const props = (node?.properties ?? {}) as Record<string, unknown>;

      expect(props.status).toBe("done");
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
    "creates a minimal issue node and connects it to the attempt with CONTAINS",
    async () => {
      const store = await openStore();
      const { attemptRid, issueRid, containsEdge } = await recordReasoningAttempt(
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
      const found = await store.findEdge(issueRid, attemptRid, "CONTAINS");
      expect(found).toBe(containsEdge);
    },
    TIMEOUT,
  );

  test(
    "creates minimal file nodes for touched paths and TOUCHED edges from attempt → file",
    async () => {
      const store = await openStore();
      const { attemptRid, fileRids, touchedEdges } = await recordReasoningAttempt(
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

        const edge = await store.findEdge(attemptRid, fileRids[i], "TOUCHED");
        expect(edge).toBe(touchedEdges[i]);
      }
    },
    TIMEOUT,
  );

  test(
    "is idempotent: re-recording the same attempt does not duplicate nodes or edges",
    async () => {
      const store = await openStore();
      const first = await recordReasoningAttempt(store, samplePayload);

      // Re-record with refined notes / validation summary — identity is stable
      // on AFK coordinates, not on observational evidence.
      const second = await recordReasoningAttempt(store, {
        ...samplePayload,
        notes: "refined notes after the fact",
        validationSummary: "tests pass (rerun)",
      });

      expect(second.attemptRid).toBe(first.attemptRid);
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
      const r1 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-aaa",
        touchedFiles: ["plugins/memory/src/schema.ts"],
      });
      const r2 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-bbb",
        touchedFiles: ["plugins/memory/src/schema.ts"],
      });

      expect(r1.fileRids[0]).toBe(r2.fileRids[0]);
      // Two distinct attempts on the same issue.
      expect(r1.attemptRid).not.toBe(r2.attemptRid);
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
      const r = await recordReasoningAttempt(store, {
        ...samplePayload,
        touchedFiles: [],
      });
      expect(r.fileRids).toEqual([]);
      expect(r.touchedEdges).toEqual([]);
      const attempt = await store.getNode(r.attemptRid);
      expect(attempt?.properties.touched_files).toEqual([]);
    },
    TIMEOUT,
  );

  test(
    "parses prd: #N from the issue body and creates a minimal prd node + prd CONTAINS issue",
    async () => {
      const store = await openStore();
      const r = await recordReasoningAttempt(store, {
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

      const attempt = await store.getNode(r.attemptRid);
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
      const r = await recordReasoningAttempt(store, {
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
      const r = await recordReasoningAttempt(store, {
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
      const r = await recordReasoningAttempt(store, {
        ...samplePayload,
        issueBody: undefined,
      });
      expect(r.prdRid).toBeUndefined();
      expect(r.containsEdge).toBeGreaterThan(0);
      const edge = await store.findEdge(r.issueRid, r.attemptRid, "CONTAINS");
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
      const r2 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        touchedFiles: [],
      });
      const r1 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        touchedFiles: [],
      });
      const r3 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 3,
        envelopeHash: "envh-3",
        touchedFiles: [],
      });

      // Chain after final record: 1 → 2 → 3.
      expect(r3.precedesEdges).toHaveLength(2);
      const e12 = await store.findEdge(r1.attemptRid, r2.attemptRid, "PRECEDES");
      const e23 = await store.findEdge(r2.attemptRid, r3.attemptRid, "PRECEDES");
      expect(e12).not.toBeNull();
      expect(e23).not.toBeNull();

      // No skip edges and no reverse edges.
      const e13 = await store.findEdge(r1.attemptRid, r3.attemptRid, "PRECEDES");
      const e21 = await store.findEdge(r2.attemptRid, r1.attemptRid, "PRECEDES");
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
      const a1 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        issueBody: body,
        touchedFiles: [],
      });
      const a2 = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        issueBody: body,
        touchedFiles: [],
      });

      // Re-record both, in either order, with refined notes.
      const a2b = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 2,
        envelopeHash: "envh-2",
        issueBody: body,
        touchedFiles: [],
        notes: "refined",
      });
      const a1b = await recordReasoningAttempt(store, {
        ...samplePayload,
        attemptNumber: 1,
        envelopeHash: "envh-1",
        issueBody: body,
        touchedFiles: [],
        notes: "refined",
      });

      expect(a1b.attemptRid).toBe(a1.attemptRid);
      expect(a2b.attemptRid).toBe(a2.attemptRid);
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
      const r = await recordReasoningAttempt(store, {
        ...samplePayload,
        touchedFiles: ["a.ts", "a.ts", "  ", "b.ts"],
      });
      expect(r.touchedFiles).toEqual(["a.ts", "b.ts"]);
      expect(r.fileRids).toHaveLength(2);
    },
    TIMEOUT,
  );
});
