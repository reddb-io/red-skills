import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");

const roots: string[] = [];
const stores: MemoryStore[] = [];

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-claim-check-cli-"));
  roots.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close().catch(() => {})));
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

async function openSeedStore(root: string): Promise<MemoryStore> {
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  return store;
}

describe("memory claim-check CLI", () => {
  test(
    "returns supported status with active citations",
    async () => {
      const root = await tempRoot();
      const store = await openSeedStore(root);
      const rid = await store.upsertNode({
        label: "jwt-rotation",
        node_type: "decision",
        properties: {
          title: "jwt rotation",
          content: "JWT tokens rotate every 90 days in staging.",
          confidence: "EXTRACTED",
          source: "manual",
        },
      });
      await store.close();
      stores.pop();

      const result = runMemory([
        "claim-check",
        "JWT tokens rotate every 90 days in staging.",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        citations: Array<{ marker: number; urn: string }>;
        evidence: { active: Array<{ rid: number; status: string; confidence: string }> };
      };
      expect(body.status).toBe("supported");
      expect(body.citations).toEqual([{ marker: 1, urn: `memory_nodes:${rid}` }]);
      expect(body.evidence.active[0]).toMatchObject({
        rid,
        status: "active",
        confidence: "EXTRACTED",
      });
    },
    TIMEOUT,
  );

  test(
    "returns contradicted status and conflicting evidence",
    async () => {
      const root = await tempRoot();
      const store = await openSeedStore(root);
      const fridayRid = await store.upsertNode({
        label: "deploy-friday",
        node_type: "decision",
        properties: {
          title: "deploy friday",
          content: "Deploys happen on Friday.",
          confidence: "EXTRACTED",
          source: "policy.md",
        },
      });
      const tuesdayRid = await store.upsertNode({
        label: "deploy-tuesday",
        node_type: "decision",
        properties: {
          title: "deploy tuesday",
          content: "Deploys happen on Tuesday.",
          confidence: "EXTRACTED",
          source: "ops.md",
        },
      });
      await store.upsertEdge({
        label: "CONTRADICTS",
        from_rid: fridayRid,
        to_rid: tuesdayRid,
        properties: { reason: "deployment window changed" },
      });
      await store.close();
      stores.pop();

      const result = runMemory([
        "claim-check",
        "Deploys happen on Friday.",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        citations: Array<{ urn: string }>;
        evidence: {
          active: Array<{ rid: number }>;
          conflicting: Array<{ reason: string; from: { rid: number }; to: { rid: number } }>;
        };
      };
      expect(body.status).toBe("contradicted");
      expect(body.citations).toContainEqual(
        expect.objectContaining({ urn: `memory_nodes:${fridayRid}` }),
      );
      expect(body.evidence.active.map((item) => item.rid)).toEqual(
        expect.arrayContaining([fridayRid, tuesdayRid]),
      );
      expect(body.evidence.conflicting[0]).toMatchObject({
        reason: "deployment window changed",
        from: { rid: fridayRid },
        to: { rid: tuesdayRid },
      });
    },
    TIMEOUT,
  );

  test(
    "reports when an assertion is supported only by superseded evidence",
    async () => {
      const root = await tempRoot();
      const store = await openSeedStore(root);
      const oldRid = await store.upsertNode({
        label: "deploy-fridays",
        node_type: "decision",
        properties: {
          title: "deploy fridays",
          content: "Deploys happen on Fridays.",
          confidence: "EXTRACTED",
          source: "old-policy.md",
        },
      });
      const currentRid = await store.upsertNode({
        label: "deploy-tuesdays",
        node_type: "decision",
        properties: {
          title: "deploy tuesdays",
          content: "Ship windows moved to Tuesdays.",
          confidence: "EXTRACTED",
          source: "current-policy.md",
        },
      });
      await store.supersede(oldRid, currentRid, "policy changed");
      await store.close();
      stores.pop();

      const result = runMemory([
        "claim-check",
        "Deploys happen on Fridays.",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        citations: Array<{ urn: string }>;
        evidence: {
          active: Array<{ rid: number }>;
          superseded: Array<{ rid: number; activeRid: number }>;
        };
      };
      expect(body.status).toBe("superseded-evidence");
      expect(body.citations).toContainEqual(
        expect.objectContaining({ urn: `memory_nodes:${oldRid}` }),
      );
      expect(body.evidence.superseded[0]).toMatchObject({
        rid: oldRid,
        activeRid: currentRid,
      });
      expect(body.evidence.active.map((item) => item.rid)).not.toContain(currentRid);
    },
    TIMEOUT,
  );

  test(
    "returns insufficient evidence for unsupported assertions",
    async () => {
      const root = await tempRoot();
      const store = await openSeedStore(root);
      await store.upsertNode({
        label: "jwt-rotation",
        node_type: "decision",
        properties: {
          title: "jwt rotation",
          content: "JWT tokens rotate every 90 days in staging.",
          confidence: "EXTRACTED",
          source: "manual",
        },
      });
      await store.close();
      stores.pop();

      const result = runMemory([
        "claim-check",
        "The database password is hunter2.",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        answer: string;
        citations: unknown[];
        evidence: { active: unknown[]; superseded: unknown[]; conflicting: unknown[] };
      };
      expect(body.status).toBe("insufficient-evidence");
      expect(body.answer).toContain("Insufficient evidence");
      expect(body.citations).toEqual([]);
      expect(body.evidence.active).toEqual([]);
      expect(body.evidence.superseded).toEqual([]);
      expect(body.evidence.conflicting).toEqual([]);
    },
    TIMEOUT,
  );
});
