import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { VOLATILE_MARKER } from "../src/cache-prefix.js";
import { MemoryStore } from "../src/graph-store.js";
import { buildMemoryHandoff } from "../src/handoff.js";
import { buildMemoryHandoffViewerArtifact } from "../src/handoff-viewer.js";
import { initGraph } from "../src/init.js";

const TIMEOUT = 40_000;
const pkgRoot = resolve(__dirname, "..");
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-handoff-"));
  roots.push(root);
  return root;
}

async function seedHandoffStore(root: string): Promise<MemoryStore> {
  await initGraph(root);
  const store = await MemoryStore.open({ uri: `file://${join(root, ".red/memory/graph.rdb")}` });
  await store.upsertNode({
    label: "jwt-rotation-task",
    node_type: "task",
    properties: {
      title: "Finish JWT rotation",
      content: "Continue JWT rotation after validating cache TTL interaction.",
      created_at: 1_700_000_000_000,
    },
  });
  await store.upsertNode({
    label: "jwt-rotation-decision",
    node_type: "decision",
    properties: {
      title: "JWT rotation stays server-side",
      content: "Decision: JWT tokens rotate server-side every 90 days.",
      created_at: 1_700_000_100_000,
    },
  });
  await store.upsertNode({
    label: "jwt-validation",
    node_type: "validation",
    properties: {
      title: "JWT tests passed",
      content: "Validation: pnpm test jwt passed after the rotation change.",
      created_at: 1_700_000_200_000,
    },
  });
  await store.upsertNode({
    label: "cache-risk",
    node_type: "problem",
    properties: {
      title: "Cache TTL risk",
      content: "Risk: JWT cache TTL can outlive rotated signing material.",
      created_at: 1_700_000_300_000,
    },
  });
  await store.upsertNode({
    label: "unrelated-billing",
    node_type: "decision",
    properties: {
      title: "Billing retry",
      content: "Decision: billing retries use exponential backoff.",
      created_at: 1_700_000_400_000,
    },
  });
  return store;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: pkgRoot,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

describe("Memory handoff", () => {
  test("builds a focused cross-agent markdown brief from recent graph evidence", async () => {
    const root = await tempRoot();
    const store = await seedHandoffStore(root);
    try {
      const report = await buildMemoryHandoff(store, {
        focus: "jwt rotation",
        now: 1_700_086_400_000,
      });

      expect(report).toMatchObject({
        schema_version: "memory.handoff.v1",
        read_only: true,
        status: "ready",
        focus: "jwt rotation",
        summary: {
          active_work: 1,
          decisions: 1,
          validations: 1,
          risks: 1,
        },
      });
      expect(report.markdown).toContain("# Memory handoff");
      expect(report.markdown).toContain("Finish JWT rotation");
      expect(report.markdown).toContain("JWT rotation stays server-side");
      expect(report.markdown).not.toContain("Billing retry");

      // Cache-prefix stability (#828): the structural prefix comes first and the
      // per-run dynamic ages are relocated below the volatile marker.
      const markerIndex = report.markdown.indexOf(VOLATILE_MARKER);
      expect(markerIndex).toBeGreaterThan(0);
      const stablePrefix = report.markdown.slice(0, markerIndex);
      expect(stablePrefix).toContain("Finish JWT rotation");
      expect(stablePrefix).not.toMatch(/\d+\s*d(?:ays?)?\s+old/);
      expect(report.markdown.slice(markerIndex)).toMatch(/\d+\s*d(?:ays?)?\s+old/);
      const artifact = buildMemoryHandoffViewerArtifact(report);
      expect(artifact.contract).toMatchObject({
        name: "memory.handoff.viewer",
        version: "memory.handoff.viewer.v1",
        consumes: "memory.handoff.v1",
      });
      expect(artifact.html).toContain("Memory Handoff");
      expect(artifact.html).toContain("Finish JWT rotation");
      expect(artifact.html).toContain('id="memory-handoff-data"');
      expect(report.sections.flatMap((section) => section.items).map((item) => item.citation)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^task:jwt-rotation-task#/),
          expect.stringMatching(/^decision:jwt-rotation-decision#/),
        ]),
      );
    } finally {
      await store.close();
    }
  });

  test(
    "CLI returns JSON handoff reports",
    async () => {
      const root = await tempRoot();
      const store = await seedHandoffStore(root);
      await store.close();

      const result = runMemory(["handoff", "jwt", "--root", root, "--json"]);
      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        schema_version: string;
        focus: string;
        markdown: string;
        summary: { returned_items: number };
      };
      expect(report.schema_version).toBe("memory.handoff.v1");
      expect(report.focus).toBe("jwt");
      expect(report.summary.returned_items).toBeGreaterThan(0);
      expect(report.markdown).toContain("Memory handoff");
    },
    TIMEOUT,
  );

  test(
    "CLI writes a local handoff viewer",
    async () => {
      const root = await tempRoot();
      const store = await seedHandoffStore(root);
      await store.close();

      const out = join(root, "handoff.html");
      const result = runMemory(["handoff-viewer", "jwt", "--root", root, "--out", out]);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("memory: handoff viewer written");
      expect(result.stdout).toContain("contract: memory.handoff.v1");
      const html = await readFile(out, "utf8");
      expect(html).toContain("Memory Handoff");
      expect(html).toContain("JWT rotation stays server-side");
      expect(html).toContain('id="memory-handoff-data"');
    },
    TIMEOUT,
  );
});
