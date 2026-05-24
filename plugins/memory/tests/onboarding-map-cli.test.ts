import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { ingestSkillEvents, type SkillEvent } from "../src/skill-events.js";

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
  const root = await mkdtemp(join(tmpdir(), "memory-onboarding-map-cli-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);

  await store.upsertNode({
    label: "memory-graph-mode",
    node_type: "concept",
    properties: {
      title: "Memory graph mode",
      content: "Graph mode stores cited concepts for onboarding.",
      source: "manual",
    },
  });
  const oldDecision = await store.upsertNode({
    label: "old-report-shape",
    node_type: "decision",
    properties: {
      title: "Old report shape",
      content: "The old report shape was superseded.",
      source: "manual",
    },
  });
  const newDecision = await store.upsertNode({
    label: "new-report-shape",
    node_type: "decision",
    properties: {
      title: "New report shape",
      content: "The current report shape is JSON plus markdown.",
      source: "manual",
    },
  });
  const firstRisk = await store.upsertNode({
    label: "recall-latency-risk",
    node_type: "problem",
    properties: {
      title: "Recall latency risk",
      content: "Recall reports can become slow if graph reads fan out.",
      source: "manual",
    },
  });
  const secondRisk = await store.upsertNode({
    label: "opposing-risk-note",
    node_type: "problem",
    properties: {
      title: "Opposing risk note",
      content: "Another note disagrees about the latency risk.",
      source: "manual",
    },
  });
  await store.upsertNode({
    label: "onboarding-map-validation",
    node_type: "validation",
    properties: {
      title: "Onboarding map validation",
      content: "Vitest covers the onboarding map structure.",
      source: "manual",
    },
  });
  await store.supersede(oldDecision, newDecision, "new report shape replaces the old one");
  await store.upsertEdge({
    label: "CONTRADICTS",
    from_rid: firstRisk,
    to_rid: secondRisk,
    properties: { reason: "risk assessment differs" },
  });

  const events: SkillEvent[] = [
    {
      event_type: "used",
      event_id: "onboarding-map-skill-used",
      timestamp: "2026-05-22T16:01:00.000Z",
      session_id: "session-onboarding-map",
      turn_id: "turn-onboarding-map-1",
      name: "dev:tdd",
      source_kind: "plugin",
      path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
      runner: "codex",
    },
    {
      event_type: "result",
      event_id: "onboarding-map-skill-result",
      timestamp: "2026-05-22T16:02:00.000Z",
      session_id: "session-onboarding-map",
      turn_id: "turn-onboarding-map-1",
      name: "dev:tdd",
      source_kind: "plugin",
      path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
      runner: "codex",
      result: { status: "succeeded" },
    },
  ];
  await ingestSkillEvents(store, events);
  await store.close();
  stores.pop();
  return root;
}

describe("memory onboarding-map CLI", () => {
  test(
    "prints stable JSON",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["onboarding-map", "--root", root, "--json"]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        summary: {
          concepts: number;
          decisions: number;
          risks: number;
          validations: number;
          suggestedSkills: number;
          warnings: number;
        };
        sections: {
          concepts: Array<{ citation: string; urn: string }>;
          decisions: Array<{ statuses: string[] }>;
          risks: Array<{ statuses: string[] }>;
          suggestedSkills: Array<{ citation: string; name: string }>;
        };
        markdown: string;
      };

      expect(body.status).toBe("review-warnings");
      expect(body.summary).toMatchObject({
        concepts: 1,
        decisions: 2,
        risks: 2,
        validations: 1,
        suggestedSkills: 1,
      });
      expect(body.summary.warnings).toBeGreaterThanOrEqual(2);
      expect(body.sections.concepts[0]).toMatchObject({
        citation: "[M1]",
        urn: expect.stringMatching(/^memory_nodes:/),
      });
      expect(body.sections.decisions.some((item) => item.statuses.includes("superseded"))).toBe(
        true,
      );
      expect(body.sections.risks.every((item) => item.statuses.includes("contradictory"))).toBe(
        true,
      );
      expect(body.sections.suggestedSkills[0]).toMatchObject({
        citation: "[S1]",
        name: "dev:tdd",
      });
      expect(body.markdown).toContain("# Memory onboarding map");
    },
    TIMEOUT,
  );

  test(
    "prints a human-readable map by default",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["onboarding-map", "--root", root]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("# Memory onboarding map");
      expect(result.stdout).toContain("## Concepts");
      expect(result.stdout).toContain("## Suggested Skills");
      expect(result.stdout).toContain("Recall latency risk");
    },
    TIMEOUT,
  );
});
