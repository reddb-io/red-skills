import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import {
  DEFAULT_TIDY_REVIEW_POLICY_VERSION,
  computeProviderReviewFingerprint,
  listProviderReviewArtifacts,
  persistProviderReviewArtifacts,
  providerReviewRecommendationId,
  readProviderReviewArtifactState,
  updateProviderReviewArtifactStatus,
  type ProviderReviewRecommendationInput,
} from "../src/provider-review-artifacts.js";

const TIMEOUT = 30_000;
const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-provider-review-"));
  roots.push(dir);
  return dir;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, "graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function tidyRecommendation(content = "Deploys moved to Tuesday."): ProviderReviewRecommendationInput {
  return {
    operation: "governance.tidy",
    policyVersion: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
    recommendationKey: "resolve-deploy-schedule",
    pairEvidence: [
      {
        pair_id: "deploy-schedule",
        relation: "contradiction",
        subjects: [
          {
            collection: "memory_nodes",
            rid: 7,
            label: "deploys-on-friday",
            node_type: "decision",
            title: "Deploys happen on Friday",
            content: "Deploys happen on Friday.",
            hash: "friday-hash",
          },
          {
            collection: "memory_nodes",
            rid: 3,
            label: "deploys-on-tuesday",
            node_type: "decision",
            title: "Deploys happen on Tuesday",
            content,
            hash: "tuesday-hash",
          },
        ],
        evidence: [
          { kind: "edge", label: "CONTRADICTS", from: 3, to: 7, reason: "schedule changed" },
          { kind: "lint", rule: "conflicting-guidance", severity: "warning" },
        ],
      },
    ],
    recommendation: {
      title: "Review conflicting deploy schedule guidance",
      rationale: "The two Memory facts disagree about deploy day.",
      suggested_action: "Ask a maintainer which deploy day is current.",
      provider_output: { confidence: "medium", notes: ["pair needs human review"] },
    },
    provider: { mode: "openai-compat", model: "llama3.1" },
  };
}

describe("provider review fingerprints", () => {
  test("are deterministic and order-insensitive for equivalent tidy evidence", () => {
    const base = tidyRecommendation();
    const reordered: ProviderReviewRecommendationInput = {
      ...base,
      pairEvidence: [
        {
          relation: "contradiction",
          pair_id: "different-noncanonical-id",
          subjects: [...base.pairEvidence[0].subjects].reverse(),
          evidence: [
            { severity: "warning", rule: "conflicting-guidance", kind: "lint" },
            { to: 7, reason: "schedule changed", from: 3, label: "CONTRADICTS", kind: "edge" },
          ],
        },
      ],
    };

    const first = computeProviderReviewFingerprint(base);
    const second = computeProviderReviewFingerprint(reordered);

    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first).toMatchObject({
      algorithm: "sha256:provider-review.v1",
      operation: "governance.tidy",
      policy_version: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
      pair_count: 1,
      evidence_count: 2,
    });
  });

  test("change when relevant evidence or review policy version changes", () => {
    const base = tidyRecommendation();
    const changedEvidence = tidyRecommendation("Deploys moved to Wednesday.");
    const changedPolicy = {
      ...base,
      policyVersion: "memory.governance-tidy.review.v2",
    };

    expect(computeProviderReviewFingerprint(base).fingerprint).not.toBe(
      computeProviderReviewFingerprint(changedEvidence).fingerprint,
    );
    expect(computeProviderReviewFingerprint(base).fingerprint).not.toBe(
      computeProviderReviewFingerprint(changedPolicy).fingerprint,
    );
  });
});

describe("provider review artifact persistence", () => {
  test(
    "stores stable recommendation ids, pair evidence, status, timestamps, and fingerprint metadata",
    async () => {
      const store = await openStore(await tempRoot());
      const input = tidyRecommendation();

      const result = await persistProviderReviewArtifacts(store, [input], { now: 1000 });
      const artifacts = await listProviderReviewArtifacts(store);

      expect(result.stale).toEqual([]);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]).toMatchObject({
        schema_version: "memory.provider_review_artifact.v1",
        artifact_id: expect.stringContaining(providerReviewRecommendationId(input)),
        recommendation_id: providerReviewRecommendationId(input),
        recommendation_key: "resolve-deploy-schedule",
        operation: "governance.tidy",
        status: "open",
        created_at: 1000,
        updated_at: 1000,
        status_changed_at: 1000,
        pair_evidence: input.pairEvidence,
        recommendation: input.recommendation,
        provider: input.provider,
        fingerprint_metadata: {
          algorithm: "sha256:provider-review.v1",
          operation: "governance.tidy",
          policy_version: DEFAULT_TIDY_REVIEW_POLICY_VERSION,
          pair_count: 1,
          evidence_count: 2,
        },
      });
    },
    TIMEOUT,
  );

  test(
    "marks open recommendations stale when the current fingerprint no longer matches",
    async () => {
      const store = await openStore(await tempRoot());
      const original = tidyRecommendation();
      const changed = tidyRecommendation("Deploys moved to Wednesday.");

      const first = await persistProviderReviewArtifacts(store, [original], { now: 1000 });
      const second = await persistProviderReviewArtifacts(store, [changed], { now: 2000 });
      const artifacts = await listProviderReviewArtifacts(store, { operation: "governance.tidy" });

      expect(providerReviewRecommendationId(changed)).toBe(providerReviewRecommendationId(original));
      expect(second.stale).toHaveLength(1);
      expect(second.stale[0]).toMatchObject({
        artifact_id: first.artifacts[0].artifact_id,
        status: "stale",
        stale_at: 2000,
      });
      expect(artifacts).toHaveLength(2);
      expect(artifacts.map((artifact) => artifact.status).sort()).toEqual(["open", "stale"]);
      expect(artifacts.find((artifact) => artifact.status === "open")?.fingerprint).toBe(
        second.artifacts[0].fingerprint,
      );
    },
    TIMEOUT,
  );

  test(
    "persists dismissed and accepted statuses without graph supersession vocabulary",
    async () => {
      const store = await openStore(await tempRoot());
      const input = tidyRecommendation();
      const persisted = await persistProviderReviewArtifacts(store, [input], { now: 1000 });

      const dismissed = await updateProviderReviewArtifactStatus(
        store,
        persisted.artifacts[0].artifact_id,
        "dismissed",
        { now: 1500 },
      );
      await persistProviderReviewArtifacts(store, [input], { now: 2000 });
      const afterRepersist = await listProviderReviewArtifacts(store);
      const accepted = await updateProviderReviewArtifactStatus(
        store,
        persisted.artifacts[0].artifact_id,
        "accepted",
        { now: 2500 },
      );

      expect(dismissed).toMatchObject({
        status: "dismissed",
        dismissed_at: 1500,
      });
      expect(afterRepersist[0]).toMatchObject({
        status: "dismissed",
        dismissed_at: 1500,
      });
      expect(accepted).toMatchObject({
        status: "accepted",
        accepted_at: 2500,
      });
      expect(["open", "dismissed", "accepted", "stale"]).toContain(accepted.status);
      expect(JSON.stringify(await readProviderReviewArtifactState(store))).not.toMatch(
        /SUPERSEDED_BY|SAME_AS|MERGED_INTO|DEPRECATED_BY/,
      );
    },
    TIMEOUT,
  );

  test(
    "persists artifacts outside the canonical graph and recall evidence",
    async () => {
      const store = await openStore(await tempRoot());
      const beforeStats = await store.stats();
      const beforeNodes = await store.listNodes();
      const beforeEdges = await store.listEdges();
      const beforeDocs = await store.listDocs();
      const beforeAccess = await store.accessRecords();

      await persistProviderReviewArtifacts(store, [tidyRecommendation()], { now: 1000 });

      expect(await store.stats()).toEqual(beforeStats);
      expect(await store.listNodes()).toEqual(beforeNodes);
      expect(await store.listEdges()).toEqual(beforeEdges);
      expect(await store.listDocs()).toEqual(beforeDocs);
      expect(await store.accessRecords()).toEqual(beforeAccess);
      expect(await listProviderReviewArtifacts(store)).toHaveLength(1);
    },
    TIMEOUT,
  );
});
