import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { getReadOnlyMemoryOperation } from "../src/operations.js";
import { buildCommunityDigest } from "../src/community-digest.js";
import {
  EMPTY_ENGINEERING_CODE_CURATION,
  aliasEngineeringCode,
  saveEngineeringCodeCuration,
} from "../src/code-curation.js";
import type { ProviderRequest } from "../src/extract-conversation.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];
const stores: MemoryStore[] = [];

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

async function initRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-community-digest-cli-"));
  roots.push(root);
  await initGraph(root);
  return root;
}

async function openStore(root: string): Promise<MemoryStore> {
  const store = await MemoryStore.open({
    uri: `file://${join(root, ".red/memory/graph.rdb")}`,
    project: "test",
  });
  stores.push(store);
  return store;
}

async function seedTwoCommunities(root: string): Promise<void> {
  const store = await openStore(root);
  const mk = (label: string, title: string) =>
    store.upsertNode({
      label,
      node_type: "concept",
      properties: { title, content: title },
    });
  const [a, b, c, x, y, z] = await Promise.all([
    mk("auth-login", "auth login flow"),
    mk("auth-token", "auth token rotation"),
    mk("auth-session", "auth session policy"),
    mk("cache-index", "cache index"),
    mk("cache-ttl", "cache ttl"),
    mk("cache-warmup", "cache warmup"),
  ]);
  const e = (from: number, to: number) =>
    store.upsertEdge({ label: "REFERENCES", from_rid: from, to_rid: to });
  await e(a, b);
  await e(b, c);
  await e(c, a);
  await e(x, y);
  await e(y, z);
  await e(z, x);
  await e(c, x);
  await store.close();
}

interface DigestBody {
  schema_version: string;
  read_only: boolean;
  cached: boolean;
  graph_hash: string;
  cache_key: string;
  provider: {
    status: "available" | "unavailable";
    mode: string | null;
    model: string | null;
    egress: "local" | "external" | null;
    error?: string;
  };
  community_count: number;
    digests: Array<{
    community_id: string;
    size: number;
    short_label: string | null;
    label_provenance: {
      source: "provider" | "deterministic" | "cached";
      provider: {
        mode: string | null;
        model: string | null;
      };
      membership_hash: string;
      generated_at: string;
    } | null;
    top_label: string;
    top_node_type: string;
    top_engineering_code: string | null;
    labels: Array<{ value: string; count: number }>;
    node_types: Array<{ value: string; count: number }>;
    engineering_codes: Array<{ value: string; count: number }>;
    narrative_summary: string | null;
  }>;
  summary: {
    labeling: {
      generated: number;
      reused: number;
      token_cost: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
        estimated: boolean;
      };
    };
  };
}

describe("memory community-digest CLI", () => {
  test(
    "computes a deterministic top-label digest, caches by graph hash, invalidates on change, and never mutates the graph",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);

      expect(
        getReadOnlyMemoryOperation("memory.community-digest").renderer.cli,
      ).toMatchObject({ command: "community-digest", supportsJson: true });

      const before = await openStore(root);
      const beforeStats = await before.stats();
      await before.close();

      // First run: cache miss, deterministic digest.
      const first = runMemory(["community-digest", "--root", root, "--json"]);
      expect(first.status).toBe(0);
      const firstBody = JSON.parse(first.stdout) as DigestBody;

      expect(firstBody.schema_version).toBe("memory.community-digest.v1");
      expect(firstBody.read_only).toBe(true);
      expect(firstBody.cached).toBe(false);
      expect(firstBody.graph_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(firstBody.cache_key).toMatch(
        new RegExp(`^cache:community-digest:${firstBody.graph_hash}:codes:[a-f0-9]{12}:provider:none$`),
      );
      expect(firstBody.provider).toMatchObject({
        status: "unavailable",
        mode: null,
        model: null,
        egress: null,
        error: "no AI provider configured",
      });
      expect(firstBody.community_count).toBe(2);
      expect(firstBody.digests).toHaveLength(2);
      expect(firstBody.digests.map((d) => d.size).sort()).toEqual([3, 3]);
      for (const digest of firstBody.digests) {
        // Top label is the alphabetically-first member here (each label unique → count 1).
        expect(digest.top_label).toBe(digest.labels[0]?.value);
        expect(digest.top_node_type).toBe("concept");
        expect(digest.top_engineering_code).toBeNull();
        expect(digest.labels).toHaveLength(3);
        expect(digest.node_types).toEqual([{ value: "concept", count: 3 }]);
        expect(digest.engineering_codes).toEqual([]);
        expect(digest.narrative_summary).toBeNull();
        // Label histogram is ranked count-desc then value-asc — deterministic.
        const values = digest.labels.map((l) => l.value);
        expect([...values].sort()).toEqual(values);
      }
      expect(firstBody.digests.some((d) => d.top_label === "auth-login")).toBe(true);
      expect(firstBody.digests.some((d) => d.top_label === "cache-index")).toBe(true);

      // Second run on an unchanged graph: cache hit, identical content.
      const second = runMemory(["community-digest", "--root", root, "--json"]);
      expect(second.status).toBe(0);
      const secondBody = JSON.parse(second.stdout) as DigestBody;
      expect(secondBody.cached).toBe(true);
      expect(secondBody.graph_hash).toBe(firstBody.graph_hash);
      expect(secondBody.digests).toEqual(firstBody.digests);
      expect(secondBody.provider).toEqual(firstBody.provider);

      // Changing the graph invalidates the cache and recomputes.
      const mutate = await openStore(root);
      const newNode = await mutate.upsertNode({
        label: "billing-invoice",
        node_type: "concept",
        properties: { title: "billing invoice", content: "billing invoice" },
      });
      const target = (await mutate.listNodes()).find((n) => n.label === "cache-index");
      expect(target).toBeDefined();
      await mutate.upsertEdge({ label: "REFERENCES", from_rid: newNode, to_rid: target!.rid });
      await mutate.close();

      const third = runMemory(["community-digest", "--root", root, "--json"]);
      expect(third.status).toBe(0);
      const thirdBody = JSON.parse(third.stdout) as DigestBody;
      expect(thirdBody.graph_hash).not.toBe(firstBody.graph_hash);
      expect(thirdBody.cached).toBe(false);

      // Analytics only: the digest is never written back as a node or edge.
      const after = await openStore(root);
      const afterStats = await after.stats();
      await after.close();
      expect(afterStats.nodes).toBe(beforeStats.nodes + 1); // only our explicit mutation
      expect(afterStats.edges).toBe(beforeStats.edges + 1);
    },
    TIMEOUT,
  );

  test(
    "cache modes: read-write populates, read-only hits without writing, off never caches",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);
      const fixedNow = new Date("2026-01-01T00:00:00.000Z");

      // read-write + off modes, on one store opened sequentially.
      const store = await openStore(root);
      // read-write: first call is a miss and populates the cache.
      const rw1 = await buildCommunityDigest(store, { cache: "read-write", now: fixedNow });
      expect(rw1.cached).toBe(false);
      expect(rw1.community_count).toBe(2);
      // Second read-write call is a hit and preserves the original generated_at.
      const rw2 = await buildCommunityDigest(store, {
        cache: "read-write",
        now: new Date("2026-02-02T00:00:00.000Z"),
      });
      expect(rw2.cached).toBe(true);
      expect(rw2.generated_at).toBe(rw1.generated_at);
      expect(rw2.digests).toEqual(rw1.digests);
      // off: never reads or writes the cache — always a miss, same deterministic content.
      const offRun = await buildCommunityDigest(store, { cache: "off", now: fixedNow });
      expect(offRun.cached).toBe(false);
      expect(offRun.digests).toEqual(rw1.digests);
      await store.close();

      // Move the graph to a fresh, uncached hash.
      const mutate = await openStore(root);
      await mutate.upsertNode({
        label: "ops-runbook",
        node_type: "concept",
        properties: { title: "ops runbook", content: "ops runbook" },
      });
      await mutate.close();

      // read-only against the fresh hash: a miss that must NOT populate the cache,
      // so a second read-only call is still a miss.
      const reopened = await openStore(root);
      const ro1 = await buildCommunityDigest(reopened, { cache: "read-only", now: fixedNow });
      expect(ro1.cached).toBe(false);
      const ro2 = await buildCommunityDigest(reopened, { cache: "read-only", now: fixedNow });
      expect(ro2.cached).toBe(false);
      await reopened.close();
    },
    TIMEOUT,
  );

  test(
    "provider enrichment writes one narrative per community and reuses the graph-hash cache",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);
      const calls: ProviderRequest[] = [];
      const providerClient = {
        async complete(req: ProviderRequest): Promise<string> {
          calls.push(req);
          const body = JSON.parse(req.user) as {
            communities: Array<{ community_id: string; top_label: string }>;
          };
          return JSON.stringify({
            summaries: body.communities.map((community) => ({
              community_id: community.community_id,
              summary: `Narrative for ${community.top_label}`,
            })),
          });
        },
      };

      const store = await openStore(root);
      const providerConfig = {
        mode: "openai-compat" as const,
        model: "llama3.1",
        baseUrl: "http://localhost:11434/v1",
      };
      const first = await buildCommunityDigest(store, {
        cache: "read-write",
        providerConfig,
        providerClient,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });

      expect(first.cached).toBe(false);
      expect(first.provider).toMatchObject({
        status: "available",
        mode: "openai-compat",
        model: "llama3.1",
        egress: "local",
      });
      expect(first.cache_key).toMatch(
        new RegExp(
          `^cache:community-digest:${first.graph_hash}:codes:[a-f0-9]{12}:provider:openai-compat:llama3\\.1$`,
        ),
      );
      expect(calls.filter((call) => JSON.parse(call.user).task === "community-labels")).toHaveLength(1);
      expect(calls.filter((call) => JSON.parse(call.user).task !== "community-labels")).toHaveLength(1);
      expect(first.digests).toHaveLength(2);
      expect(first.digests.every((digest) => digest.narrative_summary)).toBe(true);

      const second = await buildCommunityDigest(store, {
        cache: "read-write",
        providerConfig,
        providerClient,
        now: new Date("2026-02-02T00:00:00.000Z"),
      });
      expect(second.cached).toBe(true);
      expect(second.graph_hash).toBe(first.graph_hash);
      expect(second.generated_at).toBe(first.generated_at);
      expect(second.digests).toEqual(first.digests);
      expect(calls).toHaveLength(2);
      await store.close();
    },
    TIMEOUT,
  );

  test(
    "provider labeling persists short labels, reuses unchanged memberships, and regenerates changed communities",
    async () => {
      const root = await initRoot();
      await seedTwoCommunities(root);
      const calls: ProviderRequest[] = [];
      const providerClient = {
        async complete(req: ProviderRequest): Promise<string> {
          calls.push(req);
          const body = JSON.parse(req.user) as {
            task: string;
            communities: Array<{ community_id: string; top_label: string; members: Array<{ label: string }> }>;
          };
          if (body.task === "community-labels") {
            return JSON.stringify({
              labels: body.communities.map((community) => ({
                community_id: community.community_id,
                label: community.members.some((member) => member.label === "auth-metrics")
                  ? "Auth Metrics"
                  : community.top_label.startsWith("auth")
                    ? "Auth Flow"
                    : "Cache Ops",
              })),
            });
          }
          return JSON.stringify({
            summaries: body.communities.map((community) => ({
              community_id: community.community_id,
              summary: `Narrative for ${community.top_label}`,
            })),
          });
        },
      };
      const providerConfig = {
        mode: "openai-compat" as const,
        model: "llama3.1",
        baseUrl: "http://localhost:11434/v1",
      };
      const store = await openStore(root);
      const first = await buildCommunityDigest(store, {
        cache: "off",
        providerConfig,
        providerClient,
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      expect(first.digests.map((digest) => digest.short_label).sort()).toEqual([
        "Auth Flow",
        "Cache Ops",
      ]);
      expect(first.digests.every((digest) => digest.label_provenance?.source === "provider")).toBe(true);
      expect(first.summary.labeling).toMatchObject({
        generated: 2,
        reused: 0,
        token_cost: { estimated: true },
      });
      expect(first.summary.labeling.token_cost.total_tokens).toBeGreaterThan(0);
      expect(calls.filter((call) => JSON.parse(call.user).task === "community-labels")).toHaveLength(1);

      const second = await buildCommunityDigest(store, {
        cache: "off",
        providerConfig,
        providerClient,
        now: new Date("2026-02-02T00:00:00.000Z"),
      });
      expect(second.digests.map((digest) => digest.short_label).sort()).toEqual([
        "Auth Flow",
        "Cache Ops",
      ]);
      expect(second.summary.labeling).toMatchObject({
        generated: 0,
        reused: 2,
      });
      expect(calls.filter((call) => JSON.parse(call.user).task === "community-labels")).toHaveLength(1);

      const target = (await store.listNodes()).find((node) => node.label === "auth-login");
      expect(target).toBeDefined();
      const newRid = await store.upsertNode({
        label: "auth-metrics",
        node_type: "concept",
        properties: { title: "auth metrics", content: "auth metrics" },
      });
      await store.upsertEdge({ label: "REFERENCES", from_rid: newRid, to_rid: target!.rid });

      const third = await buildCommunityDigest(store, {
        cache: "off",
        providerConfig,
        providerClient,
        now: new Date("2026-03-03T00:00:00.000Z"),
      });
      expect(third.digests.some((digest) => digest.short_label === "Auth Metrics")).toBe(true);
      expect(third.summary.labeling.generated).toBeGreaterThanOrEqual(1);
      expect(third.summary.labeling.reused).toBeGreaterThanOrEqual(1);
      expect(calls.filter((call) => JSON.parse(call.user).task === "community-labels")).toHaveLength(2);
      await store.close();
    },
    TIMEOUT,
  );

  test(
    "groups engineering-code aliases into canonical digest histograms",
    async () => {
      const root = await initRoot();
      const store = await openStore(root);
      const a = await store.upsertNode({
        label: "auth-footgun",
        node_type: "concept",
        properties: {
          title: "auth clock skew",
          content: "auth clock skew",
          engineering_code: "footgun",
        },
      });
      const b = await store.upsertNode({
        label: "auth-gotcha",
        node_type: "concept",
        properties: {
          title: "auth session gotcha",
          content: "auth session gotcha",
          engineering_code: "gotcha",
        },
      });
      await store.upsertEdge({ label: "REFERENCES", from_rid: a, to_rid: b });
      const curation = aliasEngineeringCode(
        EMPTY_ENGINEERING_CODE_CURATION,
        "footgun",
        "gotcha",
      ).state;
      await saveEngineeringCodeCuration(store, curation);

      const report = await buildCommunityDigest(store, {
        cache: "off",
        now: new Date("2026-01-01T00:00:00.000Z"),
      });
      await store.close();

      expect(report.digests).toHaveLength(1);
      expect(report.digests[0]?.top_engineering_code).toBe("gotcha");
      expect(report.digests[0]?.engineering_codes).toEqual([{ value: "gotcha", count: 2 }]);
    },
    TIMEOUT,
  );
});
