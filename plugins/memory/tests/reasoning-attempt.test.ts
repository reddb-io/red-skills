import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  attemptNodeLabel,
  fileNodeLabel,
  issueNodeLabel,
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
