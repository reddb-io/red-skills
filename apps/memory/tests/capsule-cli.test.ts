import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-capsule-cli-"));
  roots.push(root);
  return root;
}

async function seedCapsuleStore(root: string): Promise<void> {
  await initGraph(root);
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  try {
    await store.upsertNode({
      label: "jwt-docs-decision",
      node_type: "decision",
      properties: {
        title: "JWT docs decision",
        content: "Decision: JWT token changes must update docs/security.md.",
        source: "manual",
        confidence: "EXTRACTED",
        importance: 0.9,
        created_at: 1_700_000_000_000,
      },
    });
    await store.upsertNode({
      label: "jwt-cache-risk",
      node_type: "problem",
      properties: {
        title: "JWT cache risk",
        content: "Risk: cache TTL can outlive rotated JWT signing material.",
        source: "manual",
        confidence: "INFERRED",
        importance: 0.7,
        created_at: 1_700_000_100_000,
      },
    });
  } finally {
    await store.close();
  }
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("memory capsule CLI", () => {
  test(
    "packages a context-pack capsule with preserved citations and no capsule storage",
    async () => {
      const root = await tempRoot();
      await seedCapsuleStore(root);

      const result = runMemory([
        "capsule",
        "jwt token work",
        "--root",
        root,
        "--budget",
        "1600",
        "--source",
        "context-pack",
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const capsule = JSON.parse(result.stdout) as {
        schema_version: string;
        read_only: boolean;
        source: { kind: string; schema_version: string; status: string };
        budget_chars: number;
        used_chars: number;
        markdown: string;
        citations: Array<{ marker: string | null; urn: string; source: string | null }>;
      };

      expect(capsule).toMatchObject({
        schema_version: "memory.capsule.v1",
        read_only: true,
        source: {
          kind: "context-pack",
          schema_version: "memory.context_pack.v1",
          status: "ok",
        },
      });
      expect(capsule.used_chars).toBeLessThanOrEqual(capsule.budget_chars);
      expect(capsule.markdown).toContain("Ready-to-inject context");
      expect(capsule.markdown).toContain("## Packaged evidence");
      expect(capsule.citations[0]).toMatchObject({
        marker: "[M1]",
        urn: expect.stringMatching(/^memory_nodes:/),
        source: "manual",
      });
      expect(capsule.markdown).toContain("urn: memory_nodes:");

      const memoryFiles = await readdir(join(root, ".red/memory"));
      expect(memoryFiles.some((name) => name.includes("capsule"))).toBe(false);
    },
    TIMEOUT,
  );

  test(
    "packages a handoff capsule over the read-only handoff report",
    async () => {
      const root = await tempRoot();
      await seedCapsuleStore(root);

      const result = runMemory([
        "capsule",
        "jwt",
        "--root",
        root,
        "--source",
        "handoff",
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const capsule = JSON.parse(result.stdout) as {
        source: { kind: string; schema_version: string; status: string };
        source_read_only: boolean;
        citations: Array<{ marker: string | null; urn: string; rid: number }>;
        markdown: string;
      };

      expect(capsule.source).toMatchObject({
        kind: "handoff",
        schema_version: "memory.handoff.v1",
        status: "ready",
      });
      expect(capsule.source_read_only).toBe(true);
      expect(capsule.citations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ marker: null, urn: expect.stringMatching(/^decision:jwt-docs-decision#/) }),
        ]),
      );
      expect(capsule.markdown).toContain("# Memory capsule: jwt");
      expect(capsule.markdown).toContain("Memory handoff");
    },
    TIMEOUT,
  );
});
