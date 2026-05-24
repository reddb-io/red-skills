import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { MemoryStore } from "../src/graph-store.js";
import { initGraph } from "../src/init.js";
import { recordReasoningAttempt } from "../src/reasoning/attempt-writer.js";
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
  const root = await mkdtemp(join(tmpdir(), "memory-learning-debt-cli-"));
  roots.push(root);
  const { storeUri } = await initGraph(root, { skillTelemetry: true });
  const store = await MemoryStore.open({ uri: storeUri, project: "test" });
  stores.push(store);

  for (const attemptNumber of [1, 2]) {
    await recordReasoningAttempt(store, {
      repository: "reddb-io/red-skills",
      issueNumber: 131,
      attemptNumber,
      status: "blocked",
      errorClass: "validation",
      summary: `blocked validation ${attemptNumber}`,
      touchedFiles: ["plugins/memory/src/cli.ts"],
    });
  }

  const fixRid = await store.upsertNode({
    label: "learning-debt-fix",
    node_type: "fix",
    properties: {
      title: "Learning debt implementation",
      content: "Fix: learning debt command summarizes report categories.",
      source: "manual",
    },
  });
  expect(fixRid).toBeGreaterThan(0);

  const events: SkillEvent[] = [1, 2].map((n) => ({
    event_type: "result",
    event_id: `learning-debt-skill-${n}`,
    timestamp: `2026-05-22T16:0${n}:00.000Z`,
    session_id: "session-learning-debt",
    turn_id: `turn-learning-debt-${n}`,
    name: "dev:tdd",
    source_kind: "plugin",
    path: "/plugins/dev/skills/engineering/tdd/SKILL.md",
    runner: "codex",
    result: { status: "failed", error_class: "assertion" },
  }));
  await ingestSkillEvents(store, events);
  await store.close();
  stores.pop();
  return root;
}

describe("memory learning-debt CLI", () => {
  test(
    "prints stable JSON",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["learning-debt", "--root", root, "--json"]);

      expect(result.status, result.stderr).toBe(0);
      const body = JSON.parse(result.stdout) as {
        status: string;
        summary: {
          repeatedFailurePatterns: number;
          missingValidationEvidence: number;
          skillTelemetryGaps: number;
        };
        categories: {
          repeatedFailurePatterns: Array<{ pattern: string; attemptCount: number }>;
          missingValidationEvidence: Array<{ evidence: string }>;
          skillTelemetryGaps: Array<{ kind: string; skill: string }>;
        };
        markdown: string;
      };

      expect(body.status).toBe("debt-found");
      expect(body.summary.repeatedFailurePatterns).toBe(1);
      expect(body.summary.missingValidationEvidence).toBeGreaterThanOrEqual(1);
      expect(body.summary.skillTelemetryGaps).toBe(1);
      expect(body.categories.repeatedFailurePatterns[0]).toMatchObject({
        pattern: "issue:131 error:validation",
        attemptCount: 2,
      });
      expect(body.categories.skillTelemetryGaps[0]).toMatchObject({
        kind: "repeated-skill-failures",
        skill: "dev:tdd",
      });
      expect(body.markdown).toContain("# Memory learning debt");
    },
    TIMEOUT,
  );

  test(
    "prints a human-readable report by default",
    async () => {
      const root = await seedRoot();

      const result = runMemory(["learning-debt", "--root", root]);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("# Memory learning debt");
      expect(result.stdout).toContain("Status: debt-found");
      expect(result.stdout).toContain("Repeated Failure Patterns");
      expect(result.stdout).toContain("Skill Telemetry Gaps");
    },
    TIMEOUT,
  );
});
