import { readdirSync } from "node:fs";
import { join } from "node:path";
import { encode as encodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";
import { WORKER_STATE_FILENAME } from "./state.js";
import { readWorkerStateDocument } from "./worker-state-reader.js";
import type { OutputShapingVariant } from "./output-shaping.js";

export interface OutputShapingSample {
  issue: number | string;
  variant: OutputShapingVariant;
  output_tokens: number;
}

export interface OutputShapingArmReport {
  attempts: number;
  output_tokens_total: number;
  output_tokens_mean: number;
  output_tokens_stddev: number;
}

export interface OutputShapingReport {
  schema_version: "afk.output-shaping.v1";
  samples: number;
  arms: Record<OutputShapingVariant, OutputShapingArmReport>;
  delta_output_tokens_mean: number | null;
  delta_output_tokens_pct: number | null;
  confidence_range_output_tokens: [number, number] | null;
  warnings: string[];
}

export function collectOutputShapingSamples(tmpDir: string): OutputShapingSample[] {
  const states = listStateFiles(join(tmpDir, "workers"));
  const samples: OutputShapingSample[] = [];
  for (const path of states) {
    // Unreadable or malformed historical state files read as null and are skipped.
    const state = readWorkerStateDocument(path);
    if (state === null) continue;
    const variant = state.current.output_shaping_variant;
    if (variant !== "steered" && variant !== "holdout") continue;
    samples.push({
      issue: state.current.number,
      variant,
      output_tokens: state.current.output_tokens ?? 0,
    });
  }
  return samples;
}

function listStateFiles(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listStateFiles(path));
    else if (entry.isFile() && entry.name === WORKER_STATE_FILENAME) files.push(path);
  }
  return files;
}

export function buildOutputShapingReport(samples: readonly OutputShapingSample[]): OutputShapingReport {
  const steered = arm(samples.filter((s) => s.variant === "steered").map((s) => s.output_tokens));
  const holdout = arm(samples.filter((s) => s.variant === "holdout").map((s) => s.output_tokens));
  const warnings: string[] = [];
  if (steered.attempts === 0) warnings.push("no steered samples");
  if (holdout.attempts === 0) warnings.push("no holdout samples");

  const delta =
    steered.attempts > 0 && holdout.attempts > 0
      ? steered.output_tokens_mean - holdout.output_tokens_mean
      : null;
  const pct =
    delta !== null && holdout.output_tokens_mean > 0
      ? delta / holdout.output_tokens_mean
      : null;
  const range = confidenceRange(steered, holdout, delta);
  if (range === null) warnings.push("confidence range requires at least two samples per arm");

  return {
    schema_version: "afk.output-shaping.v1",
    samples: samples.length,
    arms: { steered, holdout },
    delta_output_tokens_mean: delta,
    delta_output_tokens_pct: pct,
    confidence_range_output_tokens: range,
    warnings,
  };
}

function arm(values: readonly number[]): OutputShapingArmReport {
  const total = values.reduce((sum, value) => sum + value, 0);
  const mean = values.length === 0 ? 0 : total / values.length;
  const variance =
    values.length < 2
      ? 0
      : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return {
    attempts: values.length,
    output_tokens_total: total,
    output_tokens_mean: mean,
    output_tokens_stddev: Math.sqrt(variance),
  };
}

function confidenceRange(
  steered: OutputShapingArmReport,
  holdout: OutputShapingArmReport,
  delta: number | null,
): [number, number] | null {
  if (delta === null || steered.attempts < 2 || holdout.attempts < 2) return null;
  const se = Math.sqrt(
    (steered.output_tokens_stddev ** 2) / steered.attempts +
      (holdout.output_tokens_stddev ** 2) / holdout.attempts,
  );
  const margin = 1.96 * se;
  return [delta - margin, delta + margin];
}

export function renderOutputShapingReport(report: OutputShapingReport): string {
  const lines = [
    "AFK output shaping report",
    `samples: ${report.samples}`,
    `steered: ${report.arms.steered.attempts} attempts, mean output ${fmt(report.arms.steered.output_tokens_mean)} tokens`,
    `holdout: ${report.arms.holdout.attempts} attempts, mean output ${fmt(report.arms.holdout.output_tokens_mean)} tokens`,
  ];
  if (report.delta_output_tokens_mean !== null) {
    const pct = report.delta_output_tokens_pct === null ? "n/a" : `${fmt(report.delta_output_tokens_pct * 100)}%`;
    lines.push(`delta steered-holdout: ${fmt(report.delta_output_tokens_mean)} tokens (${pct})`);
  }
  if (report.confidence_range_output_tokens) {
    const [lo, hi] = report.confidence_range_output_tokens;
    lines.push(`95% confidence range: ${fmt(lo)}..${fmt(hi)} output tokens`);
  }
  for (const warning of report.warnings) lines.push(`warning: ${warning}`);
  return `${lines.join("\n")}\n`;
}

export function renderOutputShapingReportToon(report: OutputShapingReport): string {
  return encodeToon(report as unknown as ToonValue);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
