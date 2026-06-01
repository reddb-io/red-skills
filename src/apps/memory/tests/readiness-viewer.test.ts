import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { buildReadinessViewerArtifact } from "../src/readiness-viewer.js";
import type { MemoryReadinessEnvelope } from "../src/readiness.js";

const TIMEOUT = 90_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-readiness-viewer-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("readiness viewer artifact", () => {
  test("renders a self-contained viewer from the readiness contract", () => {
    const artifact = buildReadinessViewerArtifact(sampleEnvelope());

    expect(artifact.contract).toEqual({
      name: "memory.readiness.viewer",
      version: "memory.readiness.viewer.v1",
      consumes: "memory.readiness.v1",
    });
    expect(artifact.envelope.contract.version).toBe("memory.readiness.v1");
    expect(artifact.html).toContain("<!doctype html>");
    expect(artifact.html).toContain("Task Readiness");
    expect(artifact.html).toContain("Relevant evidence");
    expect(artifact.html).toContain("Missing evidence");
    expect(artifact.html).toContain("Contradictions");
    expect(artifact.html).toContain("Supersession");
    expect(artifact.html).toContain("Next actions");
    expect(artifact.html).toContain("Read archived decision before coding.");
    expect(artifact.html).toContain('id="readiness-data"');
    expect(artifact.html).not.toContain("<script src=");
  });

  test(
    "CLI generates a local readiness viewer from graph evidence",
    async () => {
      const root = await tempRoot();
      await initGraph(root, { skillTelemetry: true });
      const store = await openStore(root);
      await seedViewerEvidence(store);
      await store.close();
      stores.pop();

      const out = join(root, "readiness-viewer.html");
      const result = runMemory([
        "readiness-viewer",
        "local",
        "readiness",
        "viewer",
        "--root",
        root,
        "--out",
        out,
        "--min-evidence",
        "3",
      ]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: readiness viewer written");
      expect(result.stdout).toContain(out);

      const html = await readFile(out, "utf8");
      expect(html).toContain("Task Readiness");
      expect(html).toContain("Relevant evidence");
      expect(html).toContain("Missing evidence");
      expect(html).toContain("Contradictions");
      expect(html).toContain("Supersession");
      expect(html).toContain("Next actions");
      expect(html).toContain("current local readiness viewer contract");
      expect(html).toContain("old local readiness viewer guidance");
      expect(html).toContain('id="readiness-data"');
    },
    TIMEOUT,
  );
});

async function seedViewerEvidence(store: MemoryStore): Promise<void> {
  const oldRid = await store.upsertNode({
    label: "old-local-readiness-viewer-guidance",
    node_type: "decision",
    properties: {
      title: "old local readiness viewer guidance",
      content: "Decision: local readiness viewer output may be handwritten prose.",
      source: "manual",
      provenance: {
        source_kind: "manual",
        writer: "test",
        command: "seed viewer",
        evidence: ["old viewer guidance"],
      },
    },
  });
  const currentRid = await store.upsertNode({
    label: "current-local-readiness-viewer-contract",
    node_type: "decision",
    properties: {
      title: "current local readiness viewer contract",
      content:
        "Decision: local readiness viewer must consume memory.readiness.v1 evidence buckets.",
      source: "manual",
      provenance: {
        source_kind: "manual",
        writer: "test",
        command: "seed viewer",
        evidence: ["viewer contract"],
      },
    },
  });
  const conflictRid = await store.upsertNode({
    label: "local-readiness-viewer-conflict",
    node_type: "problem",
    properties: {
      title: "local readiness viewer conflict",
      content: "Pitfall: duplicating Memory readiness logic conflicts with the readiness contract.",
      source: "manual",
    },
  });

  await store.supersede(oldRid, currentRid, "readiness contract replaced prose guidance");
  await store.upsertEdge({
    label: "CONTRADICTS",
    from_rid: currentRid,
    to_rid: conflictRid,
    properties: { reason: "viewer must not duplicate readiness logic" },
  });
}

function sampleEnvelope(): MemoryReadinessEnvelope {
  return {
    contract: {
      name: "memory.readiness",
      version: "memory.readiness.v1",
      consumer_targets: ["memory-ui", "references:eval:v2"],
    },
    request: {
      goal: "local readiness viewer",
      generated_at: "2030-05-24T20:00:00.000Z",
    },
    status: "review-warnings",
    governance: {
      scope: { level: "project" },
      include_superseded: true,
      min_evidence: 2,
      stale_days: 90,
      ranking_signals: ["scope", "tier", "supersession", "confidence", "freshness"],
    },
    task: {
      preflight: {
        task: "local readiness viewer",
        status: "review-warnings",
        summary: {
          evidenceCount: 3,
          activeEvidenceCount: 1,
          warningCount: 2,
          missingEvidence: true,
        },
        sections: {
          priorDecisions: [],
          constraints: [],
          pitfalls: [],
          validations: [],
          impactedConcepts: [],
        },
        evidence: [],
        warnings: [],
        markdown: "",
      },
    },
    evidence: {
      active: [
        {
          citation: "[1]",
          urn: "memory_nodes:10",
          rid: 10,
          title: "readiness contract",
          nodeType: "decision",
          confidence: "EXTRACTED",
          source: "manual",
          excerpt: "Viewer must consume readiness envelope data.",
          reason: "Matches local readiness viewer.",
          score: 0.9,
          statuses: ["active"],
        },
      ],
      missing: {
        missing: true,
        expected_minimum: 2,
        active_count: 1,
        messages: ["Only 1 active Memory evidence item(s) matched."],
      },
      contradictions: [
        {
          kind: "contradiction",
          message: "memory_nodes:10 contradicts memory_nodes:11.",
          rids: [10, 11],
        },
      ],
      superseded: [
        {
          citation: "[2]",
          urn: "memory_nodes:9",
          rid: 9,
          title: "archived decision",
          nodeType: "decision",
          confidence: "INFERRED",
          source: "manual",
          excerpt: "Old viewer shape was prose only.",
          reason: "Superseded by readiness contract.",
          score: 0.4,
          statuses: ["superseded"],
        },
      ],
      stale: [],
    },
    retrieval: {
      recall: {
        evidence_count: 3,
        active_evidence_count: 1,
        missing_evidence: true,
      },
      vector: {
        overall: "ready",
        total: 3,
        ready: 3,
        stale: 0,
        unavailable: 0,
        failed: 0,
      },
    },
    trust: {
      provenance: {
        total_nodes: 3,
        nodes_with_provenance: 2,
        missing_provenance: 1,
        source_kinds: { manual: 2 },
        evidence_refs: 2,
      },
      supersession: {
        superseded_nodes: 1,
        active_successors: 1,
      },
      contradictions: {
        total: 1,
        unresolved: 1,
        cross_session: 0,
        unresolved_pairs: [],
      },
      privacy: {
        read_only: true,
        total_memories: 3,
        findings: 0,
        warnings: 0,
        errors: 0,
      },
      claim_check: {
        assertion: "local readiness viewer",
        status: "contradicted",
        active_evidence: 1,
        superseded_evidence: 1,
        conflicts: 1,
      },
    },
    vcs: {
      time_travel: "available",
      collections: [],
    },
    operations: {
      event_log: {
        status: "available",
        total_events: 0,
        kinds: {},
        recent: [],
      },
    },
    communities: {
      status: "available",
      graph_hash: "hash",
      communities: 0,
      assignments: 0,
      top: [],
    },
    skills: {
      signal_status: "unavailable",
      task: "local readiness viewer",
      status: "insufficient-evidence",
      recommendations: [],
      missingEvidence: [],
      error: "no skill telemetry",
    },
    learning_debt: {
      status: "unavailable",
      debt_status: "unknown",
      summary: null,
      categories: null,
      error: "no learning debt",
    },
    next_actions: ["Read archived decision before coding."],
  };
}
