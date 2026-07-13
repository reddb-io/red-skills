import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { discoverFidelityFixtures, runFidelityFixture, type FidelityFixture } from "./fidelity.js";
import { RspElisionStore } from "./elision-store.js";
import { evaluateAdmission, type AdmissionFilterReport } from "./admission.js";

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

export interface NotCoveredAxis {
  coverage: "not-covered";
  label: string;
  source: "not-covered";
}

export type ComparatorAxis = BaselineAxis | NotCoveredAxis;

export interface TokenCaptureAxis {
  token_count: number;
  capture_pct: number;
  source: "recorded" | "measured" | "fixture-oracle";
}

export interface NotCoveredTokenCaptureAxis {
  coverage: "not-covered";
  label: string;
  source: "not-covered";
}

export type ComparatorTokenCaptureAxis = TokenCaptureAxis | NotCoveredTokenCaptureAxis;

export interface OracleCaptureRow {
  raw: TokenCaptureAxis;
  rsp: TokenCaptureAxis;
  terse: TokenCaptureAxis;
  rtk: ComparatorTokenCaptureAxis;
  oracle_ceiling: TokenCaptureAxis;
}

export interface TwoAxisFilterRow {
  filter: string;
  mode: "active" | "passthrough";
  fixture_count: number;
  raw: BaselineAxis;
  brief: BaselineAxis;
  terse: BaselineAxis;
  rtk: ComparatorAxis;
  oracle_capture: OracleCaptureRow;
  /** Measured delta if this filter were forced active; equals brief/terse for active filters, non-zero for passthrough. */
  hypothetical_active: {
    brief: BaselineAxis;
    terse: BaselineAxis;
  };
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
    large_output_filters: string[];
  };
  method: {
    tokenizer: "js-tiktoken:gpt-4o";
    raw_source: "recorded-command-output";
    rsp_source: "fixture-renderer";
    oracle_ceiling_source: "fixture-adjacent hand-reviewed compact TOON renderings";
    rtk_source: {
      kind: "recorded-fixtures";
      version: string;
      captured_at: string;
    };
    external_claims: ExternalClaim[];
  };
  filters: TwoAxisFilterRow[];
  aggregate: OracleCaptureRow & { fixture_count: number };
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
  briefDelta: number;
  briefFidelity: boolean;
  terseDelta: number;
  terseFidelity: boolean;
  rtkDelta?: number;
  rtkFidelity?: boolean;
  rawTokens: number;
  rspTokens: number;
  terseTokens: number;
  rtkTokens?: number;
  oracleTokens: number;
}

const tokenizer = encodingForModel("gpt-4o");
const ADMISSION_THRESHOLD_PCT = 60;
const DEFAULT_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const DEFAULT_ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.toon");
const DEFAULT_SUMMARY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.md");
const REQUIRED_LARGE_OUTPUT_FIXTURES = [
  "diff-large-numstat",
  "log-large-history",
  "vitest-large-green",
  "vitest-many-failures",
] as const;

export async function buildTwoAxisBenchmarkReport(options: TwoAxisBenchmarkOptions = {}): Promise<TwoAxisBenchmarkReport> {
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const fixtures = await discoverBenchmarkFixtures(fixtureRoot);
  assertRequiredLargeOutputFixtures(fixtures);
  const admission = evaluateAdmission(fixtures, { thresholdPct: ADMISSION_THRESHOLD_PCT });
  const admissionByFilter = new Map(admission.filters.map((row) => [row.filter, row]));
  const rtk = await readRtkBaselines(join(fixtureRoot, "rtk", "baselines.json"));
  const byName = new Map(rtk.fixtures.map((fixture) => [fixture.name, fixture]));
  const measurements: FixtureMeasurement[] = [];
  const tempRoot = await mkdtemp(join(tmpdir(), "rsp-two-axis-store-"));
  const store = await RspElisionStore.open({ uri: `file://${join(tempRoot, "red.rdb")}` });
  try {
    for (const fixture of fixtures) {
      const rtkFixture = byName.get(fixture.name);
      const brief = await runFidelityFixture(fixture, { level: "lossless", store });
      const terse = await runFidelityFixture(fixture, { level: "terse", store });
      const active = admissionByFilter.get(filterName(fixture))?.mode === "active";
      const rawTokens = tokenCount(fixture.recorded.stdout);
      const briefTokens = tokenCount(brief.stdout.toString("utf8"));
      const terseTokens = tokenCount(terse.stdout.toString("utf8"));
      measurements.push({
        fixture,
        filter: filterName(fixture),
        rawDelta: 0,
        rawFidelity: true,
        briefDelta: brief.tokenDelta,
        briefFidelity: brief.status === fixture.recorded.status && brief.assertionFailures.length === 0,
        terseDelta: terse.tokenDelta,
        terseFidelity: terse.status === fixture.recorded.status && terse.assertionFailures.length === 0,
        rtkDelta: rtkFixture ? tokenDelta(fixture.recorded.stdout, rtkFixture.stdout) : undefined,
        rtkFidelity: rtkFixture?.fidelity_assertions_passed,
        rawTokens,
        rspTokens: active ? briefTokens : rawTokens,
        terseTokens: active ? terseTokens : rawTokens,
        rtkTokens: rtkFixture ? tokenCount(rtkFixture.stdout) : undefined,
        oracleTokens: await oracleTokenCount(fixture),
      });
    }
  } finally {
    await store.close();
    await rm(tempRoot, { recursive: true, force: true });
  }

  const rows = [...groupByFilter(measurements).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filter, rows]) =>
    filterRow(filter, rows, admissionByFilter.get(filter))
  );
  const parity = buildParity(rows);
  const payload = {
    benchmark: "rsp-two-axis",
    corpus: {
      fixture_count: measurements.length,
      filters: rows.map((row) => row.filter),
      large_output_filters: largeOutputFilters(measurements),
    },
    method: {
      tokenizer: "js-tiktoken:gpt-4o",
      raw_source: "recorded-command-output",
      rsp_source: "fixture-renderer",
      oracle_ceiling_source: "fixture-adjacent hand-reviewed compact TOON renderings",
      rtk_source: {
        kind: "recorded-fixtures",
        version: rtk.version,
        captured_at: rtk.captured_at,
      },
      external_claims: externalClaims(),
    },
    filters: rows,
    aggregate: aggregateOracleCapture(measurements),
    parity,
    summary: `${measurements.length} fixtures, ${rows.length} filters; shipped modes apply admission threshold ${ADMISSION_THRESHOLD_PCT}%`,
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
    `Production mode uses admission threshold ${ADMISSION_THRESHOLD_PCT}%; passthrough filters count as 0% token delta because rsp returns the original command output.`,
    "",
    "| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | oracle tokens | rsp capture | RTK capture | brief shipped delta | brief fidelity | terse shipped delta | terse fidelity |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.filters.map((row) =>
      `| ${row.filter} | ${row.mode} | ${row.fixture_count} | ${row.oracle_capture.raw.token_count} | ${row.oracle_capture.rsp.token_count} | ${fmtComparatorTokenCount(row.oracle_capture.rtk)} | ${row.oracle_capture.oracle_ceiling.token_count} | ${fmt(row.oracle_capture.rsp.capture_pct)}% | ${fmtComparatorCapture(row.oracle_capture.rtk)} | ${fmt(row.brief.median_delta_pct)}/${fmt(row.brief.p90_delta_pct)}% | ${fmt(row.brief.fidelity_pass_rate_pct)}% | ${fmt(row.terse.median_delta_pct)}/${fmt(row.terse.p90_delta_pct)}% | ${fmt(row.terse.fidelity_pass_rate_pct)}% |`
    ),
    "",
    `Aggregate oracle ceiling: raw ${report.aggregate.raw.token_count} tokens (${fmt(report.aggregate.raw.capture_pct)}% capture), rsp ${report.aggregate.rsp.token_count} tokens (${fmt(report.aggregate.rsp.capture_pct)}% capture), RTK ${fmtComparatorTokenCount(report.aggregate.rtk)} tokens (${fmtComparatorCapture(report.aggregate.rtk)} capture), oracle ${report.aggregate.oracle_ceiling.token_count} tokens.`,
    "",
    `Large-output filters: ${report.corpus.large_output_filters.join(", ") || "none"}.`,
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
  const roots = [join(fixtureRoot, "gh"), join(fixtureRoot, "git"), join(fixtureRoot, "test-runners")];
  const groups = await Promise.all(roots.map((root) => discoverFidelityFixtures(root)));
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
}

function assertRequiredLargeOutputFixtures(fixtures: readonly FidelityFixture[]): void {
  const byName = new Map(fixtures.map((fixture) => [fixture.name, fixture]));
  for (const name of REQUIRED_LARGE_OUTPUT_FIXTURES) {
    const fixture = byName.get(name);
    if (!fixture) throw new Error(`benchmark corpus missing large-output fixture: ${name}`);
    if (fixture.large_output !== true) throw new Error(`benchmark corpus fixture is not marked large_output: ${name}`);
  }
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
  const rtk = coveredComparatorAxis("rtk", filter, row.rtk);
  const pass = row.brief.fidelity_pass_rate_pct >= rtk.fidelity_pass_rate_pct &&
    row.brief.median_delta_pct >= rtk.median_delta_pct;
  return {
    domain,
    filter,
    rsp_median_delta_pct: row.brief.median_delta_pct,
    rtk_median_delta_pct: rtk.median_delta_pct,
    rsp_fidelity_pass_rate_pct: row.brief.fidelity_pass_rate_pct,
    rtk_fidelity_pass_rate_pct: rtk.fidelity_pass_rate_pct,
    parity_gate: pass ? "pass" : "fail",
  };
}

function filterRow(filter: string, rows: readonly FixtureMeasurement[], admission?: AdmissionFilterReport): TwoAxisFilterRow {
  const mode = admission?.mode ?? "passthrough";
  const active = mode === "active";
  const measuredBrief = axis(rows.map((row) => row.briefDelta), rows.map((row) => row.briefFidelity), "measured");
  const measuredTerse = axis(rows.map((row) => row.terseDelta), rows.map((row) => row.terseFidelity), "measured");
  return {
    filter,
    mode,
    fixture_count: rows.length,
    raw: axis(rows.map((row) => row.rawDelta), rows.map((row) => row.rawFidelity), "recorded"),
    brief: active ? measuredBrief : passthroughAxis(rows.length),
    terse: active ? measuredTerse : passthroughAxis(rows.length),
    rtk: comparatorAxis("rtk", rows.map((row) => ({ delta: row.rtkDelta, fidelity: row.rtkFidelity }))),
    oracle_capture: oracleCapture(rows),
    hypothetical_active: { brief: measuredBrief, terse: measuredTerse },
  };
}

function passthroughAxis(count: number): BaselineAxis {
  return axis(Array.from({ length: count }, () => 0), Array.from({ length: count }, () => true), "measured");
}

function largeOutputFilters(measurements: readonly FixtureMeasurement[]): string[] {
  const filters = new Set<string>();
  for (const measurement of measurements) {
    if (measurement.fixture.large_output === true) filters.add(measurement.filter);
  }
  return [...filters].sort((a, b) => a.localeCompare(b));
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

function comparatorAxis(
  label: string,
  rows: readonly { delta?: number; fidelity?: boolean }[],
): ComparatorAxis {
  const covered = rows.filter((row): row is { delta: number; fidelity: boolean } =>
    typeof row.delta === "number" && typeof row.fidelity === "boolean"
  );
  if (covered.length === 0) return notCoveredAxis(label);
  return axis(covered.map((row) => row.delta), covered.map((row) => row.fidelity), "recorded");
}

function oracleCapture(rows: readonly FixtureMeasurement[]): OracleCaptureRow {
  const rawTokens = sum(rows.map((row) => row.rawTokens));
  const oracleTokens = sum(rows.map((row) => row.oracleTokens));
  return {
    raw: tokenCapture(rawTokens, rawTokens, oracleTokens, "recorded"),
    rsp: tokenCapture(sum(rows.map((row) => row.rspTokens)), rawTokens, oracleTokens, "measured"),
    terse: tokenCapture(sum(rows.map((row) => row.terseTokens)), rawTokens, oracleTokens, "measured"),
    rtk: comparatorTokenCapture("rtk", rows.map((row) => ({ rawTokens: row.rawTokens, tokens: row.rtkTokens, oracleTokens: row.oracleTokens }))),
    oracle_ceiling: tokenCapture(oracleTokens, rawTokens, oracleTokens, "fixture-oracle"),
  };
}

function aggregateOracleCapture(rows: readonly FixtureMeasurement[]): OracleCaptureRow & { fixture_count: number } {
  return { fixture_count: rows.length, ...oracleCapture(rows) };
}

function tokenCapture(
  token_count: number,
  rawTokens: number,
  oracleTokens: number,
  source: TokenCaptureAxis["source"],
): TokenCaptureAxis {
  return {
    token_count,
    capture_pct: capturePct(rawTokens, oracleTokens, token_count),
    source,
  };
}

function comparatorTokenCapture(
  label: string,
  rows: readonly { rawTokens: number; tokens?: number; oracleTokens: number }[],
): ComparatorTokenCaptureAxis {
  const covered = rows.filter((row): row is { rawTokens: number; tokens: number; oracleTokens: number } => typeof row.tokens === "number");
  if (covered.length === 0) return notCoveredTokenCaptureAxis(label);
  return tokenCapture(
    sum(covered.map((row) => row.tokens)),
    sum(covered.map((row) => row.rawTokens)),
    sum(covered.map((row) => row.oracleTokens)),
    "recorded",
  );
}

function notCoveredTokenCaptureAxis(label: string): NotCoveredTokenCaptureAxis {
  return {
    coverage: "not-covered",
    label: `${label}: not-covered`,
    source: "not-covered",
  };
}

function notCoveredAxis(label: string): NotCoveredAxis {
  return {
    coverage: "not-covered",
    label: `${label}: not-covered`,
    source: "not-covered",
  };
}

function coveredComparatorAxis(label: string, filter: string, value: ComparatorAxis): BaselineAxis {
  if (value.source === "not-covered") throw new Error(`${label} baseline not covered for parity filter ${filter}`);
  return value;
}

function filterName(fixture: FidelityFixture): string {
  return fixture.command.slice(0, 2).join(":");
}

function tokenDelta(original: string, filtered: string): number {
  const before = tokenCount(original);
  const after = tokenCount(filtered);
  if (before === 0) return 0;
  return ((before - after) / before) * 100;
}

async function oracleTokenCount(fixture: FidelityFixture): Promise<number> {
  const path = join(dirname(fixture.file), `${basename(fixture.file, ".json")}.oracle.toon`);
  const text = await readFile(path, "utf8");
  if (!text.startsWith("# oracle: ")) throw new Error(`oracle ceiling fixture missing preservation comment: ${path}`);
  return tokenCount(text.split("\n").slice(1).join("\n"));
}

function tokenCount(text: string): number {
  return tokenizer.encode(text).length;
}

function capturePct(rawTokens: number, oracleTokens: number, outputTokens: number): number {
  if (oracleTokens === 0) return outputTokens === 0 ? 100 : 0;
  if (outputTokens <= oracleTokens) return round((outputTokens / oracleTokens) * 100);
  if (rawTokens <= oracleTokens) return 0;
  return Math.max(0, round(((rawTokens - outputTokens) / (rawTokens - oracleTokens)) * 100));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
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

function fmtComparatorDelta(value: ComparatorAxis): string {
  if (value.source === "not-covered") return value.label;
  return `${fmt(value.median_delta_pct)}/${fmt(value.p90_delta_pct)}%`;
}

function fmtComparatorFidelity(value: ComparatorAxis): string {
  if (value.source === "not-covered") return value.label;
  return `${fmt(value.fidelity_pass_rate_pct)}%`;
}

function fmtComparatorTokenCount(value: ComparatorTokenCaptureAxis): string {
  if (value.source === "not-covered") return value.label;
  return String(value.token_count);
}

function fmtComparatorCapture(value: ComparatorTokenCaptureAxis): string {
  if (value.source === "not-covered") return value.label;
  return `${fmt(value.capture_pct)}%`;
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
