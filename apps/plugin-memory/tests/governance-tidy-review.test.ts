import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import type { ProviderClient, ProviderRequest } from "../src/extract-conversation.js";
import { buildMemoryGovernanceReport } from "../src/governance.js";
import {
  acceptGovernanceTidyRecommendation,
  dismissGovernanceTidyRecommendation,
  refreshGovernanceTidyReviewArtifacts,
} from "../src/governance-tidy-review.js";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import {
  listProviderReviewArtifacts,
  updateProviderReviewArtifactStatus,
} from "../src/provider-review-artifacts.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

const LOCAL_PROVIDER = {
  mode: "openai-compat" as const,
  model: "llama3.1",
  baseUrl: "http://localhost:11434/v1",
};

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-governance-tidy-review-"));
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
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

function providerResponse(recommendations: unknown[]): ProviderClient {
  return {
    async complete(_req: ProviderRequest): Promise<string> {
      return JSON.stringify({ recommendations });
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
      importance: 0.9,
      provenance: {
        source_kind: "manual",
        writer: "canonical-writer",
        evidence: [`transcript:${suffix}:canonical`],
      },
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
      importance: 0.1,
      provenance: {
        source_kind: "manual",
        writer: "duplicate-writer",
        evidence: [`transcript:${suffix}:duplicate`],
      },
    },
  });
  return { canonical, duplicate };
}

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

describe("governance tidy review workflow", () => {
  test("accepts an open recommendation by id through the CLI and preserves both nodes", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const { canonical, duplicate } = await seedDuplicateNodePair(store, "accept");
    const refresh = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
      now: 1000,
    });
    const artifactId = refresh.artifacts[0]!.artifact_id;
    const beforeNodes = await store.listNodes();
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const blocked = runMemory([
      "tidy-review",
      "accept",
      artifactId,
      "--root",
      root,
      "--approver",
      "agent:test",
      "--json",
    ]);
    expect(blocked.status).not.toBe(0);
    expect(blocked.stderr).toContain("requires explicit --yes approval");

    const accepted = runMemory([
      "tidy-review",
      "accept",
      artifactId,
      "--root",
      root,
      "--approver",
      "agent:test",
      "--reason",
      "reviewed duplicate policy",
      "--yes",
      "--json",
    ]);
    expect(accepted.status, accepted.stderr).toBe(0);
    const body = JSON.parse(accepted.stdout) as {
      action: string;
      edge: { label: string; from_rid: number; to_rid: number };
    };
    expect(body).toMatchObject({
      action: "accept",
      edge: {
        label: "SAME_AS",
        from_rid: duplicate,
        to_rid: canonical,
      },
    });

    const after = await openStore(root);
    await expect(after.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeGreaterThan(0);
    expect(await after.listNodes()).toHaveLength(beforeNodes.length);
    await expect(after.getNode(duplicate)).resolves.toMatchObject({
      properties: {
        provenance: {
          writer: "duplicate-writer",
          evidence: ["transcript:accept:duplicate"],
        },
      },
    });
    await expect(after.getNode(canonical)).resolves.toMatchObject({
      properties: {
        provenance: {
          writer: "canonical-writer",
          evidence: ["transcript:accept:canonical"],
        },
      },
    });
    const artifacts = await listProviderReviewArtifacts(after);
    expect(artifacts[0]).toMatchObject({
      status: "accepted",
      accepted_at: expect.any(Number),
      review: {
        action: "accepted",
        approver: "agent:test",
        reason: "reviewed duplicate policy",
        source: "memory tidy-review accept",
      },
    });

    const governance = await buildMemoryGovernanceReport(after, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
    });
    expect(governance.tidy_recommendations.recommendations[0]).toMatchObject({
      artifact_id: artifactId,
      review_status: "accepted",
    });
  }, TIMEOUT);

  test("dismisses an open recommendation without creating graph evidence", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const { canonical, duplicate } = await seedDuplicateNodePair(store, "dismiss");
    const refresh = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
      now: 1000,
    });

    const dismissed = await dismissGovernanceTidyRecommendation(store, {
      id: refresh.artifacts[0]!.recommendation_id,
      approver: "agent:test",
      reason: "not the same operational policy",
      now: 2000,
    });

    expect(dismissed.action).toBe("dismiss");
    await expect(store.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeNull();
    const artifacts = await listProviderReviewArtifacts(store);
    expect(artifacts[0]).toMatchObject({
      status: "dismissed",
      dismissed_at: 2000,
      review: {
        action: "dismissed",
        approver: "agent:test",
        reason: "not the same operational policy",
      },
    });

    const governance = await buildMemoryGovernanceReport(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
    });
    expect(governance.tidy_recommendations.recommendations[0]).toMatchObject({
      artifact_id: refresh.artifacts[0]!.artifact_id,
      review_status: "dismissed",
    });
  }, TIMEOUT);

  test("rejects stale recommendations without creating an edge", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const { canonical, duplicate } = await seedDuplicateNodePair(store, "stale");
    const refresh = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
      now: 1000,
    });
    await updateProviderReviewArtifactStatus(store, refresh.artifacts[0]!.artifact_id, "stale", {
      now: 2000,
    });

    await expect(
      acceptGovernanceTidyRecommendation(store, {
        id: refresh.artifacts[0]!.artifact_id,
        approver: "agent:test",
        now: 3000,
      }),
    ).rejects.toThrow(/stale/);
    await expect(store.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeNull();
  }, TIMEOUT);

  test("governance remains read-only even when passed tidy-review-looking arguments", async () => {
    const root = await tempRoot();
    await initGraph(root, { hooks: true });
    const store = await openStore(root);
    const { canonical, duplicate } = await seedDuplicateNodePair(store, "read-only");
    const refresh = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: LOCAL_PROVIDER,
      providerClient: providerResponse([recFor("merge-pass:1")]),
      now: 1000,
    });
    await store.close();
    stores.splice(stores.indexOf(store), 1);

    const result = runMemory([
      "governance",
      "accept",
      refresh.artifacts[0]!.artifact_id,
      "--root",
      root,
      "--approver",
      "agent:test",
      "--yes",
      "--json",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const body = JSON.parse(result.stdout) as { read_only: boolean };
    expect(body.read_only).toBe(true);

    const after = await openStore(root);
    await expect(after.findEdge(duplicate, canonical, "SAME_AS")).resolves.toBeNull();
    expect((await listProviderReviewArtifacts(after))[0]).toMatchObject({ status: "open" });
  }, TIMEOUT);
});
