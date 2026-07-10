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
  it("reports token deltas and fidelity for raw, rsp, and recorded RTK baselines", async () => {
    const report = await buildTwoAxisBenchmarkReport({ fixtureRoot });

    expect(report.corpus.fixture_count).toBeGreaterThanOrEqual(12);
    expect(report.method.tokenizer).toBe("js-tiktoken:gpt-4o");
    expect(report.method.rtk_source).toMatchObject({ kind: "recorded-fixtures", version: expect.stringMatching(/^rtk /) });
    expect(report.method.external_claims[0]).toMatchObject({ status: "cited_unverified", measured_locally: false });

    const gitCommit = report.filters.find((row) => row.filter === "git:commit");
    expect(gitCommit).toMatchObject({
      raw: { median_delta_pct: 0, p90_delta_pct: 0, fidelity_pass_rate_pct: 100 },
      rsp: { fidelity_pass_rate_pct: 100 },
      rtk: { fidelity_pass_rate_pct: 100, source: "recorded" },
    });
    expect(typeof gitCommit?.rsp.median_delta_pct).toBe("number");

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
  });
});
