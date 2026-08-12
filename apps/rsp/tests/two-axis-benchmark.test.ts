import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { buildTwoAxisBenchmarkReport, renderTwoAxisSummary, writeTwoAxisBenchmarkReport, type TwoAxisBenchmarkReport } from "../src/two-axis-benchmark.js";
import { compareTwoAxisBenchmarkReports, TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT } from "../src/two-axis-thresholds.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures");
const neutralFixtureRoot = join(import.meta.dirname, "fixtures-neutral");

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rsp-two-axis-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("rsp two-axis benchmark report", () => {
  it("reports shipped modes plus brief and terse token deltas with fidelity", async () => {
    const report = await buildTwoAxisBenchmarkReport({ fixtureRoot });

    expect(report.corpus).toMatchObject({
      label: "home",
      fixture_count: 35,
      large_output_filters: ["automatic:output", "cat:file", "exec:--", "git:diff", "git:log", "vitest:run"],
    });
    expect(report.corpus.provenance[0]).toContain("Repo-authored");
    expect(report.corpus.filters).toEqual([
      "automatic:output",
      "cargo:test",
      "cat:file",
      "exec:--",
      "gh:issue",
      "gh:pr",
      "gh:run",
      "git:blame",
      "git:branch",
      "git:commit",
      "git:diff",
      "git:log",
      "git:push",
      "git:show",
      "git:status",
      "vitest:run",
    ]);
    expect(report.filters.find((row) => row.filter === "automatic:output")).toMatchObject({
      fixture_count: 1,
      mode: "active",
      brief: { fidelity_pass_rate_pct: 100 },
      terse: { fidelity_pass_rate_pct: 100 },
    });
    expect(report.filters.find((row) => row.filter === "automatic:output")?.brief.median_delta_pct).toBeGreaterThan(0);
    expect(report.method.tokenizer).toBe("js-tiktoken:gpt-4o");
    expect(report.method.oracle_ceiling_source).toBe("fixture-adjacent hand-reviewed compact TOON renderings");
    expect(report.method.rtk_source).toMatchObject({ kind: "recorded-fixtures", version: expect.stringMatching(/^rtk /) });
    expect(report.method.headroom_source).toMatchObject({
      kind: "recorded-fixtures",
      version: "headroom-ai 0.31.0",
      captured_at: expect.stringMatching(/^2026-07-13T/),
    });
    expect(report.method.external_claims[0]).toMatchObject({ status: "cited_unverified", measured_locally: false });

    const exec = report.filters.find((row) => row.filter === "exec:--");
    expect(exec).toMatchObject({
      fixture_count: 3,
      mode: "active",
      brief: { fidelity_pass_rate_pct: 100 },
      terse: { fidelity_pass_rate_pct: 100 },
      rtk: { coverage: "not-covered", label: "rtk: not-covered" },
      headroom: { coverage: "not-covered", label: "headroom: not-covered" },
    });
    expect(exec?.oracle_capture.rsp.capture_pct).toBeGreaterThan(0);

    const ghPr = report.filters.find((row) => row.filter === "gh:pr");
    expect(ghPr).toMatchObject({
      fixture_count: 3,
      rtk: { coverage: "not-covered", label: "rtk: not-covered" },
      headroom: { fidelity_pass_rate_pct: 100, source: "recorded" },
    });

    const gitCommit = report.filters.find((row) => row.filter === "git:commit");
    expect(gitCommit).toMatchObject({
      mode: "passthrough",
      raw: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      brief: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      terse: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      rtk: { fidelity_pass_rate_pct: 100, source: "recorded" },
      headroom: { fidelity_pass_rate_pct: 100, source: "recorded" },
      oracle_capture: {
        raw: { source: "recorded" },
        rsp: { source: "measured" },
        headroom: { source: "recorded" },
        oracle_ceiling: { source: "fixture-oracle", capture_pct: 100 },
      },
      hypothetical_active: {
        brief: { source: "measured" },
        terse: { source: "measured" },
      },
    });
    expect(typeof gitCommit?.brief.median_delta_pct).toBe("number");
    expect(gitCommit?.oracle_capture.oracle_ceiling.token_count).toBeGreaterThan(1);
    expect(gitCommit?.oracle_capture.rsp.capture_pct).toBeLessThanOrEqual(100);

    const catFile = report.filters.find((row) => row.filter === "cat:file");
    expect(catFile).toMatchObject({
      fixture_count: 1,
      mode: "active",
      brief: { fidelity_pass_rate_pct: 100 },
      terse: { fidelity_pass_rate_pct: 100 },
    });

    const vitest = report.filters.find((row) => row.filter === "vitest:run");
    expect(vitest).toMatchObject({
      mode: "active",
      fixture_count: 6,
      brief: { fidelity_pass_rate_pct: 100 },
      terse: { fidelity_pass_rate_pct: 100 },
      headroom: { fidelity_pass_rate_pct: 83.3, source: "recorded" },
    });
    expect(vitest?.terse.median_delta_pct).toBeGreaterThanOrEqual(vitest?.brief.median_delta_pct ?? 0);

    expect(report.filters.find((row) => row.filter === "git:diff")).toMatchObject({ fixture_count: 2 });
    expect(report.filters.find((row) => row.filter === "git:log")).toMatchObject({ fixture_count: 2 });
    expect(report.filters.find((row) => row.filter === "git:blame")).toMatchObject({ fixture_count: 1 });
    expect(report.filters.find((row) => row.filter === "git:branch")).toMatchObject({ fixture_count: 1 });
    expect(report.filters.find((row) => row.filter === "git:show")).toMatchObject({ fixture_count: 1 });

    expect(report.parity).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "cargo-test", filter: "cargo:test", rsp_fidelity_pass_rate_pct: 100 }),
      expect.objectContaining({ domain: "git-commit", filter: "git:commit", rsp_fidelity_pass_rate_pct: 100 }),
    ]));
    expect(report.anti_suppression_audit).toHaveLength(report.corpus.filters.length * 2);
    expect(report.anti_suppression_audit.map((row) => `${row.filter}:${row.level}`).sort()).toEqual(
      report.corpus.filters.flatMap((filter) => [`${filter}:brief`, `${filter}:terse`]).sort(),
    );
    expect(report.anti_suppression_audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ filter: "git:commit", level: "brief", audited: "fixed" }),
      expect.objectContaining({ filter: "git:commit", level: "terse", audited: "fixed" }),
      expect.objectContaining({ filter: "git:push", level: "brief", audited: "fixed" }),
      expect.objectContaining({ filter: "git:push", level: "terse", audited: "fixed" }),
      expect.objectContaining({ filter: "gh:pr", level: "brief", audited: "justified" }),
      expect.objectContaining({ filter: "git:status", level: "terse", audited: "justified" }),
    ]));

    const decoded = decode(report.toon);
    expect(decoded).toMatchObject({
      benchmark: "rsp-two-axis",
      corpus: { fixture_count: report.corpus.fixture_count },
      aggregate: { fixture_count: report.corpus.fixture_count },
    });
    expect(report.aggregate.oracle_ceiling.capture_pct).toBe(100);
    expect(report.aggregate.raw.token_count).toBeGreaterThan(report.aggregate.oracle_ceiling.token_count);
    expect(report.aggregate.headroom.source).toBe("recorded");
    expect(report.quality_corpora.map((row) => row.corpus)).toEqual([
      "pre-existing-quality",
      "anomaly",
      "mixed-content",
      "json-outlier",
    ]);
    expect(report.quality_corpora.find((row) => row.corpus === "anomaly")).toMatchObject({
      fixture_count: 1,
      filters: ["exec:--"],
      oracle_capture: {
        raw: { token_count: expect.any(Number) },
        rsp: { token_count: expect.any(Number), source: "measured" },
        oracle_ceiling: { source: "fixture-oracle" },
      },
    });
    expect(report.end_task_parity).toEqual(expect.arrayContaining([
      expect.objectContaining({
        fixture: "exec-midstream-anomaly",
        task: "oracle preserves planted mid-stream structural outlier",
        same_answer: true,
      }),
      expect.objectContaining({
        fixture: "exec-json-array-crusher",
        task: "crusher keeps numeric value outlier",
        raw_answer: 7,
        rsp_answer: 7,
        same_answer: true,
      }),
      expect.objectContaining({
        fixture: "exec-router-mixed-content",
        task: "router degrades mixed ambiguous content to untyped fallback",
        raw_answer: "untyped",
        rsp_answer: "untyped",
        same_answer: true,
      }),
      expect.objectContaining({
        fixture: "pr-list-default",
        task: "which PR is first?",
        same_answer: true,
      }),
      expect.objectContaining({
        fixture: "vitest-many-failures",
        task: "how many failed?",
        same_answer: true,
      }),
    ]));
  });

  it("writes a reproducible TOON artifact and matching human summary", async () => {
    const root = await tempRoot();
    const toonPath = join(root, "two-axis.toon");
    const summaryPath = join(root, "two-axis.md");

    const report = await writeTwoAxisBenchmarkReport({ fixtureRoot, toonPath, summaryPath });

    await expect(readFile(toonPath, "utf8")).resolves.toBe(report.toon);
    await expect(readFile(summaryPath, "utf8")).resolves.toBe(renderTwoAxisSummary(report));
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("Corpus: home");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("Corpus provenance:");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | Headroom tokens | oracle tokens | rsp capture | RTK capture | Headroom capture | brief shipped delta | brief fidelity-first score | terse shipped delta | terse fidelity-first score | RTK fidelity-first score | Headroom fidelity-first score |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| gh:pr |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("rtk: not-covered");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("Headroom baseline is replayed from checked-in recorded fixtures only");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("Aggregate oracle ceiling:");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| Corpus | Fixtures | Filters | raw tokens | rsp tokens | Headroom tokens | oracle tokens | rsp capture | Headroom capture |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| anomaly | 1 | exec:-- |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| End-task parity probe | Fixture | Raw answer | rsp summary answer | Same answer |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| crusher keeps numeric value outlier | exec-json-array-crusher | 7 | 7 | yes |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| Anti-suppression audit | Level | Verdict | Note |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| git:commit | brief | audited: fixed |");
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| git:push | terse | audited: fixed |");
  });

  it("can generate an additive neutral third-party corpus without default home-corpus large-output requirements", async () => {
    const report = await buildTwoAxisBenchmarkReport({
      fixtureRoot: neutralFixtureRoot,
      corpusLabel: "neutral-third-party",
      corpusProvenance: [
        "Public run metadata from vitest-dev/vitest Actions run 29274168273 and rust-lang/cargo Actions run 29195830177.",
        "Git machine output from public nodejs/node and rust-lang/rust repository history captured on 2026-07-13.",
        "Cargo JSON message output follows the published --message-format=json contract with third-party crate-style test names.",
      ],
      requireLargeOutputFixtures: false,
    });

    expect(report.corpus).toMatchObject({
      label: "neutral-third-party",
      fixture_count: 5,
      large_output_filters: ["git:diff"],
    });
    expect(report.corpus.filters).toEqual(["cargo:test", "gh:run", "git:commit", "git:diff", "git:log"]);
    expect(report.corpus.provenance).toHaveLength(3);
    expect(report.filters.find((row) => row.filter === "gh:run")).toMatchObject({
      fixture_count: 1,
      headroom: { fidelity_pass_rate_pct: 100, source: "recorded" },
    });
    expect(report.filters.find((row) => row.filter === "git:diff")).toMatchObject({
      fixture_count: 1,
      rtk: { fidelity_pass_rate_pct: 100, source: "recorded" },
    });
    expect(report.parity).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "cargo-test", filter: "cargo:test" }),
      expect.objectContaining({ domain: "git-commit", filter: "git:commit" }),
    ]));
    expect(renderTwoAxisSummary(report)).toContain("Corpus: neutral-third-party");
    expect(renderTwoAxisSummary(report)).toContain("vitest-dev/vitest Actions run 29274168273");
  });

  it("flags synthetic shipped token regressions beyond the threshold", async () => {
    const baseline = await buildTwoAxisBenchmarkReport({ fixtureRoot });
    const current = structuredClone(baseline) as TwoAxisBenchmarkReport;
    const row = current.filters.find((candidate) => candidate.filter === "vitest:run");
    expect(row).toBeDefined();
    row!.brief.median_delta_pct -= TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT + 0.1;

    expect(compareTwoAxisBenchmarkReports(baseline, current)).toEqual([
      expect.objectContaining({
        kind: "token-regression",
        filter: "vitest:run",
        axis: "brief",
      }),
    ]);
  });
});
