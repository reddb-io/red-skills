import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { bootstrapProjectMemory } from "../src/project-bootstrap.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-project-bootstrap-"));
  roots.push(root);
  return root;
}

async function seedProjectDocs(root: string): Promise<void> {
  await mkdir(join(root, "docs"), { recursive: true });
  await mkdir(join(root, ".red", "adr"), { recursive: true });
  await writeFile(
    join(root, "README.md"),
    "# Widget API\n\nThe widget API owns `WIDGET_TOKEN` rotation.\n",
    "utf8",
  );
  await writeFile(
    join(root, "docs", "runbook.md"),
    "# Runbook\n\nDeploys check [[Widget API]] before release.\n",
    "utf8",
  );
  await writeFile(
    join(root, ".red", "adr", "0001-widget-api.md"),
    "# Widget API ADR\n\nDecision: WIDGET_TOKEN rotates every 30 days.\n",
    "utf8",
  );
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("project bootstrap", () => {
  test("dry-run discovers context sources without mutating RedDB docs", async () => {
    const root = await tempRoot();
    await initGraph(root);
    await seedProjectDocs(root);
    const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
    try {
      const report = await bootstrapProjectMemory(store, {
        rootDir: root,
        dryRun: true,
        now: 1_700_000_000_000,
      });

      expect(report).toMatchObject({
        schema_version: "memory.project_bootstrap.v1",
        read_only: true,
        dry_run: true,
        summary: {
          discovered_sources: 3,
          indexed_sources: 0,
          docs: 0,
          nodes: 0,
        },
      });
      expect(report.sources.map((source) => source.kind)).toEqual(["readme", "adr", "docs"]);
      expect(await store.listDocs()).toHaveLength(0);
      expect(report.recommended_next_actions).toContain(
        "rerun without --dry-run to seed RedDB Memory from the discovered project context",
      );
    } finally {
      await store.close();
    }
  });

  test(
    "CLI applies bootstrap through the normal markdown ingest path",
    async () => {
      const root = await tempRoot();
      await initGraph(root);
      await seedProjectDocs(root);

      const dryRun = runMemory(["bootstrap", "--root", root, "--dry-run", "--json"]);
      expect(dryRun.status, dryRun.stderr).toBe(0);
      expect(JSON.parse(dryRun.stdout)).toMatchObject({
        schema_version: "memory.project_bootstrap.v1",
        dry_run: true,
        summary: { discovered_sources: 3, indexed_sources: 0 },
      });

      const applied = runMemory(["bootstrap", "--root", root, "--json"]);
      expect(applied.status, applied.stderr).toBe(0);
      const report = JSON.parse(applied.stdout) as {
        dry_run: boolean;
        summary: { indexed_sources: number; docs: number; nodes: number; edges: number };
        sources: Array<{ path: string; indexed: boolean }>;
      };
      expect(report.dry_run).toBe(false);
      expect(report.summary.indexed_sources).toBe(3);
      expect(report.summary.docs).toBe(3);
      expect(report.summary.nodes).toBeGreaterThanOrEqual(3);
      expect(report.sources.every((source) => source.indexed)).toBe(true);

      const coverage = runMemory(["docs", "coverage", "--root", root, "--json"]);
      expect(coverage.status, coverage.stderr).toBe(0);
      expect(JSON.parse(coverage.stdout)).toMatchObject({
        total_docs: 3,
        grounded_docs: 3,
      });
    },
    TIMEOUT,
  );
});
