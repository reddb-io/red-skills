import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { afterEach, describe, expect, it } from "vitest";
import { buildTwoAxisBenchmarkReport, renderTwoAxisSummary, writeTwoAxisBenchmarkReport } from "../src/two-axis-benchmark.js";

const roots: string[] = [];
const fixtureRoot = join(import.meta.dirname, "fixtures");

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

    expect(report.corpus.fixture_count).toBeGreaterThanOrEqual(17);
    expect(report.method.tokenizer).toBe("js-tiktoken:gpt-4o");
    expect(report.method.rtk_source).toMatchObject({ kind: "recorded-fixtures", version: expect.stringMatching(/^rtk /) });
    expect(report.method.external_claims[0]).toMatchObject({ status: "cited_unverified", measured_locally: false });

    const gitCommit = report.filters.find((row) => row.filter === "git:commit");
    expect(gitCommit).toMatchObject({
      mode: "passthrough",
      raw: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      brief: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      terse: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      rtk: { fidelity_pass_rate_pct: 100, source: "recorded" },
      hypothetical_active: {
        brief: { source: "measured" },
        terse: { source: "measured" },
      },
    });
    expect(typeof gitCommit?.brief.median_delta_pct).toBe("number");

    const vitest = report.filters.find((row) => row.filter === "vitest:run");
    expect(vitest).toMatchObject({
      mode: "active",
      brief: { fidelity_pass_rate_pct: 100 },
      terse: { fidelity_pass_rate_pct: 100 },
    });
    expect(vitest?.terse.median_delta_pct).toBeGreaterThanOrEqual(vitest?.brief.median_delta_pct ?? 0);

    for (const filter of ["git:diff", "git:log", "vitest:run"]) {
      expect(report.corpus.large_output_filters).toContain(filter);
    }

    expect(report.parity).toEqual(expect.arrayContaining([
      expect.objectContaining({ domain: "cargo-test", filter: "cargo:test", rsp_fidelity_pass_rate_pct: 100 }),
      expect.objectContaining({ domain: "git-commit", filter: "git:commit", rsp_fidelity_pass_rate_pct: 100 }),
    ]));

    const decoded = decode(report.toon);
    expect(decoded).toMatchObject({ benchmark: "rsp-two-axis", corpus: { fixture_count: report.corpus.fixture_count } });
  });

  it("writes a reproducible TOON artifact and matching human summary", async () => {
    const root = await tempRoot();
    const toonPath = join(root, "two-axis.toon");
    const summaryPath = join(root, "two-axis.md");

    const report = await writeTwoAxisBenchmarkReport({ fixtureRoot, toonPath, summaryPath });

    await expect(readFile(toonPath, "utf8")).resolves.toBe(report.toon);
    await expect(readFile(summaryPath, "utf8")).resolves.toBe(renderTwoAxisSummary(report));
    await expect(readFile(summaryPath, "utf8")).resolves.toContain("| Filter | Mode | Fixtures | brief shipped delta | brief fidelity | brief hyp-active delta | terse shipped delta | terse fidelity | terse hyp-active delta | RTK median/p90 token delta | RTK fidelity |");
  });
});
