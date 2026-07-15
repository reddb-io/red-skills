import { readFile } from "node:fs/promises";
import { decode } from "@reddb-io/toon";
import type { AggregateRow, ArmId, BenchmarkReport, ComparisonRow, RunRecord, TokenUsage, ToolCounts } from "./types.js";

const ZERO_TOOLS: ToolCounts = { total: 0, read: 0, grep: 0, bash: 0, mcp: 0, byName: {} };
const ZERO_TOKENS: TokenUsage = { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 };

export function emptyToolCounts(): ToolCounts {
  return { ...ZERO_TOOLS, byName: {} };
}

export function emptyTokenUsage(): TokenUsage {
  return { ...ZERO_TOKENS };
}

export function parseAgentJsonl(text: string): Pick<RunRecord["metrics"], "tools" | "tokens" | "cost_usd"> {
  const tools = emptyToolCounts();
  const tokens = emptyTokenUsage();
  let cost: number | null = null;

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: unknown;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    collectToolUses(event, tools);
    collectUsage(event, tokens);
    const maybeCost = findNumber(event, ["total_cost_usd", "cost_usd"]);
    if (maybeCost !== null) cost = maybeCost;
  }

  tokens.total = tokens.input + tokens.output + tokens.cacheCreation + tokens.cacheRead;
  return { tools, tokens, cost_usd: cost };
}

function collectToolUses(value: unknown, counts: ToolCounts): void {
  if (Array.isArray(value)) {
    for (const item of value) collectToolUses(item, counts);
    return;
  }
  if (!isRecord(value)) return;

  const type = typeof value.type === "string" ? value.type : "";
  const name = typeof value.name === "string"
    ? value.name
    : typeof value.tool_name === "string"
      ? value.tool_name
      : undefined;
  if (name && (type === "tool_use" || value.tool_input !== undefined || value.input !== undefined)) {
    addTool(counts, name);
  }

  for (const child of Object.values(value)) collectToolUses(child, counts);
}

function addTool(counts: ToolCounts, name: string): void {
  counts.total += 1;
  counts.byName[name] = (counts.byName[name] ?? 0) + 1;
  const lower = name.toLowerCase();
  if (lower === "read" || lower.endsWith("__read")) counts.read += 1;
  if (lower === "grep" || lower.endsWith("__grep")) counts.grep += 1;
  if (lower === "bash" || lower.endsWith("__bash")) counts.bash += 1;
  if (lower.startsWith("mcp__")) counts.mcp += 1;
}

function collectUsage(value: unknown, tokens: TokenUsage): void {
  if (Array.isArray(value)) {
    for (const item of value) collectUsage(item, tokens);
    return;
  }
  if (!isRecord(value)) return;

  const usage = isRecord(value.usage) ? value.usage : value;
  tokens.input = Math.max(tokens.input, numberValue(usage.input_tokens) + numberValue(usage.prompt_tokens));
  tokens.output = Math.max(tokens.output, numberValue(usage.output_tokens) + numberValue(usage.completion_tokens));
  tokens.cacheCreation = Math.max(tokens.cacheCreation, numberValue(usage.cache_creation_input_tokens));
  tokens.cacheRead = Math.max(tokens.cacheRead, numberValue(usage.cache_read_input_tokens) + numberValue(usage.cached_input_tokens));

  for (const child of Object.values(value)) collectUsage(child, tokens);
}

export async function loadRunRecords(path: string): Promise<RunRecord[]> {
  const body = await readFile(path, "utf8");
  return parseRunRecords(body);
}

export function parseRunRecords(body: string): RunRecord[] {
  const first = body.trimStart()[0];
  if (first === "[") return parseRunRecordsToonl(body);
  return parseRunRecordsJsonl(body);
}

function parseRunRecordsJsonl(body: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = JSON.parse(trimmed) as RunRecord;
    records.push(assertRunRecord(parsed));
  }
  return records;
}

function parseRunRecordsToonl(body: string): RunRecord[] {
  return toonlSegments(body).flatMap((segment) => {
    const decoded = decode(segment);
    const rows = Array.isArray(decoded) ? decoded : [decoded];
    return rows.map((row) => assertRunRecord(row as unknown as RunRecord));
  });
}

function toonlSegments(body: string): string[] {
  const segments: string[] = [];
  let current: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    if (/^\[[0-9]+\](?:\{.*\})?:$/.test(line) && current.length > 0) {
      segments.push(`${current.join("\n")}\n`);
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0) segments.push(`${current.join("\n")}\n`);
  return segments;
}

function assertRunRecord(parsed: RunRecord): RunRecord {
  if (parsed.schema_version !== "redskills.code_understanding_bench.run.v1") {
    throw new Error(`unsupported run record schema: ${String(parsed.schema_version)}`);
  }
  return parsed;
}

export function buildReport(records: RunRecord[], generatedAt = new Date().toISOString()): BenchmarkReport {
  const arms: ArmId[] = ["none", "redskills", "codegraph"];
  const aggregates = arms
    .map((arm) => aggregateArm(arm, records.filter((r) => r.arm === arm)))
    .filter((row) => row.runs > 0);
  const none = aggregates.find((row) => row.arm === "none");
  const redskills = aggregates.find((row) => row.arm === "redskills");
  const codegraph = aggregates.find((row) => row.arm === "codegraph");
  const comparisons = [
    comparison("redskills_vs_none", redskills, none),
    comparison("redskills_vs_codegraph", redskills, codegraph),
  ].filter((row): row is ComparisonRow => row !== null);

  const unsupported: string[] = [];
  const tokenSavings = !!none && !!redskills && redskills.avg_total_tokens > 0 && redskills.avg_total_tokens < none.avg_total_tokens;
  const costSavings = !!none && !!redskills && redskills.avg_cost_usd !== null && none.avg_cost_usd !== null && redskills.avg_cost_usd < none.avg_cost_usd;
  const readGrepReduction = !!none && !!redskills && (redskills.avg_read_calls + redskills.avg_grep_calls) < (none.avg_read_calls + none.avg_grep_calls);
  if (!tokenSavings) unsupported.push("redskills-token-savings");
  if (!costSavings) unsupported.push("redskills-cost-savings");
  if (!readGrepReduction) unsupported.push("redskills-read-grep-reduction");

  const runners = new Set(records.map((r) => r.runner));
  return {
    schema_version: "redskills.code_understanding_bench.report.v1",
    generated_at: generatedAt,
    corpus: "overlap",
    runner: runners.size === 1 ? records[0]?.runner ?? "claude" : "mixed",
    run_count: records.length,
    cases: [...new Set(records.map((r) => r.case_id))],
    aggregates,
    comparisons,
    claim_guards: {
      token_savings_claim_supported: tokenSavings,
      cost_savings_claim_supported: costSavings,
      read_grep_reduction_supported: readGrepReduction,
      unsupported_claims: unsupported,
    },
  };
}

function comparison(
  id: ComparisonRow["id"],
  candidate: AggregateRow | undefined,
  baseline: AggregateRow | undefined,
): ComparisonRow | null {
  if (!candidate || !baseline) return null;
  return {
    id,
    candidate: candidate.arm,
    baseline: baseline.arm,
    token_delta_pct: pctDelta(candidate.avg_total_tokens, baseline.avg_total_tokens),
    cost_delta_pct: candidate.avg_cost_usd === null || baseline.avg_cost_usd === null
      ? null
      : pctDelta(candidate.avg_cost_usd, baseline.avg_cost_usd),
    duration_delta_pct: pctDelta(candidate.avg_duration_ms, baseline.avg_duration_ms),
    tool_call_delta_pct: pctDelta(candidate.avg_tool_calls, baseline.avg_tool_calls),
    read_grep_delta:
      (candidate.avg_read_calls + candidate.avg_grep_calls) -
      (baseline.avg_read_calls + baseline.avg_grep_calls),
  };
}

function aggregateArm(arm: ArmId, records: RunRecord[]): AggregateRow {
  const runs = records.length;
  const measured = records.filter((r) => r.status === "pass" || r.status === "fail");
  const costValues = measured.map((r) => r.metrics.cost_usd).filter((n): n is number => typeof n === "number");
  return {
    arm,
    runs,
    passed: records.filter((r) => r.status === "pass").length,
    failed: records.filter((r) => r.status === "fail").length,
    planned: records.filter((r) => r.status === "planned").length,
    avg_duration_ms: avg(measured.map((r) => r.duration_ms)),
    avg_total_tokens: avg(measured.map((r) => r.metrics.tokens.total)),
    avg_cost_usd: costValues.length ? avg(costValues) : null,
    avg_tool_calls: avg(measured.map((r) => r.metrics.tools.total)),
    avg_read_calls: avg(measured.map((r) => r.metrics.tools.read)),
    avg_grep_calls: avg(measured.map((r) => r.metrics.tools.grep)),
    avg_bash_calls: avg(measured.map((r) => r.metrics.tools.bash)),
    avg_mcp_calls: avg(measured.map((r) => r.metrics.tools.mcp)),
  };
}

export function renderReportMarkdown(report: BenchmarkReport): string {
  const lines = [
    `# Code Understanding Benchmark - ${report.generated_at.slice(0, 10)}`,
    "",
    `Corpus: ${report.corpus}. Runner: ${report.runner}. Runs: ${report.run_count}.`,
    "",
    "| Arm | Runs | Pass | Fail | Avg tokens | Avg cost | Avg tools | Read | Grep | Bash | MCP | Avg duration |",
    "|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|",
  ];
  for (const row of report.aggregates) {
    lines.push([
      `| ${row.arm}`,
      row.runs,
      row.passed,
      row.failed,
      Math.round(row.avg_total_tokens),
      row.avg_cost_usd === null ? "n/a" : row.avg_cost_usd.toFixed(4),
      row.avg_tool_calls.toFixed(1),
      row.avg_read_calls.toFixed(1),
      row.avg_grep_calls.toFixed(1),
      row.avg_bash_calls.toFixed(1),
      row.avg_mcp_calls.toFixed(1),
      `${Math.round(row.avg_duration_ms / 1000)}s |`,
    ].join(" | "));
  }
  if (report.comparisons.length > 0) {
    lines.push("", "## Comparisons", "");
    lines.push("| Comparison | Tokens | Cost | Duration | Tool calls | Read+Grep delta |");
    lines.push("|---|--:|--:|--:|--:|--:|");
    for (const row of report.comparisons) {
      lines.push([
        `| ${row.id}`,
        formatPct(row.token_delta_pct),
        formatPct(row.cost_delta_pct),
        formatPct(row.duration_delta_pct),
        formatPct(row.tool_call_delta_pct),
        `${row.read_grep_delta.toFixed(1)} |`,
      ].join(" | "));
    }
  }
  lines.push("", "## Claim guards", "");
  lines.push(`- Token savings claim: ${report.claim_guards.token_savings_claim_supported ? "supported" : "not supported"}`);
  lines.push(`- Cost savings claim: ${report.claim_guards.cost_savings_claim_supported ? "supported" : "not supported"}`);
  lines.push(`- Read/Grep reduction claim: ${report.claim_guards.read_grep_reduction_supported ? "supported" : "not supported"}`);
  if (report.claim_guards.unsupported_claims.length) {
    lines.push(`- Unsupported public claims: ${report.claim_guards.unsupported_claims.join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pctDelta(candidate: number, baseline: number): number | null {
  if (baseline === 0) return null;
  return ((candidate - baseline) / baseline) * 100;
}

function formatPct(value: number | null): string {
  return value === null ? "n/a" : `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function numberValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function findNumber(value: unknown, keys: string[]): number | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNumber(item, keys);
      if (found !== null) return found;
    }
    return null;
  }
  if (!isRecord(value)) return null;
  for (const key of keys) {
    const valueAtKey = value[key];
    if (typeof valueAtKey === "number" && Number.isFinite(valueAtKey)) return valueAtKey;
  }
  for (const child of Object.values(value)) {
    const found = findNumber(child, keys);
    if (found !== null) return found;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
