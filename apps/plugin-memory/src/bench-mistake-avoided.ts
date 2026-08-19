import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const MISTAKE_AVOIDED_SCHEMA_VERSION = "memory.bench.mistake_avoided.v1" as const;

export type MistakeAvoidedCategory =
  | "validation_retry"
  | "cross_agent_recall"
  | "capsule_handoff"
  | "governed_rejection";

export type MemoryAction = "governed_write" | "recall" | "capsule";
export type PolicyDecision = "allowed" | "stored" | "proposed" | "rejected";

export interface PolicyMetric {
  decision: PolicyDecision;
  reason: string;
}

export interface BaselineFlowFixture {
  flow: "broad_read";
  tokens: number;
  files_read: number;
  commands_run: number;
  answer: string;
  policy: PolicyMetric;
}

export interface GovernedFlowFixture {
  flow: "governed_write_recall_capsule";
  tokens: number;
  files_read: number;
  commands_run: number;
  answer: string;
  policy: PolicyMetric;
  memory_actions: MemoryAction[];
  capsule: {
    included: boolean;
    tokens: number;
  };
}

export interface MistakeAvoidedScenarioFixture {
  id: string;
  title: string;
  category: MistakeAvoidedCategory;
  mistake_kind: string;
  expected_answer: string;
  baseline: BaselineFlowFixture;
  governed: GovernedFlowFixture;
}

export interface MistakeAvoidedRecord {
  schema_version: typeof MISTAKE_AVOIDED_SCHEMA_VERSION;
  scenario_id: string;
  title: string;
  category: MistakeAvoidedCategory;
  mistake_kind: string;
  expected_answer: string;
  baseline: BaselineFlowFixture;
  governed: GovernedFlowFixture;
  baseline_correct: boolean;
  governed_correct: boolean;
  mistake_avoided: boolean;
  token_delta: number;
  token_savings_pct: number;
  file_delta: number;
  command_delta: number;
}

export interface MistakeAvoidedAggregate {
  scenario_count: number;
  mistake_avoided: number;
  mistake_avoided_rate: number;
  baseline_tokens: number;
  governed_tokens: number;
  token_delta: number;
  token_savings_pct: number;
  baseline_files_read: number;
  governed_files_read: number;
  file_delta: number;
  baseline_commands_run: number;
  governed_commands_run: number;
  command_delta: number;
}

export interface MistakeAvoidedReport {
  schema_version: typeof MISTAKE_AVOIDED_SCHEMA_VERSION;
  generated_at: string;
  benchmark: "governed-memory-mistake-avoided";
  claim_guards: {
    full_failure_learning_claimed: false;
    memory_learn_available: false;
    memory_refine_available: false;
    note: string;
  };
  coverage: Record<MistakeAvoidedCategory, number>;
  aggregate: MistakeAvoidedAggregate;
  records: MistakeAvoidedRecord[];
}

const REQUIRED_CATEGORIES: MistakeAvoidedCategory[] = [
  "validation_retry",
  "cross_agent_recall",
  "capsule_handoff",
  "governed_rejection",
];

export async function loadMistakeAvoidedScenarios(dir: string): Promise<MistakeAvoidedScenarioFixture[]> {
  const raw = await readFile(join(dir, "scenarios.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error("scenarios.json must be a JSON array");
  return parsed.map(asScenario);
}

export async function runBenchMistakeAvoided(options: {
  fixtureDir: string;
  generatedAt?: string;
}): Promise<MistakeAvoidedReport> {
  const scenarios = await loadMistakeAvoidedScenarios(options.fixtureDir);
  return scoreMistakeAvoidedScenarios(scenarios, {
    generatedAt: options.generatedAt ?? new Date().toISOString(),
  });
}

export function scoreMistakeAvoidedScenarios(
  scenarios: MistakeAvoidedScenarioFixture[],
  options: { generatedAt: string },
): MistakeAvoidedReport {
  const records = scenarios.map(scoreScenario);
  const coverage = REQUIRED_CATEGORIES.reduce<Record<MistakeAvoidedCategory, number>>((acc, category) => {
    acc[category] = records.filter((record) => record.category === category).length;
    return acc;
  }, {
    validation_retry: 0,
    cross_agent_recall: 0,
    capsule_handoff: 0,
    governed_rejection: 0,
  });
  return {
    schema_version: MISTAKE_AVOIDED_SCHEMA_VERSION,
    generated_at: options.generatedAt,
    benchmark: "governed-memory-mistake-avoided",
    claim_guards: {
      full_failure_learning_claimed: false,
      memory_learn_available: false,
      memory_refine_available: false,
      note: "This benchmark measures deterministic governed write, recall, and capsule ergonomics only; it does not claim autonomous failure learning before memory learn/refine exists.",
    },
    coverage,
    aggregate: aggregateRecords(records),
    records,
  };
}

export function formatMistakeAvoidedReport(report: MistakeAvoidedReport): string {
  const lines = [
    "# Governed Memory mistake_avoided benchmark",
    "",
    `Scenarios: ${report.aggregate.scenario_count}`,
    `Mistakes avoided: ${report.aggregate.mistake_avoided}/${report.aggregate.scenario_count} (${formatPct(report.aggregate.mistake_avoided_rate)})`,
    `Token savings: ${report.aggregate.token_delta} (${formatPct(report.aggregate.token_savings_pct)})`,
    `File reads avoided: ${report.aggregate.file_delta}`,
    `Commands avoided: ${report.aggregate.command_delta}`,
    "",
    "The benchmark does not claim full failure learning; memory learn/refine are marked unavailable in claim_guards.",
    "",
    "| Scenario | mistake_avoided | Baseline answer | Governed answer | Policy | Tokens |",
    "| --- | --- | --- | --- | --- | ---: |",
  ];
  for (const record of report.records) {
    lines.push([
      record.scenario_id,
      String(record.mistake_avoided),
      escapeCell(record.baseline.answer),
      escapeCell(record.governed.answer),
      record.governed.policy.decision,
      String(record.governed.tokens),
    ].join(" | "));
  }
  return `${lines.join("\n")}\n`;
}

function scoreScenario(scenario: MistakeAvoidedScenarioFixture): MistakeAvoidedRecord {
  const baselineCorrect = sameAnswer(scenario.baseline.answer, scenario.expected_answer);
  const governedCorrect = sameAnswer(scenario.governed.answer, scenario.expected_answer);
  const mistakeAvoided = !baselineCorrect && governedCorrect && policySupportsGovernedOutcome(scenario);
  return {
    schema_version: MISTAKE_AVOIDED_SCHEMA_VERSION,
    scenario_id: scenario.id,
    title: scenario.title,
    category: scenario.category,
    mistake_kind: scenario.mistake_kind,
    expected_answer: scenario.expected_answer,
    baseline: scenario.baseline,
    governed: scenario.governed,
    baseline_correct: baselineCorrect,
    governed_correct: governedCorrect,
    mistake_avoided: mistakeAvoided,
    token_delta: scenario.baseline.tokens - scenario.governed.tokens,
    token_savings_pct: pctDelta(scenario.baseline.tokens, scenario.governed.tokens),
    file_delta: scenario.baseline.files_read - scenario.governed.files_read,
    command_delta: scenario.baseline.commands_run - scenario.governed.commands_run,
  };
}

function aggregateRecords(records: MistakeAvoidedRecord[]): MistakeAvoidedAggregate {
  const baselineTokens = sum(records, (record) => record.baseline.tokens);
  const governedTokens = sum(records, (record) => record.governed.tokens);
  const baselineFiles = sum(records, (record) => record.baseline.files_read);
  const governedFiles = sum(records, (record) => record.governed.files_read);
  const baselineCommands = sum(records, (record) => record.baseline.commands_run);
  const governedCommands = sum(records, (record) => record.governed.commands_run);
  const avoided = records.filter((record) => record.mistake_avoided).length;
  return {
    scenario_count: records.length,
    mistake_avoided: avoided,
    mistake_avoided_rate: records.length === 0 ? 0 : avoided / records.length,
    baseline_tokens: baselineTokens,
    governed_tokens: governedTokens,
    token_delta: baselineTokens - governedTokens,
    token_savings_pct: pctDelta(baselineTokens, governedTokens),
    baseline_files_read: baselineFiles,
    governed_files_read: governedFiles,
    file_delta: baselineFiles - governedFiles,
    baseline_commands_run: baselineCommands,
    governed_commands_run: governedCommands,
    command_delta: baselineCommands - governedCommands,
  };
}

function policySupportsGovernedOutcome(scenario: MistakeAvoidedScenarioFixture): boolean {
  if (scenario.category === "governed_rejection") return scenario.governed.policy.decision === "rejected";
  return scenario.governed.policy.decision === "stored" || scenario.governed.policy.decision === "proposed";
}

function sameAnswer(actual: string, expected: string): boolean {
  return normalizeAnswer(actual) === normalizeAnswer(expected);
}

function normalizeAnswer(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function pctDelta(baseline: number, governed: number): number {
  if (baseline <= 0) return 0;
  return round4((baseline - governed) / baseline);
}

function sum(records: MistakeAvoidedRecord[], pick: (record: MistakeAvoidedRecord) => number): number {
  return records.reduce((total, record) => total + pick(record), 0);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|");
}

function asScenario(value: unknown): MistakeAvoidedScenarioFixture {
  if (!value || typeof value !== "object") throw new Error("scenario must be an object");
  const r = value as Record<string, unknown>;
  return {
    id: stringField(r, "id"),
    title: stringField(r, "title"),
    category: categoryField(r, "category"),
    mistake_kind: stringField(r, "mistake_kind"),
    expected_answer: stringField(r, "expected_answer"),
    baseline: asBaselineFlow(r.baseline),
    governed: asGovernedFlow(r.governed),
  };
}

function asBaselineFlow(value: unknown): BaselineFlowFixture {
  if (!value || typeof value !== "object") throw new Error("baseline must be an object");
  const r = value as Record<string, unknown>;
  const flow = stringField(r, "flow");
  if (flow !== "broad_read") throw new Error('baseline.flow must be "broad_read"');
  return {
    flow,
    tokens: positiveIntegerField(r, "tokens"),
    files_read: nonNegativeIntegerField(r, "files_read"),
    commands_run: nonNegativeIntegerField(r, "commands_run"),
    answer: stringField(r, "answer"),
    policy: asPolicy(r.policy),
  };
}

function asGovernedFlow(value: unknown): GovernedFlowFixture {
  if (!value || typeof value !== "object") throw new Error("governed must be an object");
  const r = value as Record<string, unknown>;
  const flow = stringField(r, "flow");
  if (flow !== "governed_write_recall_capsule") {
    throw new Error('governed.flow must be "governed_write_recall_capsule"');
  }
  const memoryActions = arrayOfStrings(r, "memory_actions").map(asMemoryAction);
  return {
    flow,
    tokens: positiveIntegerField(r, "tokens"),
    files_read: nonNegativeIntegerField(r, "files_read"),
    commands_run: nonNegativeIntegerField(r, "commands_run"),
    answer: stringField(r, "answer"),
    policy: asPolicy(r.policy),
    memory_actions: memoryActions,
    capsule: asCapsule(r.capsule),
  };
}

function asCapsule(value: unknown): GovernedFlowFixture["capsule"] {
  if (!value || typeof value !== "object") throw new Error("governed.capsule must be an object");
  const r = value as Record<string, unknown>;
  return {
    included: booleanField(r, "included"),
    tokens: nonNegativeIntegerField(r, "tokens"),
  };
}

function asPolicy(value: unknown): PolicyMetric {
  if (!value || typeof value !== "object") throw new Error("policy must be an object");
  const r = value as Record<string, unknown>;
  return {
    decision: policyDecisionField(r, "decision"),
    reason: stringField(r, "reason"),
  };
}

function categoryField(r: Record<string, unknown>, key: string): MistakeAvoidedCategory {
  const value = stringField(r, key);
  if (!REQUIRED_CATEGORIES.includes(value as MistakeAvoidedCategory)) {
    throw new Error(`field "${key}" must be one of ${REQUIRED_CATEGORIES.join(", ")}`);
  }
  return value as MistakeAvoidedCategory;
}

function asMemoryAction(value: string): MemoryAction {
  if (value === "governed_write" || value === "recall" || value === "capsule") return value;
  throw new Error(`memory action must be governed_write, recall, or capsule: ${value}`);
}

function policyDecisionField(r: Record<string, unknown>, key: string): PolicyDecision {
  const value = stringField(r, key);
  if (value === "allowed" || value === "stored" || value === "proposed" || value === "rejected") return value;
  throw new Error(`field "${key}" must be allowed, stored, proposed, or rejected`);
}

function stringField(r: Record<string, unknown>, key: string): string {
  const value = r[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`field "${key}" must be a non-empty string`);
  return value;
}

function booleanField(r: Record<string, unknown>, key: string): boolean {
  const value = r[key];
  if (typeof value !== "boolean") throw new Error(`field "${key}" must be a boolean`);
  return value;
}

function positiveIntegerField(r: Record<string, unknown>, key: string): number {
  const value = nonNegativeIntegerField(r, key);
  if (value < 1) throw new Error(`field "${key}" must be a positive integer`);
  return value;
}

function nonNegativeIntegerField(r: Record<string, unknown>, key: string): number {
  const value = r[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`field "${key}" must be a non-negative integer`);
  }
  return value;
}

function arrayOfStrings(r: Record<string, unknown>, key: string): string[] {
  const value = r[key];
  if (!Array.isArray(value)) throw new Error(`field "${key}" must be an array`);
  return value.map((item) => {
    if (typeof item !== "string") throw new Error(`field "${key}" must contain only strings`);
    return item;
  });
}
