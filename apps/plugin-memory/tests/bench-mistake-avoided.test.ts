import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  MISTAKE_AVOIDED_SCHEMA_VERSION,
  formatMistakeAvoidedReport,
  loadMistakeAvoidedScenarios,
  runBenchMistakeAvoided,
  scoreMistakeAvoidedScenarios,
} from "../src/bench-mistake-avoided.js";

const FIXTURE_DIR = join(__dirname, "../bench/mistake-avoided/governed-flows");
const GENERATED_AT = "2026-06-24T00:00:00.000Z";

describe("memory bench mistake_avoided — fixture integrity", () => {
  test("fixtures cover validation retry, cross-agent recall, capsule handoff, and governed rejection", async () => {
    const scenarios = await loadMistakeAvoidedScenarios(FIXTURE_DIR);
    expect(scenarios.map((scenario) => scenario.category).sort()).toEqual([
      "capsule_handoff",
      "cross_agent_recall",
      "governed_rejection",
      "validation_retry",
    ]);
    for (const scenario of scenarios) {
      expect(scenario.baseline.flow).toBe("broad_read");
      expect(scenario.governed.flow).toBe("governed_write_recall_capsule");
      expect(scenario.baseline.tokens).toBeGreaterThan(scenario.governed.tokens);
      expect(scenario.baseline.files_read).toBeGreaterThanOrEqual(scenario.governed.files_read);
      expect(scenario.baseline.commands_run).toBeGreaterThanOrEqual(scenario.governed.commands_run);
      expect(scenario.expected_answer).not.toBe(scenario.baseline.answer);
      expect(scenario.expected_answer).toBe(scenario.governed.answer);
      expect(scenario.baseline.policy.decision).toBe("allowed");
      expect(scenario.governed.memory_actions.length).toBeGreaterThan(0);
    }
    expect(scenarios.find((scenario) => scenario.category === "capsule_handoff")?.governed.capsule.included).toBe(true);
    expect(scenarios.find((scenario) => scenario.category === "governed_rejection")?.governed.policy.decision).toBe("rejected");
  });
});

describe("memory bench mistake_avoided — scoring", () => {
  test("scores mistake_avoided from broad-read baseline to governed memory flows", async () => {
    const scenarios = await loadMistakeAvoidedScenarios(FIXTURE_DIR);
    const report = scoreMistakeAvoidedScenarios(scenarios, { generatedAt: GENERATED_AT });

    expect(report.schema_version).toBe(MISTAKE_AVOIDED_SCHEMA_VERSION);
    expect(report.generated_at).toBe(GENERATED_AT);
    expect(report.aggregate.scenario_count).toBe(4);
    expect(report.aggregate.mistake_avoided).toBe(4);
    expect(report.aggregate.mistake_avoided_rate).toBe(1);
    expect(report.aggregate.token_savings_pct).toBeGreaterThan(0.5);
    expect(report.aggregate.file_delta).toBeGreaterThan(0);
    expect(report.aggregate.command_delta).toBeGreaterThan(0);

    for (const record of report.records) {
      expect(record.schema_version).toBe(MISTAKE_AVOIDED_SCHEMA_VERSION);
      expect(record.baseline_correct).toBe(false);
      expect(record.governed_correct).toBe(true);
      expect(record.mistake_avoided).toBe(true);
      expect(record.token_delta).toBeGreaterThan(0);
      expect(record.file_delta).toBeGreaterThanOrEqual(0);
      expect(record.command_delta).toBeGreaterThanOrEqual(0);
      expect(record.baseline).toHaveProperty("answer");
      expect(record.baseline).toHaveProperty("policy");
      expect(record.governed).toHaveProperty("answer");
      expect(record.governed).toHaveProperty("policy");
    }
  });
});

describe("memory bench mistake_avoided — report shape", () => {
  test("emits claim guards without claiming full failure learning before learn/refine exist", async () => {
    const report = await runBenchMistakeAvoided({ fixtureDir: FIXTURE_DIR, generatedAt: GENERATED_AT });

    expect(report.benchmark).toBe("governed-memory-mistake-avoided");
    expect(report.coverage).toEqual({
      validation_retry: 1,
      cross_agent_recall: 1,
      capsule_handoff: 1,
      governed_rejection: 1,
    });
    expect(report.claim_guards).toMatchObject({
      full_failure_learning_claimed: false,
      memory_learn_available: false,
      memory_refine_available: false,
    });
    expect(report.claim_guards.note).toContain("does not claim autonomous failure learning");

    const markdown = formatMistakeAvoidedReport(report);
    expect(markdown).toContain("Governed Memory mistake_avoided benchmark");
    expect(markdown).toContain("Mistakes avoided: 4/4");
    expect(markdown).toContain("memory learn/refine are marked unavailable");
  });
});
