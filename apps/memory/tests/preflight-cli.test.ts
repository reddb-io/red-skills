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

async function seedRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-preflight-cli-"));
  roots.push(root);
  const { storeUri } = await initGraph(root);
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);
  await store.upsertNode({
    label: "preflight-json-decision",
    node_type: "decision",
    properties: {
      title: "preflight JSON decision",
      content: "Decision: preflight JSON output must be stable for AFK runners.",
      source: "manual",
    },
  });
  await store.upsertNode({
    label: "preflight-validation",
    node_type: "validation",
    properties: {
      title: "preflight validation",
      content: "Validation: run pnpm test for memory preflight changes.",
      source: "manual",
    },
  });
  await store.close();
  stores.pop();
  return root;
}

describe("memory preflight CLI", () => {
  test(
    "prints stable JSON for a free-form task",
    async () => {
      const root = await seedRoot();

      const result = runMemory([
        "preflight",
        "build",
        "memory",
        "preflight",
        "json",
        "--root",
        root,
        "--json",
      ]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        task: string;
        status: string;
        summary: { evidenceCount: number; missingEvidence: boolean };
        sections: { priorDecisions: Array<{ urn: string }>; validations: Array<{ urn: string }> };
        evidence: Array<{ citation: string; urn: string; statuses: string[] }>;
        warnings: unknown[];
        markdown: string;
      };

      expect(body.task).toBe("build memory preflight json");
      expect(body.status).toBe("ready");
      expect(body.summary.evidenceCount).toBe(2);
      expect(body.summary.missingEvidence).toBe(false);
      expect(body.sections.priorDecisions[0].urn).toMatch(/^memory_nodes:\d+$/);
      expect(body.sections.validations[0].urn).toMatch(/^memory_nodes:\d+$/);
      expect(body.evidence.map((item) => item.statuses)).toEqual([["active"], ["active"]]);
      expect(body.warnings).toEqual([]);
      expect(body.markdown).toContain("[M1]");
    },
    TIMEOUT,
  );

  test(
    "prints a human cited brief by default",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["preflight", "build memory preflight json", "--root", root]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("# Memory preflight: build memory preflight json");
      expect(result.stdout).toContain("Status: ready");
      expect(result.stdout).toContain("urn: memory_nodes:");
      expect(result.stdout).toContain("Evidence:");
    },
    TIMEOUT,
  );
});
