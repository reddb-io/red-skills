import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { decode, encode, type JsonObject, type JsonValue } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { discoverFidelityFixtures, runFidelityFixture, type FidelityFixture } from "./fidelity.js";
import { contentHandle } from "./elision-store.js";
import type { RspMintStore } from "./git-wrapper.js";
import { evaluateAdmission, type AdmissionFilterReport } from "./admission.js";

export interface TwoAxisBenchmarkOptions {
  fixtureRoot?: string;
  corpusLabel?: string;
  corpusProvenance?: string[];
  requireLargeOutputFixtures?: boolean;
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
  reason?: string;
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
  reason?: string;
  source: "not-covered";
}

export type ComparatorTokenCaptureAxis = TokenCaptureAxis | NotCoveredTokenCaptureAxis;

export interface OracleCaptureRow {
  raw: TokenCaptureAxis;
  rsp: TokenCaptureAxis;
  terse: TokenCaptureAxis;
  rtk: ComparatorTokenCaptureAxis;
  headroom: ComparatorTokenCaptureAxis;
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
  headroom: ComparatorAxis;
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

export interface QualityCorpusRow {
  corpus: "pre-existing-quality" | "anomaly" | "mixed-content" | "json-outlier";
  fixture_count: number;
  filters: string[];
  oracle_capture: OracleCaptureRow;
}

export interface EndTaskParityRow {
  task: string;
  fixture: string;
  raw_answer: JsonValue;
  rsp_answer: JsonValue;
  same_answer: boolean;
}

export interface AntiSuppressionAuditRow {
  filter: string;
  level: "brief" | "terse";
  audited: "ok" | "fixed" | "justified";
  note: string;
}

export interface TwoAxisBenchmarkReport {
  benchmark: "rsp-two-axis";
  corpus: {
    label: string;
    fixture_count: number;
    filters: string[];
    large_output_filters: string[];
    provenance: string[];
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
    headroom_source: {
      kind: "recorded-fixtures";
      version: string;
      captured_at: string;
    };
    external_claims: ExternalClaim[];
  };
  filters: TwoAxisFilterRow[];
  aggregate: OracleCaptureRow & { fixture_count: number };
  quality_corpora: QualityCorpusRow[];
  parity: TwoAxisParityRow[];
  end_task_parity: EndTaskParityRow[];
  anti_suppression_audit: AntiSuppressionAuditRow[];
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

interface HeadroomBaselineFixture {
  name: string;
  coverage: "covered" | "not-covered";
  stdout?: string;
  fidelity_assertions_passed?: boolean;
  not_covered_reason?: string;
  transforms_applied?: string[];
}

interface HeadroomBaselines {
  version: string;
  captured_at: string;
  capture_script: string;
  fixtures: HeadroomBaselineFixture[];
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
  headroomDelta?: number;
  headroomFidelity?: boolean;
  headroomNotCoveredReason?: string;
  rawTokens: number;
  rspTokens: number;
  terseTokens: number;
  rtkTokens?: number;
  headroomTokens?: number;
  oracleTokens: number;
}

interface EndTaskCandidate {
  fixture: string;
  task: string;
  rawAnswer: JsonValue;
  rspAnswer: JsonValue;
  sameAnswer: boolean;
}

const tokenizer = encodingForModel("gpt-4o");
const ADMISSION_THRESHOLD_PCT = 60;
const DEFAULT_FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "tests", "fixtures");
const DEFAULT_ARTIFACT_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.toon");
const DEFAULT_SUMMARY_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "bench", "results", "rsp-two-axis.md");
const REQUIRED_LARGE_OUTPUT_FIXTURES = [
  "automatic-disk-census",
  "diff-large-numstat",
  "exec-midstream-anomaly",
  "log-large-history",
  "vitest-large-green",
  "vitest-many-failures",
] as const;

export async function buildTwoAxisBenchmarkReport(options: TwoAxisBenchmarkOptions = {}): Promise<TwoAxisBenchmarkReport> {
  const fixtureRoot = options.fixtureRoot ?? DEFAULT_FIXTURE_ROOT;
  const fixtures = await discoverBenchmarkFixtures(fixtureRoot);
  if (options.requireLargeOutputFixtures ?? fixtureRoot === DEFAULT_FIXTURE_ROOT) {
    assertRequiredLargeOutputFixtures(fixtures);
  }
  const admission = evaluateAdmission(fixtures, { thresholdPct: ADMISSION_THRESHOLD_PCT });
  const admissionByFilter = new Map(admission.filters.map((row) => [row.filter, row]));
  const rtk = await readRtkBaselines(join(fixtureRoot, "rtk", "baselines.json"));
  const rtkByName = new Map(rtk.fixtures.map((fixture) => [fixture.name, fixture]));
  const headroom = await readHeadroomBaselines(join(fixtureRoot, "headroom", "baselines.json"));
  const headroomByName = new Map(headroom.fixtures.map((fixture) => [fixture.name, fixture]));
  const measurements: FixtureMeasurement[] = [];
  const endTaskCandidates: EndTaskCandidate[] = [];
  // The benchmark measures rendered tokens, not persistence: it replays recorded
  // fixtures offline. Minting content-addressed handles in-process keeps it a
  // pure measurement — no store to own, and no second opener of one (ADR 0126).
  const store: RspMintStore = { mint: async (original, meta) => contentHandle(Buffer.from(original), meta) };
  for (const fixture of fixtures) {
    const rtkFixture = rtkByName.get(fixture.name);
    const headroomFixture = headroomByName.get(fixture.name);
    const brief = await runFidelityFixture(fixture, { level: "lossless", store });
    const terse = await runFidelityFixture(fixture, { level: "terse", store });
    endTaskCandidates.push(...buildEndTaskCandidates(fixture, brief.stdout.toString("utf8"), brief.oneLine === true));
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
      briefFidelity: sameExitClass(brief.status, fixture.recorded.status) && brief.assertionFailures.length === 0,
      terseDelta: terse.tokenDelta,
      terseFidelity: sameExitClass(terse.status, fixture.recorded.status) && terse.assertionFailures.length === 0,
      rtkDelta: rtkFixture ? tokenDelta(fixture.recorded.stdout, rtkFixture.stdout) : undefined,
      rtkFidelity: rtkFixture?.fidelity_assertions_passed,
      headroomDelta: headroomFixture?.coverage === "covered" && typeof headroomFixture.stdout === "string"
        ? tokenDelta(fixture.recorded.stdout, headroomFixture.stdout)
        : undefined,
      headroomFidelity: headroomFixture?.coverage === "covered" ? headroomFixture.fidelity_assertions_passed : undefined,
      headroomNotCoveredReason: headroomFixture?.coverage === "not-covered" ? headroomFixture.not_covered_reason : undefined,
      rawTokens,
      rspTokens: active ? briefTokens : rawTokens,
      terseTokens: active ? terseTokens : rawTokens,
      rtkTokens: rtkFixture ? tokenCount(rtkFixture.stdout) : undefined,
      headroomTokens: headroomFixture?.coverage === "covered" && typeof headroomFixture.stdout === "string"
        ? tokenCount(headroomFixture.stdout)
        : undefined,
      oracleTokens: await oracleTokenCount(fixture),
    });
  }

  const rows = [...groupByFilter(measurements).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filter, rows]) =>
    filterRow(filter, rows, admissionByFilter.get(filter))
  );
  const parity = buildParity(rows);
  const qualityCorpora = buildQualityCorpora(measurements);
  const endTaskParity = selectEndTaskParity(endTaskCandidates);
  const antiSuppressionAudit = buildAntiSuppressionAudit(rows);
  const payload = {
    benchmark: "rsp-two-axis",
    corpus: {
      label: options.corpusLabel ?? "home",
      fixture_count: measurements.length,
      filters: rows.map((row) => row.filter),
      large_output_filters: largeOutputFilters(measurements),
      provenance: options.corpusProvenance ?? ["Repo-authored rsp benchmark fixtures under apps/rsp/tests/fixtures."],
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
      headroom_source: {
        kind: "recorded-fixtures",
        version: headroom.version,
        captured_at: headroom.captured_at,
      },
      external_claims: externalClaims(),
    },
    filters: rows,
    aggregate: aggregateOracleCapture(measurements),
    quality_corpora: qualityCorpora,
    parity,
    end_task_parity: endTaskParity,
    anti_suppression_audit: antiSuppressionAudit,
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
    `Corpus: ${report.corpus.label}`,
    "",
    "Corpus provenance:",
    ...report.corpus.provenance.map((note) => `- ${note}`),
    "",
    `Production mode uses admission threshold ${ADMISSION_THRESHOLD_PCT}%; passthrough filters count as 0% token delta because rsp returns the original command output.`,
    "",
    "| Filter | Mode | Fixtures | raw tokens | rsp tokens | RTK tokens | Headroom tokens | oracle tokens | rsp capture | RTK capture | Headroom capture | brief shipped delta | brief fidelity-first score | terse shipped delta | terse fidelity-first score | RTK fidelity-first score | Headroom fidelity-first score |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.filters.map((row) =>
      `| ${row.filter} | ${row.mode} | ${row.fixture_count} | ${row.oracle_capture.raw.token_count} | ${row.oracle_capture.rsp.token_count} | ${fmtComparatorTokenCount(row.oracle_capture.rtk)} | ${fmtComparatorTokenCount(row.oracle_capture.headroom)} | ${row.oracle_capture.oracle_ceiling.token_count} | ${fmt(row.oracle_capture.rsp.capture_pct)}% | ${fmtComparatorCapture(row.oracle_capture.rtk)} | ${fmtComparatorCapture(row.oracle_capture.headroom)} | ${fmt(row.brief.median_delta_pct)}/${fmt(row.brief.p90_delta_pct)}% | ${fmt(row.brief.fidelity_pass_rate_pct)}% | ${fmt(row.terse.median_delta_pct)}/${fmt(row.terse.p90_delta_pct)}% | ${fmt(row.terse.fidelity_pass_rate_pct)}% | ${fmtComparatorFidelity(row.rtk)} | ${fmtComparatorFidelity(row.headroom)} |`
    ),
    "",
    `Aggregate oracle ceiling: raw ${report.aggregate.raw.token_count} tokens (${fmt(report.aggregate.raw.capture_pct)}% capture), rsp ${report.aggregate.rsp.token_count} tokens (${fmt(report.aggregate.rsp.capture_pct)}% capture), RTK ${fmtComparatorTokenCount(report.aggregate.rtk)} tokens (${fmtComparatorCapture(report.aggregate.rtk)} capture), Headroom ${fmtComparatorTokenCount(report.aggregate.headroom)} tokens (${fmtComparatorCapture(report.aggregate.headroom)} capture), oracle ${report.aggregate.oracle_ceiling.token_count} tokens.`,
    "",
    "| Corpus | Fixtures | Filters | raw tokens | rsp tokens | Headroom tokens | oracle tokens | rsp capture | Headroom capture |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.quality_corpora.map((row) =>
      `| ${row.corpus} | ${row.fixture_count} | ${row.filters.join(", ")} | ${row.oracle_capture.raw.token_count} | ${row.oracle_capture.rsp.token_count} | ${fmtComparatorTokenCount(row.oracle_capture.headroom)} | ${row.oracle_capture.oracle_ceiling.token_count} | ${fmt(row.oracle_capture.rsp.capture_pct)}% | ${fmtComparatorCapture(row.oracle_capture.headroom)} |`
    ),
    "",
    `Large-output filters: ${report.corpus.large_output_filters.join(", ") || "none"}.`,
    "",
    "| Parity domain | Filter | Gate | rsp fidelity | RTK fidelity |",
    "| --- | --- | --- | ---: | ---: |",
    ...report.parity.map((row) =>
      `| ${row.domain} | ${row.filter} | ${row.parity_gate} | ${fmt(row.rsp_fidelity_pass_rate_pct)}% | ${fmt(row.rtk_fidelity_pass_rate_pct)}% |`
    ),
    "",
    "| End-task parity probe | Fixture | Raw answer | rsp summary answer | Same answer |",
    "| --- | --- | --- | --- | --- |",
    ...report.end_task_parity.map((row) =>
      `| ${row.task} | ${row.fixture} | ${fmtJsonValue(row.raw_answer)} | ${fmtJsonValue(row.rsp_answer)} | ${row.same_answer ? "yes" : "no"} |`
    ),
    "",
    "| Anti-suppression audit | Level | Verdict | Note |",
    "| --- | --- | --- | --- |",
    ...report.anti_suppression_audit.map((row) =>
      `| ${row.filter} | ${row.level} | audited: ${row.audited} | ${row.note} |`
    ),
    "",
    "RTK baseline is replayed from checked-in recorded fixtures only; RTK is not executed by this command.",
    "Headroom baseline is replayed from checked-in recorded fixtures only; headroom-ai is only installed by the explicit capture script.",
    "External context-optimization claims are cited literature only and were not locally reproduced.",
    "",
  ];
  return lines.join("\n");
}

async function discoverBenchmarkFixtures(fixtureRoot: string): Promise<FidelityFixture[]> {
  const roots = [join(fixtureRoot, "automatic"), join(fixtureRoot, "exec"), join(fixtureRoot, "file-read"), join(fixtureRoot, "gh"), join(fixtureRoot, "git"), join(fixtureRoot, "test-runners")];
  const existingRoots = [];
  for (const root of roots) {
    if (await pathExists(root)) existingRoots.push(root);
  }
  const groups = await Promise.all(existingRoots.map((root) => discoverFidelityFixtures(root)));
  return groups.flat().sort((a, b) => a.name.localeCompare(b.name));
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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

async function readHeadroomBaselines(path: string): Promise<HeadroomBaselines> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (!isHeadroomBaselines(parsed)) throw new Error(`invalid Headroom baseline fixture: ${path}`);
  return parsed;
}

function buildParity(rows: readonly TwoAxisFilterRow[]): TwoAxisParityRow[] {
  return [
    parityRow("cargo-test", "cargo:test", rows),
    parityRow("git-commit", "git:commit", rows),
  ];
}

function buildQualityCorpora(measurements: readonly FixtureMeasurement[]): QualityCorpusRow[] {
  return [...groupByCorpus(measurements).entries()]
    .sort(([a], [b]) => corpusSortKey(a) - corpusSortKey(b))
    .map(([corpus, rows]) => ({
      corpus,
      fixture_count: rows.length,
      filters: [...new Set(rows.map((row) => row.filter))].sort((a, b) => a.localeCompare(b)),
      oracle_capture: oracleCapture(rows),
    }));
}

function groupByCorpus(measurements: readonly FixtureMeasurement[]): Map<QualityCorpusRow["corpus"], FixtureMeasurement[]> {
  const out = new Map<QualityCorpusRow["corpus"], FixtureMeasurement[]>();
  for (const measurement of measurements) {
    const corpus = qualityCorpus(measurement.fixture);
    out.set(corpus, [...(out.get(corpus) ?? []), measurement]);
  }
  return out;
}

function qualityCorpus(fixture: FidelityFixture): QualityCorpusRow["corpus"] {
  if (fixture.name === "exec-midstream-anomaly") return "anomaly";
  if (fixture.name === "exec-router-mixed-content") return "mixed-content";
  if (fixture.name === "exec-json-array-crusher") return "json-outlier";
  return "pre-existing-quality";
}

function corpusSortKey(corpus: QualityCorpusRow["corpus"]): number {
  return ["pre-existing-quality", "anomaly", "mixed-content", "json-outlier"].indexOf(corpus);
}

function buildEndTaskCandidates(fixture: FidelityFixture, rspStdout: string, oneLine: boolean): EndTaskCandidate[] {
  const probes = fixture.assertions.filter((assertion) => isEndTaskProbe(fixture.name, assertion.question));
  if (probes.length === 0) return [];
  const decoded = decodeBenchmarkRenderOutput(rspStdout, oneLine);
  return probes.map((assertion) => {
    const rspAnswer = toJsonValue(getPath(decoded, assertion.path));
    const rawAnswer = toJsonValue(assertion.expected);
    return {
      fixture: fixture.name,
      task: assertion.question,
      rawAnswer,
      rspAnswer,
      sameAnswer: Object.is(rspAnswer, rawAnswer),
    };
  });
}

function isEndTaskProbe(fixtureName: string, question: string): boolean {
  return new Set([
    "exec-midstream-anomaly::oracle preserves planted mid-stream structural outlier",
    "exec-json-array-crusher::crusher keeps numeric value outlier",
    "exec-json-array-crusher::crusher keeps shape outlier",
    "exec-router-mixed-content::router degrades mixed ambiguous content to untyped fallback",
    "pr-list-default::which PR is first?",
    "vitest-many-failures::how many failed?",
  ]).has(`${fixtureName}::${question}`);
}

function selectEndTaskParity(candidates: readonly EndTaskCandidate[]): EndTaskParityRow[] {
  return candidates.map((candidate) => ({
    task: candidate.task,
    fixture: candidate.fixture,
    raw_answer: candidate.rawAnswer,
    rsp_answer: candidate.rspAnswer,
    same_answer: candidate.sameAnswer,
  }));
}

function decodeBenchmarkRenderOutput(stdout: string, oneLine: boolean): unknown {
  if (oneLine) return stdout.replace(/\n$/, "");
  if (stdout === "git empty\n") return "git empty\n";
  if (stdout.startsWith("stdout summary\n")) return stdout;
  if (stdout.startsWith("0 ")) return stdout;
  const toon = stdout.split("\n").filter((line) => !line.startsWith("… elided ")).join("\n");
  return decode(toon);
}

function getPath(value: unknown, path: string): unknown {
  let cursor = value;
  for (const segment of path.split(".")) {
    if (segment === "length" && Array.isArray(cursor)) {
      cursor = cursor.length;
    } else if (segment === "length" && isRecord(cursor)) {
      cursor = Object.keys(cursor).length;
    } else if (/^\d+$/.test(segment) && Array.isArray(cursor)) {
      cursor = cursor[Number(segment)];
    } else if (isRecord(cursor)) {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function buildAntiSuppressionAudit(rows: readonly TwoAxisFilterRow[]): AntiSuppressionAuditRow[] {
  return rows.flatMap((row) => (["brief", "terse"] as const).map((level) => {
    const verdict = antiSuppressionVerdict(row.filter);
    return {
      filter: row.filter,
      level,
      audited: verdict.audited,
      note: verdict.note,
    };
  }));
}

function antiSuppressionVerdict(filter: string): Pick<AntiSuppressionAuditRow, "audited" | "note"> {
  switch (filter) {
    case "automatic:output":
      return { audited: "ok", note: "large repetitive output declares deterministic caps and aggregates, keeps one recovery handle, and round-trips original bytes" };
    case "exec:--":
      return { audited: "ok", note: "generic exec summaries route structured content to TOON shapes, fall back to head/tail with deterministic outliers, and retain a recovery handle" };
    case "cat:file":
      return { audited: "ok", note: "file reads keep code outlines or bounded text plus an elision handle for original bytes; binary output passes through" };
    case "git:commit":
      return { audited: "fixed", note: "success output now renders commit id, branch, subject, and change counts as compact TOON" };
    case "git:push":
      return { audited: "fixed", note: "success output now renders pushed refs and remote as compact TOON; rejected pushes remain byte-intact faults" };
    case "git:status":
      return { audited: "justified", note: "clean-tree sentinel is a deliberate definitive empty state; changed-tree output keeps row TOON" };
    case "gh:pr":
      return { audited: "justified", note: "empty-list sentinel is deliberate; non-empty list and view fixtures keep PR row/body TOON" };
    case "git:diff":
    case "git:log":
    case "git:blame":
    case "git:show":
      return { audited: "ok", note: "large row sets keep compact TOON plus an elision handle for full detail" };
    case "git:branch":
      return { audited: "ok", note: "branch history output keeps current marker, branch names, upstreams, commits, worktrees, and subjects as compact TOON" };
    case "gh:issue":
    case "gh:run":
      return { audited: "ok", note: "successful outputs keep decision rows as compact TOON; fault responses are byte-intact passthrough" };
    case "cargo:test":
    case "vitest:run":
      return { audited: "ok", note: "test outputs keep exit code, summary, and failure rows in compact TOON with handles for elided detail" };
    default:
      throw new Error(`missing anti-suppression audit verdict for ${filter}`);
  }
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

function sameExitClass(actual: number | null | undefined, expected: number | null | undefined): boolean {
  if (actual === expected) return true;
  return (actual ?? 0) !== 0 && (expected ?? 0) !== 0;
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
    headroom: comparatorAxis(
      "headroom",
      rows.map((row) => ({ delta: row.headroomDelta, fidelity: row.headroomFidelity, reason: row.headroomNotCoveredReason })),
    ),
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
  rows: readonly { delta?: number; fidelity?: boolean; reason?: string }[],
): ComparatorAxis {
  const covered = rows.filter((row): row is { delta: number; fidelity: boolean } =>
    typeof row.delta === "number" && typeof row.fidelity === "boolean"
  );
  if (covered.length === 0) return notCoveredAxis(label, notCoveredReason(rows));
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
    headroom: comparatorTokenCapture(
      "headroom",
      rows.map((row) => ({ rawTokens: row.rawTokens, tokens: row.headroomTokens, oracleTokens: row.oracleTokens, reason: row.headroomNotCoveredReason })),
    ),
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
  rows: readonly { rawTokens: number; tokens?: number; oracleTokens: number; reason?: string }[],
): ComparatorTokenCaptureAxis {
  const covered = rows.filter((row): row is { rawTokens: number; tokens: number; oracleTokens: number } => typeof row.tokens === "number");
  if (covered.length === 0) return notCoveredTokenCaptureAxis(label, notCoveredReason(rows));
  return tokenCapture(
    sum(covered.map((row) => row.tokens)),
    sum(covered.map((row) => row.rawTokens)),
    sum(covered.map((row) => row.oracleTokens)),
    "recorded",
  );
}

function notCoveredTokenCaptureAxis(label: string, reason?: string): NotCoveredTokenCaptureAxis {
  return {
    coverage: "not-covered",
    label: `${label}: not-covered`,
    ...(reason ? { reason } : {}),
    source: "not-covered",
  };
}

function notCoveredAxis(label: string, reason?: string): NotCoveredAxis {
  return {
    coverage: "not-covered",
    label: `${label}: not-covered`,
    ...(reason ? { reason } : {}),
    source: "not-covered",
  };
}

function notCoveredReason(rows: readonly { reason?: string }[]): string | undefined {
  const reasons = [...new Set(rows.map((row) => row.reason).filter((reason): reason is string => Boolean(reason)))];
  if (reasons.length === 0) return undefined;
  return reasons.join("; ");
}

function coveredComparatorAxis(label: string, filter: string, value: ComparatorAxis): BaselineAxis {
  if (value.source === "not-covered") throw new Error(`${label} baseline not covered for parity filter ${filter}`);
  return value;
}

function filterName(fixture: FidelityFixture): string {
  if (fixture.command[0] === "cat") return "cat:file";
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

function fmtJsonValue(value: JsonValue): string {
  if (typeof value === "string") return value.replace(/\|/g, "\\|");
  return JSON.stringify(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    isRecord(value)
  ) {
    return value as JsonValue;
  }
  return null;
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

function isHeadroomBaselines(value: unknown): value is HeadroomBaselines {
  return isRecord(value) &&
    typeof value.version === "string" &&
    typeof value.captured_at === "string" &&
    typeof value.capture_script === "string" &&
    Array.isArray(value.fixtures) &&
    value.fixtures.every(isHeadroomBaselineFixture);
}

function isHeadroomBaselineFixture(value: unknown): value is HeadroomBaselineFixture {
  if (!isRecord(value) || typeof value.name !== "string") return false;
  if (value.coverage === "covered") {
    return typeof value.stdout === "string" &&
      typeof value.fidelity_assertions_passed === "boolean" &&
      (!Object.prototype.hasOwnProperty.call(value, "transforms_applied") ||
        (Array.isArray(value.transforms_applied) && value.transforms_applied.every((item) => typeof item === "string")));
  }
  if (value.coverage === "not-covered") return typeof value.not_covered_reason === "string";
  return false;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
