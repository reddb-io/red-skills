import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { buildMemoryGovernanceReport } from "../src/governance.js";
import { buildMemoryGovernanceViewerArtifact } from "../src/governance-viewer.js";
import type { ProviderClient, ProviderRequest } from "../src/extract-conversation.js";
import { readConfig, writeConfig } from "../src/config.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { listProviderReviewArtifacts } from "../src/provider-review-artifacts.js";

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

const LOCAL_PROVIDER = {
  mode: "openai-compat" as const,
  model: "llama3.1",
  baseUrl: "http://localhost:11434/v1",
};

function providerResponse(recommendations: unknown[]): ProviderClient {
  return {
    async complete(_req: ProviderRequest): Promise<string> {
      return JSON.stringify({ recommendations });
    },
  };
}

function failingProvider(message: string): ProviderClient {
  return {
    async complete(): Promise<string> {
      throw new Error(message);
    },
  };
}

async function seedDuplicateNodePair(
  store: MemoryStore,
  suffix: string,
): Promise<{ canonical: number; duplicate: number }> {
  const canonical = await store.upsertNode({
    label: `jwt-rotation-${suffix}`,
    node_type: "decision",
    properties: {
      title: `JWT rotation ${suffix}`,
      content: "JWT rotation must rotate signing keys with a staged overlap window.",
      scope: "project",
      tier: "durable",
      provenance: { source_kind: "manual", writer: "test", confidence: "EXTRACTED" },
    },
  });
  const duplicate = await store.upsertNode({
    label: `jwt-key-rotation-${suffix}`,
    node_type: "decision",
    properties: {
      title: `JWT rotation ${suffix}`,
      content: "JWT rotation must rotate signing keys with a staged overlap window.",
      scope: "project",
      tier: "durable",
      provenance: { source_kind: "manual", writer: "test", confidence: "EXTRACTED" },
    },
  });
  return { canonical, duplicate };
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
    expect(report.tidy_availability).toMatchObject({
      status: "unavailable",
      configured: false,
      reason: "no AI provider configured for governance tidy",
      next_action: expect.stringContaining("deterministic governance remains available"),
    });
    expect(report.recommended_next_actions).toEqual(
      expect.arrayContaining([
        expect.stringContaining("memory privacy scan"),
        expect.stringContaining("memory lint"),
        expect.stringContaining("deterministic governance remains available"),
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
    expect(artifact.html).toContain("Tidy availability");
    expect(artifact.html).toContain("no AI provider configured for governance tidy");
  });

  test("CLI JSON reports provider-unavailable tidy status without dropping deterministic evidence", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await store.upsertNode({
      label: "provider-unavailable-governance",
      node_type: "decision",
      properties: {
        title: "Provider unavailable governance",
        content: "Governance must remain deterministic.",
        scope: "project",
        tier: "durable",
        provenance: { source_kind: "manual", writer: "test", confidence: "EXTRACTED" },
      },
    });
    await store.close();
    const config = await readConfig(root);
    if (!config) throw new Error("missing test config");
    await writeConfig(root, {
      ...config,
      provider: {
        mode: "openai-compat",
        model: "llama3.1",
      },
    });

    const result = runMemory(["governance", "--root", root, "--json"]);

    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout) as {
      read_only: boolean;
      summary: { total_nodes: number; nodes_with_provenance: number };
      tidy_availability: { status: string; reason: string; next_action: string };
    };
    expect(report.read_only).toBe(true);
    expect(report.summary).toMatchObject({
      total_nodes: 1,
      nodes_with_provenance: 1,
    });
    expect(report.tidy_availability).toMatchObject({
      status: "degraded",
      reason: "openai-compat provider requires a baseUrl",
      next_action: "fix the configured Memory AI provider before running governance tidy",
    });
  }, TIMEOUT);

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
    expect(html).toContain("Tidy availability");
  }, TIMEOUT);

  test("surfaces provider-backed duplicate tidy recommendations as read-only Soft-merge review output", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "provider-success");

    const report = await buildMemoryGovernanceReport(store, {
      now: Date.UTC(2026, 4, 22),
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([
        {
          candidate_id: "merge-pass:1",
          relation: "near_duplicate",
          confidence: 0.91,
          rationale: "Both facts express the same JWT key rotation policy.",
          proposed_action: "SOFT_MERGE",
          proposed_edge_label: "SAME_AS",
        },
      ]),
    });

    expect(report.tidy_availability).toMatchObject({
      status: "available",
      configured: true,
      provider_mode: "openai-compat",
      provider_model: "llama3.1",
      egress: "local",
    });
    expect(report.tidy_recommendations).toMatchObject({
      schema_version: "memory.governance_tidy_recommendations.v1",
      read_only: true,
      source: "provider-review-artifacts",
      status: "available",
      summary: {
        candidate_pairs: 1,
        recommended_pairs: 1,
        dropped_recommendations: 0,
      },
    });
    expect(report.tidy_recommendations.recommendations[0]).toMatchObject({
      id: expect.stringContaining("provider-review:"),
      artifact_id: expect.stringContaining("provider-review:"),
      recommendation_id: expect.stringContaining("provider-review:"),
      operation: "governance.tidy",
      review_status: "open",
      relation: "near_duplicate",
      confidence: 0.91,
      rationale: "Both facts express the same JWT key rotation policy.",
      proposed_soft_merge: {
        action: "SOFT_MERGE",
        edge_label: "SAME_AS",
        duplicate_rid: expect.any(Number),
        canonical_rid: expect.any(Number),
      },
      pair_evidence: [
        expect.objectContaining({
          relation: "near_duplicate",
          subjects: expect.arrayContaining([
            expect.objectContaining({ collection: "memory_nodes", rid: expect.any(Number) }),
            expect.objectContaining({ collection: "memory_nodes", rid: expect.any(Number) }),
          ]),
        }),
      ],
      provider: { mode: "openai-compat", model: "llama3.1" },
    });

    const artifact = buildMemoryGovernanceViewerArtifact(report);
    expect(artifact.html).toContain("Provider Tidy Recommendations");
    expect(artifact.html).toContain("SAME_AS memory_nodes");
  });

  test("bounds provider tidy recommendations by the absolute cap", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "cap-a");
    await seedDuplicateNodePair(store, "cap-b");
    await seedDuplicateNodePair(store, "cap-c");

    const report = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([
        recFor("merge-pass:1"),
        recFor("merge-pass:2"),
        recFor("merge-pass:3"),
        recFor("merge-pass:4"),
      ]),
      tidyRecommendationCap: 2,
      tidyMaxRecommendationRatio: 1,
    });

    expect(report.tidy_availability.status).toBe("degraded");
    expect(report.tidy_recommendations.status).toBe("degraded");
    expect(report.tidy_recommendations.recommendations).toHaveLength(2);
    expect(report.tidy_recommendations.summary.dropped_recommendations).toBe(2);
    expect(report.tidy_recommendations.warnings.join(" ")).toContain("exceeding guard 2");
  });

  test("uses a proportional guard against recommending too much of the candidate set", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "ratio-a");
    await seedDuplicateNodePair(store, "ratio-b");

    const report = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([
        recFor("merge-pass:1"),
        recFor("merge-pass:2"),
        recFor("merge-pass:3"),
      ]),
      tidyRecommendationCap: 10,
      tidyMaxRecommendationRatio: 0.25,
    });

    expect(report.tidy_recommendations.summary.candidate_pairs).toBeGreaterThanOrEqual(3);
    expect(report.tidy_recommendations.recommendations).toHaveLength(1);
    expect(report.tidy_recommendations.status).toBe("degraded");
    expect(report.tidy_recommendations.warnings.join(" ")).toContain("exceeding guard 1");
  });

  test("malformed provider tidy output degrades tidy without failing deterministic governance", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "malformed");

    const report = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: {
        async complete(): Promise<string> {
          return "not json";
        },
      },
    });

    expect(report.schema_version).toBe("memory.governance.v1");
    expect(report.summary.total_nodes).toBe(2);
    expect(report.tidy_availability.status).toBe("degraded");
    expect(report.tidy_recommendations).toMatchObject({
      status: "degraded",
      reason: "provider tidy returned malformed JSON",
      recommendations: [],
    });
  });

  test("provider tidy failures degrade tidy without failing deterministic governance", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "failure");

    const report = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: failingProvider("provider unavailable"),
    });

    expect(report.schema_version).toBe("memory.governance.v1");
    expect(report.summary.total_nodes).toBe(2);
    expect(report.tidy_availability).toMatchObject({
      status: "degraded",
      reason: "provider tidy failed: provider unavailable",
    });
    expect(report.tidy_recommendations.recommendations).toEqual([]);
  });

  test("provider tidy drops non-duplicate and non-Soft-merge responses", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "unsupported");

    const report = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([
        {
          candidate_id: "merge-pass:1",
          relation: "supersession",
          confidence: 0.95,
          rationale: "Old guidance should be superseded.",
          proposed_action: "SUPERSEDE",
        },
      ]),
    });

    expect(report.tidy_recommendations.recommendations).toEqual([]);
    expect(report.tidy_recommendations.status).toBe("degraded");
    expect(report.tidy_recommendations.summary.dropped_recommendations).toBe(1);
    expect(report.tidy_recommendations.warnings.join(" ")).toContain(
      "non-duplicate recommendation",
    );
  });

  test("provider tidy recommendations do not mutate graph evidence or review artifacts", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    await seedDuplicateNodePair(store, "nonmutation");
    const beforeStats = await store.stats();
    const beforeNodes = await store.listNodes();
    const beforeEdges = await store.listEdges();
    const beforeDocs = await store.listDocs();
    const beforeAccess = await store.accessRecords();

    await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
    });

    expect(await store.stats()).toEqual(beforeStats);
    expect(await store.listNodes()).toEqual(beforeNodes);
    expect(await store.listEdges()).toEqual(beforeEdges);
    expect(await store.listDocs()).toEqual(beforeDocs);
    expect(await store.accessRecords()).toEqual(beforeAccess);
    expect(await listProviderReviewArtifacts(store)).toEqual([]);
  });
});

function recFor(candidateId: string): Record<string, unknown> {
  return {
    candidate_id: candidateId,
    relation: "duplicate",
    confidence: 0.9,
    rationale: `Candidate ${candidateId} is semantically identical.`,
    proposed_action: "SOFT_MERGE",
    proposed_edge_label: "SAME_AS",
  };
}
