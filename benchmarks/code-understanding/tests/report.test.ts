import { describe, expect, test } from "vitest";
import { encode, type JsonValue } from "@reddb-io/toon";
import { buildReport, parseAgentJsonl, parseRunRecords, renderReportMarkdown } from "../src/report.js";
import type { RunRecord } from "../src/types.js";

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    schema_version: "redskills.code_understanding_bench.run.v1",
    generated_at: "2026-06-01T00:00:00.000Z",
    benchmark: "code-understanding",
    runner: "claude",
    arm: "none",
    corpus: "overlap",
    case_id: "case",
    language: "typescript",
    repo: "https://example.test/repo.git",
    repo_path: "/tmp/repo",
    question: "How does it work?",
    run_index: 1,
    status: "pass",
    duration_ms: 1000,
    exit_code: 0,
    signal: null,
    log_path: "/tmp/log.toonl",
    mcp_config_path: "/tmp/mcp.json",
    command: ["claude"],
    metrics: {
      tools: { total: 0, read: 0, grep: 0, bash: 0, mcp: 0, byName: {} },
      tokens: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0, total: 0 },
      cost_usd: null,
    },
    ...overrides,
  };
}

describe("agent JSONL parser", () => {
  test("counts Claude tool_use events and usage", () => {
    const metrics = parseAgentJsonl([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "Read", input: { file_path: "src/a.ts" } },
            { type: "tool_use", name: "mcp__code-nav__workspace_symbols", input: { query: "Foo" } },
          ],
        },
      }),
      JSON.stringify({
        type: "result",
        usage: {
          input_tokens: 100,
          cache_creation_input_tokens: 20,
          cache_read_input_tokens: 30,
          output_tokens: 40,
        },
        total_cost_usd: 0.0123,
      }),
    ].join("\n"));

    expect(metrics.tools).toMatchObject({
      total: 2,
      read: 1,
      grep: 0,
      bash: 0,
      mcp: 1,
    });
    expect(metrics.tools.byName).toMatchObject({
      Read: 1,
      "mcp__code-nav__workspace_symbols": 1,
    });
    expect(metrics.tokens).toEqual({
      input: 100,
      output: 40,
      cacheCreation: 20,
      cacheRead: 30,
      total: 190,
    });
    expect(metrics.cost_usd).toBe(0.0123);
  });
});

describe("benchmark report", () => {
  test("aggregates arms and supports claims only when measured", () => {
    const report = buildReport([
      record({
        arm: "none",
        metrics: {
          tools: { total: 10, read: 5, grep: 3, bash: 1, mcp: 0, byName: {} },
          tokens: { input: 1000, output: 100, cacheCreation: 0, cacheRead: 0, total: 1100 },
          cost_usd: 0.5,
        },
      }),
      record({
        arm: "redskills",
        metrics: {
          tools: { total: 4, read: 1, grep: 0, bash: 0, mcp: 2, byName: {} },
          tokens: { input: 600, output: 100, cacheCreation: 0, cacheRead: 0, total: 700 },
          cost_usd: 0.3,
        },
      }),
      record({
        arm: "codegraph",
        metrics: {
          tools: { total: 3, read: 0, grep: 0, bash: 0, mcp: 2, byName: {} },
          tokens: { input: 500, output: 100, cacheCreation: 0, cacheRead: 0, total: 600 },
          cost_usd: 0.25,
        },
      }),
    ], "2026-06-01T00:00:00.000Z");

    expect(report.schema_version).toBe("redskills.code_understanding_bench.report.v1");
    expect(report.aggregates).toHaveLength(3);
    expect(report.comparisons.map((row) => row.id)).toEqual([
      "redskills_vs_none",
      "redskills_vs_codegraph",
    ]);
    expect(report.comparisons.find((row) => row.id === "redskills_vs_codegraph")).toMatchObject({
      candidate: "redskills",
      baseline: "codegraph",
      read_grep_delta: 1,
    });
    expect(report.claim_guards).toEqual({
      token_savings_claim_supported: true,
      cost_savings_claim_supported: true,
      read_grep_reduction_supported: true,
      unsupported_claims: [],
    });
    expect(renderReportMarkdown(report)).toContain("| redskills | 1 | 1 | 0 | 700 | 0.3000 |");
    expect(renderReportMarkdown(report)).toContain("| redskills_vs_codegraph | +16.7% | +20.0% | 0.0% | +33.3% | 1.0 |");
  });

  test("keeps dry-run planned records from supporting claims", () => {
    const report = buildReport([
      record({ arm: "none", status: "planned" }),
      record({ arm: "redskills", status: "planned" }),
    ]);

    expect(report.claim_guards.unsupported_claims).toEqual([
      "redskills-token-savings",
      "redskills-cost-savings",
      "redskills-read-grep-reduction",
    ]);
  });

  test("parses JSONL run records with schema guard", () => {
    const rows = parseRunRecords(`${JSON.stringify(record({ arm: "codegraph" }))}\n`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.arm).toBe("codegraph");
  });

  test("parses spec-valid TOONL run records and aggregates them", () => {
    const rows = parseRunRecords(encode([
      record({
        arm: "none",
        metrics: {
          tools: { total: 10, read: 4, grep: 2, bash: 1, mcp: 0, byName: {} },
          tokens: { input: 900, output: 100, cacheCreation: 0, cacheRead: 0, total: 1000 },
          cost_usd: 0.4,
        },
      }),
      record({
        arm: "redskills",
        metrics: {
          tools: { total: 4, read: 1, grep: 0, bash: 0, mcp: 2, byName: {} },
          tokens: { input: 500, output: 100, cacheCreation: 0, cacheRead: 0, total: 600 },
          cost_usd: 0.2,
        },
      }),
    ] as unknown as JsonValue));

    expect(rows.map((row) => row.arm)).toEqual(["none", "redskills"]);
    expect(buildReport(rows).comparisons.find((row) => row.id === "redskills_vs_none")).toMatchObject({
      token_delta_pct: -40,
      read_grep_delta: -5,
    });
  });

  test("parses appended standalone TOONL run segments", () => {
    const rows = parseRunRecords([
      encode([record({ arm: "none" })] as unknown as JsonValue).trimEnd(),
      encode([record({ arm: "redskills", run_index: 2 })] as unknown as JsonValue).trimEnd(),
      "",
    ].join("\n"));

    expect(rows.map((row) => `${row.arm}:${row.run_index}`)).toEqual(["none:1", "redskills:2"]);
  });
});
