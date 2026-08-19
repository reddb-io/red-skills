export type RunnerId = "claude" | "codex";
export type ArmId = "none" | "redskills" | "codegraph";
export type RunStatus = "planned" | "pass" | "fail" | "skipped";

export interface ToolCounts {
  total: number;
  read: number;
  grep: number;
  bash: number;
  mcp: number;
  byName: Record<string, number>;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  total: number;
}

export interface RunRecord {
  schema_version: "redskills.code_understanding_bench.run.v1";
  generated_at: string;
  benchmark: "code-understanding";
  runner: RunnerId;
  arm: ArmId;
  corpus: "overlap";
  case_id: string;
  language: string;
  repo: string;
  repo_path: string;
  question: string;
  run_index: number;
  status: RunStatus;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  log_path: string | null;
  mcp_config_path: string | null;
  command: string[];
  metrics: {
    tools: ToolCounts;
    tokens: TokenUsage;
    cost_usd: number | null;
  };
  error?: string;
}

export interface AggregateRow {
  arm: ArmId;
  runs: number;
  passed: number;
  failed: number;
  planned: number;
  avg_duration_ms: number;
  avg_total_tokens: number;
  avg_cost_usd: number | null;
  avg_tool_calls: number;
  avg_read_calls: number;
  avg_grep_calls: number;
  avg_bash_calls: number;
  avg_mcp_calls: number;
}

export interface BenchmarkReport {
  schema_version: "redskills.code_understanding_bench.report.v1";
  generated_at: string;
  corpus: "overlap";
  runner: RunnerId | "mixed";
  run_count: number;
  cases: string[];
  aggregates: AggregateRow[];
  comparisons: ComparisonRow[];
  claim_guards: {
    token_savings_claim_supported: boolean;
    cost_savings_claim_supported: boolean;
    read_grep_reduction_supported: boolean;
    unsupported_claims: string[];
  };
}

export interface ComparisonRow {
  id: "redskills_vs_none" | "redskills_vs_codegraph";
  candidate: ArmId;
  baseline: ArmId;
  token_delta_pct: number | null;
  cost_delta_pct: number | null;
  duration_delta_pct: number | null;
  tool_call_delta_pct: number | null;
  read_grep_delta: number;
}
