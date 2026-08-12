import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { renderStructuredBoundary } from "./structured-boundary.js";

export interface CommandBoundaryBenchmark {
  iterations: number;
  cold_ms: number;
  raw_p50_ms: number;
  raw_p95_ms: number;
  raw_p99_ms: number;
  rsp_p50_ms: number;
  rsp_p95_ms: number;
  rsp_p99_ms: number;
  passthrough_overhead_p95_ms: number;
  structured_transform_p95_ms: number;
  cold_budget_ms: number;
  passthrough_overhead_budget_ms: number;
  structured_transform_budget_ms: number;
  pass: boolean;
}

export function measureCommandBoundary(
  bundle = resolve(process.cwd(), "../../dist/rsp.bundle.min.mjs"),
  iterations = 40,
): CommandBoundaryBenchmark {
  const rawCommand = [process.execPath, "-e", ""];
  const rspCommand = [process.execPath, bundle, ...rawCommand];
  const cold = timed(rspCommand);
  const raw: number[] = [];
  const rsp: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    raw.push(timed(rawCommand));
    rsp.push(timed(rspCommand));
  }
  const rawP95 = percentile(raw, 0.95);
  const rspP95 = percentile(rsp, 0.95);
  const overheadP95 = Math.max(0, rspP95 - rawP95);
  const structured = measureStructuredBoundary(iterations);
  return {
    iterations,
    cold_ms: cold,
    raw_p50_ms: percentile(raw, 0.5),
    raw_p95_ms: rawP95,
    raw_p99_ms: percentile(raw, 0.99),
    rsp_p50_ms: percentile(rsp, 0.5),
    rsp_p95_ms: rspP95,
    rsp_p99_ms: percentile(rsp, 0.99),
    passthrough_overhead_p95_ms: overheadP95,
    structured_transform_p95_ms: structured.p95_ms,
    cold_budget_ms: 200,
    passthrough_overhead_budget_ms: 50,
    structured_transform_budget_ms: 100,
    pass: cold <= 200 && overheadP95 <= 50 && structured.p95_ms <= 100,
  };
}

export function renderCommandBoundaryBenchmark(result: CommandBoundaryBenchmark): string {
  const ms = (value: number) => value.toFixed(2);
  return [
    "# RSP command-boundary benchmark",
    "",
    `Reference sample: ${result.iterations} warm passthrough invocations plus one cold invocation.`,
    "",
    "| Metric | Result | Budget |",
    "| --- | ---: | ---: |",
    `| Cold invocation | ${ms(result.cold_ms)} ms | ≤ ${result.cold_budget_ms} ms |`,
    `| p95 passthrough overhead | ${ms(result.passthrough_overhead_p95_ms)} ms | ≤ ${result.passthrough_overhead_budget_ms} ms |`,
    `| p95 structured transformation | ${ms(result.structured_transform_p95_ms)} ms | ≤ ${result.structured_transform_budget_ms} ms |`,
    `| Raw p50 / p95 / p99 | ${ms(result.raw_p50_ms)} / ${ms(result.raw_p95_ms)} / ${ms(result.raw_p99_ms)} ms | — |`,
    `| RSP p50 / p95 / p99 | ${ms(result.rsp_p50_ms)} / ${ms(result.rsp_p95_ms)} / ${ms(result.rsp_p99_ms)} ms | — |`,
    "",
    `Verdict: **${result.pass ? "pass" : "fail"}**.`,
    "",
  ].join("\n");
}

export function measureStructuredBoundary(iterations = 40): { samples: number; p95_ms: number } {
  const fixture = Buffer.from(JSON.stringify({
    service: "api",
    healthy: true,
    replicas: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, region: `region-${index % 4}` })),
    metadata: { owner: "platform", note: "reference structured boundary fixture" },
  }));
  renderStructuredBoundary(fixture);
  const samples: number[] = [];
  for (let index = 0; index < iterations; index += 1) {
    const started = process.hrtime.bigint();
    const rendered = renderStructuredBoundary(fixture);
    samples.push(Number(process.hrtime.bigint() - started) / 1_000_000);
    if (rendered === fixture) throw new Error("reference structured fixture was not transformed");
  }
  return { samples: iterations, p95_ms: percentile(samples, 0.95) };
}

function timed(argv: readonly string[]): number {
  const started = process.hrtime.bigint();
  const result = spawnSync(argv[0]!, argv.slice(1), { stdio: "ignore" });
  if (result.status !== 0) throw new Error(`benchmark command exited ${String(result.status)}`);
  return Number(process.hrtime.bigint() - started) / 1_000_000;
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = measureCommandBoundary();
  process.stdout.write(renderCommandBoundaryBenchmark(result));
  process.exitCode = result.pass ? 0 : 1;
}
