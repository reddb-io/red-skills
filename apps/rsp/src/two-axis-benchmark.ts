import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { discoverFidelityFixtures, runFidelityFixture, type FidelityFixture } from "./fidelity.js";
import { RspElisionStore } from "./elision-store.js";

export interface TwoAxisBenchmarkOptions {
  fixtureRoot?: string;
}

export interface WriteTwoAxisBenchmarkOptions extends TwoAxisBenchmarkOptions {
  toonPath?: string;
  summaryPath?: string;
}

export interface BaselineAxis {
  median_delta_pct: number;
  p90_delta_pct: number;
  fidelity_pass_rate_pct: number;
  source: "recorded" | "measured";
}

export interface TwoAxisFilterRow {
  filter: string;
  fixture_count: number;
  raw: BaselineAxis;
  rsp: BaselineAxis;
  rtk: BaselineAxis;
}

export interface TwoAxisParityRow {
  domain: "cargo-test" | "git-commit";
  filter: string;
  rsp_median_delta_pct: number;
  rtk_median_delta_pct: number;
  rsp_fidelity_pass_rate_pct: number;
  rtk_fidelity_pass_rate_pct: number;
  parity_gate: "pass" | "fail";
}

export interface TwoAxisBenchmarkReport {
  benchmark: "rsp-two-axis";
  corpus: {
    fixture_count: number;
    filters: string[];
  };
  method: {
    tokenizer: "js-tiktoken:gpt-4o";
    raw_source: "recorded-command-output";
    rsp_source: "fixture-renderer";
    rtk_source: {
      kind: "recorded-fixtures";
      version: string;
      captured_at: string;
    };
    external_claims: ExternalClaim[];
  };
  filters: TwoAxisFilterRow[];
  parity: TwoAxisParityRow[];
  summary: string;
  toon: string;
}

interface ExternalClaim {
  layer: string;
  claim: string;
  status: "cited_unverified";
  measured_locally: false;
  note: string;
}

interface RtkBaselineFixture {
  name: string;
  stdout: string;
  fidelity_assertions_passed: boolean;
}

interface RtkBaselines {
  version: string;
  captured_at: string;
  fixtures: RtkBaselineFixture[];
}

interface FixtureMeasurement {
  fixture: FidelityFixture;
  filter: string;
  rawDelta: number;
  rawFidelity: boolean;
  rspDelta: number;
  rspFidelity: boolean;
  rtkDelta: number;
  rtkFidelity: boolean;
}

const tokenizer = encodingForModel("gpt-4o");
const DEFAULT_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const DEFAULT_ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.toon");
const DEFAULT_SUMMARY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.md");

export async function buildTwoAxisBenchmarkReport(options: TwoAxisBenchmarkOptions = {}): Promise<TwoAxisBenchmarkReport> {
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const fixtures = await discoverBenchmarkFixtures(fixtureRoot);
  const rtk = await readRtkBaselines(join(fixtureRoot, "rtk", "baselines.json"));
  const byName = new Map(rtk.fixtures.map((fixture) => [fixture.name, fixture]));
  const measurements: FixtureMeasurement[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "rsp-two-axis-store-"));
  const store = await RspElisionStore.open({ uri: `file://${join(tempRoot, "red.rdb")}` });
  try {
    for (const fixture of fixtures) {
      const rtkFixture = byName.get(fixture.name);
      if (!rtkFixture) throw new Error(`missing recorded RTK baseline for ${fixture.name}`);
      const rsp = await runFidelityFixture(fixture, { level: "lossless", store });
      measurements.push({
        fixture,
        filter: filterName(fixture),
        rawDelta: 0,
        rawFidelity: true,
        rspDelta: rsp.tokenDelta,
        rspFidelity: rsp.status === fixture.recorded.status && rsp.assertionFailures.length === 0,
        rtkDelta: tokenDelta(fixture.recorded.stdout, rtkFixture.stdout),
        rtkFidelity: rtkFixture.fidelity_assertions_passed,
      });
    }
  } finally {
    await store.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  const rows = [...groupByFilter(measurements).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filter, rows]) => ({
    filter,
    fixture_count: rows.length,
    raw: axis(rows.map((row) => row.rawDelta), rows.map((row) => row.rawFidelity), "recorded"),
    rsp: axis(rows.map((row) => row.rspDelta), rows.map((row) => row.rspFidelity), "measured"),
    rtk: axis(rows.map((row) => row.rtkDelta), rows.map((row) => row.rtkFidelity), "recorded"),
  }));
  const parity = buildParity(rows);
  const payload = {
    benchmark: "rsp-two-axis",
    corpus: {
      fixture_count: measurements.length,
      filters: rows.map((row) => row.filter),
    },
    method: {
      tokenizer: "js-tiktoken:gpt-4o",
      raw_source: "recorded-command-output",
      rsp_source: "fixture-renderer",
      rtk_source: {
        kind: "recorded-fixtures",
        version: rtk.version,
        captured_at: rtk.captured_at,
      },
      external_claims: externalClaims(),
    },
    filters: rows,
    parity,
    summary: `${measurements.length} fixtures, ${rows.length} filters; tokens and fidelity reported together`,
  } satisfies Omit<TwoAxisBenchmarkReport, "toon">;

  return { ...payload, toon: encode(payload as unknown as JsonObject) };
}

export async function writeTwoAxisBenchmarkReport(options: WriteTwoAxisBenchmarkOptions = {}): Promise<TwoAxisBenchmarkReport> {
  const report = await buildTwoAxisBenchmarkReport(options);
  const toonPath = options.toonPath ?? DEFAULT_ARTIFACT_PATH;
  const summaryPath = options.summaryPath ?? DEFAULT_SUMMARY_PATH;
  await mkdir(dirname(toonPath), { recursive: true });
  await mkdir(dirname(summaryPath), { recursive: true });
  await writeFile(toonPath, report.toon, "utf8");
  await writeFile(summaryPath, renderTwoAxisSummary(report), "utf8");
  return report;
}

export function renderTwoAxisSummary(report: TwoAxisBenchmarkReport): string {
  const lines = [
    `rsp two-axis benchmark: ${report.corpus.fixture_count} fixtures across ${report.filters.length} filters`,
    "",
    "| Filter | Fixtures | rsp median/p90 token delta | rsp fidelity | RTK median/p90 token delta | RTK fidelity |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.filters.map((row) =>
      `| ${row.filter} | ${row.fixture_count} | ${fmt(row.rsp.median_delta_pct)}/${fmt(row.rsp.p90_delta_pct)}% | ${fmt(row.rsp.fidelity_pass_rate_pct)}% | ${fmt(row.rtk.median_delta_pct)}/${fmt(row.rtk.p90_delta_pct)}% | ${fmt(row.rtk.fidelity_pass_rate_pct)}% |`
    ),
    "",
    "| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |",
    "| --- | --- | --- | ---: | ---: |",
    ...report.parity.map((row) =>
      `| ${row.domain} | ${row.filter} | ${row.parity_gate} | ${fmt(row.rsp_fidelity_pass_rate_pct)}% | ${fmt(row.rtk_fidelity_pass_rate_pct)}% |`
    ),
    "",
    "RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.",
    "External context-optimization claims are cited literature only and were not locally reproduced.",
    "",
  ];
  return lines.join("\n");
}

async function discoverBenchmarkFixtures(fixtureRoot: string): Promise<FidelityFixture[]> {
  const roots = [join(fixtureRoot, "git"), join(fixtureRoot, "test-runners")];
  const groups = await Promise.all(roots.map((root) => discoverFidelityFixtures(root)));
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
}

async function readRtkBaselines(path: string): Promise<RtkBaselines> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isRtkBaselines(parsed)) throw new Error(`invalid RTK baseline fixture: ${path}`);
  return parsed;
}

function buildParity(rows: readonly TwoAxisFilterRow[]): TwoAxisParityRow[] {
  return [
    parityRow("cargo-test", "cargo:test", rows),
    parityRow("git-commit", "git:commit", rows),
  ];
}

function parityRow(domain: TwoAxisParityRow["domain"], filter: string, rows: readonly TwoAxisFilterRow[]): TwoAxisParityRow {
  const row = rows.find((candidate) => candidate.filter === filter);
  if (!row) throw new Error(`missing parity filter ${filter}`);
  const pass = row.rsp.fidelity_pass_rate_pct >= row.rtk.fidelity_pass_rate_pct &&
    row.rsp.median_delta_pct >= row.rtk.median_delta_pct;
  return {
    domain,
    filter,
    rsp_median_delta_pct: row.rsp.median_delta_pct,
    rtk_median_delta_pct: row.rtk.median_delta_pct,
    rsp_fidelity_pass_rate_pct: row.rsp.fidelity_pass_rate_pct,
    rtk_fidelity_pass_rate_pct: row.rtk.fidelity_pass_rate_pct,
    parity_gate: pass ? "pass" : "fail",
  };
}

function groupByFilter(measurements: readonly FixtureMeasurement[]): Map<string, FixtureMeasurement[]> {
  const out = new Map<string, FixtureMeasurement[]>();
  for (const measurement of measurements) {
    out.set(measurement.filter, [...(out.get(measurement.filter) ?? []), measurement]);
  }
  return out;
}

function axis(deltas: readonly number[], fidelity: readonly boolean[], source: BaselineAxis["source"]): BaselineAxis {
  return {
    median_delta_pct: round(median(deltas)),
    p90_delta_pct: round(percentile(deltas, 90)),
    fidelity_pass_rate_pct: round((fidelity.filter(Boolean).length / fidelity.length) * 100),
    source,
  };
}

function filterName(fixture: FidelityFixture): string {
  return fixture.command.slice(0, 2).join(":");
}

function tokenDelta(original: string, filtered: string): number {
  const before = tokenizer.encode(original).length;
  const after = tokenizer.encode(filtered).length;
  if (before === 0) return 0;
  return ((before - after) / before) * 100;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function percentile(values: readonly number[], pct: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const index = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))] ?? 0;
}

function round(value: number): number {
  return Number(value.toFixed(1));
}

function fmt(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function externalClaims(): ExternalClaim[] {
  return [{
    layer: "external-context-optimization",
    claim: "Host/provider conversation-history optimization and cache-prefix alignment can reduce repeated context spend.",
    status: "cited_unverified",
    measured_locally: false,
    note: "The rsp benchmark measures shell-output fixtures only; external history-layer claims are not reproduced here.",
  }];
}

function isRtkBaselines(value: unknown): value is RtkBaselines {
  return isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.captured_at === "string" &&
    Array.isArray(value.fixtures) &&
    value.fixtures.every((fixture) =>
      isRecord(fixture) &&
      typeof fixture.name === "string" &&
      typeof fixture.stdout === "string" &&
      typeof fixture.fidelity_assertions_passed === "boolean"
    );
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
