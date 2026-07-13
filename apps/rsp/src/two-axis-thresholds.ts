import type { BaselineAxis, TwoAxisBenchmarkReport } from "./two-axis-benchmark.js";

export const TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT = 2;
export const TWO_AXIS_ALLOWED_FIDELITY_REGRESSION_PCT = 0;

export interface TwoAxisRegressionViolation {
  kind: "token-regression" | "fidelity-regression";
  filter: string;
  axis: "brief" | "terse";
  baseline: number;
  current: number;
  threshold: number;
}

export function compareTwoAxisBenchmarkReports(
  baseline: TwoAxisBenchmarkReport,
  current: TwoAxisBenchmarkReport,
): TwoAxisRegressionViolation[] {
  const baselineByFilter = new Map(baseline.filters.map((row) => [row.filter, row]));
  const violations: TwoAxisRegressionViolation[] = [];
  for (const currentRow of current.filters) {
    const baselineRow = baselineByFilter.get(currentRow.filter);
    if (!baselineRow) continue;
    violations.push(
      ...compareAxis(currentRow.filter, "brief", baselineRow.brief, currentRow.brief),
      ...compareAxis(currentRow.filter, "terse", baselineRow.terse, currentRow.terse),
    );
  }
  return violations;
}

function compareAxis(
  filter: string,
  axis: "brief" | "terse",
  baseline: BaselineAxis,
  current: BaselineAxis,
): TwoAxisRegressionViolation[] {
  const violations: TwoAxisRegressionViolation[] = [];
  const tokenRegression = baseline.median_delta_pct - current.median_delta_pct;
  if (tokenRegression > TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT) {
    violations.push({
      kind: "token-regression",
      filter,
      axis,
      baseline: baseline.median_delta_pct,
      current: current.median_delta_pct,
      threshold: TWO_AXIS_TOKEN_REGRESSION_THRESHOLD_PCT,
    });
  }
  const fidelityRegression = baseline.fidelity_pass_rate_pct - current.fidelity_pass_rate_pct;
  if (fidelityRegression > TWO_AXIS_ALLOWED_FIDELITY_REGRESSION_PCT) {
    violations.push({
      kind: "fidelity-regression",
      filter,
      axis,
      baseline: baseline.fidelity_pass_rate_pct,
      current: current.fidelity_pass_rate_pct,
      threshold: TWO_AXIS_ALLOWED_FIDELITY_REGRESSION_PCT,
    });
  }
  return violations;
}
