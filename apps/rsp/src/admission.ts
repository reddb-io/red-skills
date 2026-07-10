import { encode, type JsonObject } from "@reddb-io/toon";
import { encodingForModel } from "js-tiktoken";
import { renderFixture, type FidelityFixture, type FidelityRunOptions } from "./fidelity.js";

export interface AdmissionOptions {
  thresholdPct: number;
}

export interface AdmissionFilterReport {
  filter: string;
  median_delta_pct: number;
  active: boolean;
  mode: "active" | "passthrough";
}

export interface AdmissionReport {
  filters: AdmissionFilterReport[];
  summary: string;
}

export interface AdmittedRunResult {
  stdout: Buffer;
  stderr: Buffer;
  status: number | null;
  signal: NodeJS.Signals | null;
  mode: "active" | "passthrough";
}

const tokenizer = encodingForModel("gpt-4o");

export function evaluateAdmission(fixtures: readonly FidelityFixture[], options: AdmissionOptions): AdmissionReport {
  const byFilter = new Map<string, number[]>();
  for (const fixture of fixtures) {
    if (fixture.recorded.status !== 0) continue;
    const filter = filterName(fixture);
    const rendered = renderedFixtureText(fixture);
    const delta = tokenDelta(fixture.recorded.stdout, rendered);
    byFilter.set(filter, [...(byFilter.get(filter) ?? []), delta]);
  }

  const filters = [...byFilter.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([filter, deltas]) => {
    const median = medianOf(deltas);
    const active = median >= options.thresholdPct;
    return {
      filter,
      median_delta_pct: Number(median.toFixed(1)),
      active,
      mode: active ? "active" as const : "passthrough" as const,
    };
  });

  return {
    filters,
    summary: `${filters.filter((row) => row.active).length}/${filters.length} filters active at threshold ${options.thresholdPct}%`,
  };
}

export async function runAdmittedFixture(
  fixture: FidelityFixture,
  options: AdmissionOptions & FidelityRunOptions,
): Promise<AdmittedRunResult> {
  const report = evaluateAdmission([fixture], options);
  const row = report.filters.find((candidate) => candidate.filter === filterName(fixture));
  if (!row?.active) {
    return {
      stdout: Buffer.from(fixture.recorded.stdout),
      stderr: Buffer.from(fixture.recorded.stderr),
      status: fixture.recorded.status,
      signal: fixture.recorded.signal,
      mode: "passthrough",
    };
  }
  const result = await renderFixture(fixture, options);
  return { ...result, mode: "active" };
}

export function renderAdmissionReportToon(report: AdmissionReport): string {
  return encode(report as unknown as JsonObject);
}

function renderedFixtureText(fixture: FidelityFixture): string {
  if (fixture.expected === "git empty\n") return fixture.expected;
  if (typeof fixture.expected === "string") return fixture.expected;
  return encode(fixture.expected as JsonObject);
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

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}
