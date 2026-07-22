import { LABEL_TYPE_SPEC, LABEL_VALIDATION, LABEL_RUNNING } from "./triage-labels.js";
import { appendSummaryField, type JsonObject, type JsonValue as ToonValue } from "@reddb-io/toon";

export interface DashboardIssue {
  number: number;
  title: string;
  state: string;
  createdAt: string | null;
  closedAt: string | null;
  labels: string[];
  body?: string | null;
}

export interface DashboardPullRequest {
  number: number;
  title: string;
  state: string;
  createdAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
}

export interface DashboardRelease {
  tagName: string;
  publishedAt: string | null;
  isDraft?: boolean;
  isPrerelease?: boolean;
}

export interface DashboardLocalWorkers {
  live: number;
  stale: number;
  total: number;
  implementer_runtime?: {
    samples: number;
    runner_startup_ms: { before: number; after: number; delta: number };
    skill_manifest_bytes: { before: number; after: number; delta: number };
  };
}

export interface ImplementerRuntimeSample {
  runner_startup_before_ms: number;
  runner_startup_after_ms: number;
  skill_manifest_before_bytes: number;
  skill_manifest_after_bytes: number;
}

export function aggregateImplementerRuntimeMetrics(
  samples: readonly ImplementerRuntimeSample[],
): NonNullable<DashboardLocalWorkers["implementer_runtime"]> | undefined {
  if (samples.length === 0) return undefined;
  const mean = (field: keyof ImplementerRuntimeSample): number =>
    Math.round(
      samples.reduce((sum, sample) => sum + sample[field], 0) /
        samples.length,
    );
  const runnerBefore = mean("runner_startup_before_ms");
  const runnerAfter = mean("runner_startup_after_ms");
  const manifestBefore = mean("skill_manifest_before_bytes");
  const manifestAfter = mean("skill_manifest_after_bytes");
  return {
    samples: samples.length,
    runner_startup_ms: {
      before: runnerBefore,
      after: runnerAfter,
      delta: runnerAfter - runnerBefore,
    },
    skill_manifest_bytes: {
      before: manifestBefore,
      after: manifestAfter,
      delta: manifestAfter - manifestBefore,
    },
  };
}

export interface DashboardInput {
  issues: DashboardIssue[];
  pullRequests: DashboardPullRequest[];
  releases: DashboardRelease[];
  localWorkers: DashboardLocalWorkers;
  now: Date;
  periodDays: number;
}

export interface DashboardReport {
  schema_version: "red.dev.dashboard.v1";
  generated_at: string;
  period_days: number;
  operations: {
    open_specs: number;
    open_issues: number;
    global_running_workers: number;
    local_workers: DashboardLocalWorkers;
    issues_created_in_period: number;
    issues_closed_today: number;
    issues_closed_in_period: number;
    issues_due_today: number;
    issues_due_in_period: number;
    overdue_open_issues: number;
  };
  flow: {
    open_prs: number;
    prs_merged_in_period: number;
    average_issue_cycle_time_days: number | null;
    average_pr_lead_time_days: number | null;
  };
  dora: {
    deployment_frequency_in_period: number;
    lead_time_for_changes_days: number | null;
    change_failure_rate_proxy: number | null;
    failure_like_issues_closed_in_period: number;
    mttr_days_proxy: number | null;
  };
  warnings: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function daysBetween(start: Date, end: Date): number {
  return Math.max(0, (end.getTime() - start.getTime()) / DAY_MS);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return round2(values.reduce((sum, n) => sum + n, 0) / values.length);
}

function inRange(date: Date | null, start: Date, end: Date): boolean {
  return date !== null && date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

function sameUtcDay(a: Date | null, b: Date): boolean {
  return a !== null && startOfDay(a).getTime() === startOfDay(b).getTime();
}

function isOpen(state: string): boolean {
  return state.toUpperCase() === "OPEN";
}

function hasLabel(issue: DashboardIssue, predicate: (label: string) => boolean): boolean {
  return issue.labels.some((label) => predicate(label.toLowerCase()));
}

function isSpec(issue: DashboardIssue): boolean {
  return (
    hasLabel(issue, (label) => label === LABEL_TYPE_SPEC || label === "spec") ||
    /^spec\b/i.test(issue.title.trim())
  );
}

function isFailureLike(issue: DashboardIssue): boolean {
  return hasLabel(issue, (label) =>
    label === "type:bug" ||
    label === "bug" ||
    label === "regression" ||
    label === "incident" ||
    label === "type:incident" ||
    label === LABEL_VALIDATION,
  );
}

export function parseDueDate(issue: DashboardIssue): Date | null {
  for (const label of issue.labels) {
    const match = label.match(/^due:(\d{4}-\d{2}-\d{2})$/i);
    if (match) return parseDate(`${match[1]}T00:00:00Z`);
  }
  const body = issue.body ?? "";
  const match = body.match(/^\s*(?:due|due_date|deadline|target date)\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im);
  return match ? parseDate(`${match[1]}T00:00:00Z`) : null;
}

export function buildDashboardReport(input: DashboardInput): DashboardReport {
  const now = input.now;
  const today = startOfDay(now);
  const periodStart = new Date(now.getTime() - input.periodDays * DAY_MS);
  const openIssues = input.issues.filter((issue) => isOpen(issue.state));
  const openNonSpecIssues = openIssues.filter((issue) => !isSpec(issue));
  const openSpecs = openIssues.filter(isSpec);
  const closedInPeriod = input.issues.filter((issue) => inRange(parseDate(issue.closedAt), periodStart, now));
  const createdInPeriod = input.issues.filter((issue) => inRange(parseDate(issue.createdAt), periodStart, now));
  const failureLikeClosed = closedInPeriod.filter(isFailureLike);
  const issueCycleTimes = closedInPeriod
    .map((issue) => {
      const created = parseDate(issue.createdAt);
      const closed = parseDate(issue.closedAt);
      return created && closed ? daysBetween(created, closed) : null;
    })
    .filter((value): value is number => value !== null);

  const dueRows = openIssues
    .map((issue) => ({ issue, due: parseDueDate(issue) }))
    .filter((row): row is { issue: DashboardIssue; due: Date } => row.due !== null);

  const mergedPrs = input.pullRequests.filter((pr) => inRange(parseDate(pr.mergedAt), periodStart, now));
  const prLeadTimes = mergedPrs
    .map((pr) => {
      const created = parseDate(pr.createdAt);
      const merged = parseDate(pr.mergedAt);
      return created && merged ? daysBetween(created, merged) : null;
    })
    .filter((value): value is number => value !== null);

  const releasesInPeriod = input.releases.filter(
    (release) =>
      !release.isDraft &&
      !release.isPrerelease &&
      inRange(parseDate(release.publishedAt), periodStart, now),
  );

  const mttrValues = failureLikeClosed
    .map((issue) => {
      const created = parseDate(issue.createdAt);
      const closed = parseDate(issue.closedAt);
      return created && closed ? daysBetween(created, closed) : null;
    })
    .filter((value): value is number => value !== null);

  const warnings: string[] = [];
  if (dueRows.length === 0) {
    warnings.push("No due dates found; due metrics require due: YYYY-MM-DD in labels or issue bodies.");
  }
  if (input.releases.length === 0) {
    warnings.push("No releases were available; DORA deployment frequency may be incomplete.");
  }

  return {
    schema_version: "red.dev.dashboard.v1",
    generated_at: now.toISOString(),
    period_days: input.periodDays,
    operations: {
      open_specs: openSpecs.length,
      open_issues: openNonSpecIssues.length,
      global_running_workers: openIssues.filter((issue) => issue.labels.includes(LABEL_RUNNING)).length,
      local_workers: input.localWorkers,
      issues_created_in_period: createdInPeriod.length,
      issues_closed_today: input.issues.filter((issue) => sameUtcDay(parseDate(issue.closedAt), today)).length,
      issues_closed_in_period: closedInPeriod.length,
      issues_due_today: dueRows.filter((row) => sameUtcDay(row.due, today)).length,
      issues_due_in_period: dueRows.filter((row) => inRange(row.due, periodStart, now)).length,
      overdue_open_issues: dueRows.filter((row) => row.due.getTime() < today.getTime()).length,
    },
    flow: {
      open_prs: input.pullRequests.filter((pr) => isOpen(pr.state)).length,
      prs_merged_in_period: mergedPrs.length,
      average_issue_cycle_time_days: average(issueCycleTimes),
      average_pr_lead_time_days: average(prLeadTimes),
    },
    dora: {
      deployment_frequency_in_period: releasesInPeriod.length,
      lead_time_for_changes_days: average(prLeadTimes),
      change_failure_rate_proxy:
        releasesInPeriod.length === 0 ? null : round2(failureLikeClosed.length / releasesInPeriod.length),
      failure_like_issues_closed_in_period: failureLikeClosed.length,
      mttr_days_proxy: average(mttrValues),
    },
    warnings,
  };
}

function fmtNullableDays(value: number | null): string {
  return value === null ? "n/a" : `${value}d`;
}

function fmtNullableRate(value: number | null): string {
  return value === null ? "n/a" : String(value);
}

export function renderDashboardReport(report: DashboardReport): string {
  const implementerRuntime = report.operations.local_workers.implementer_runtime;
  const lines = [
    `RedSkills dashboard (${report.period_days}d)`,
    `generated: ${report.generated_at}`,
    "",
    "Operations",
    `  open Specs: ${report.operations.open_specs}`,
    `  open issues: ${report.operations.open_issues}`,
    `  global running workers: ${report.operations.global_running_workers}`,
    `  local workers: ${report.operations.local_workers.live} live / ${report.operations.local_workers.stale} stale / ${report.operations.local_workers.total} total`,
    ...(implementerRuntime
      ? [
          `  implementer runtime samples: ${implementerRuntime.samples}`,
          `  runner startup: ${implementerRuntime.runner_startup_ms.before}ms → ${implementerRuntime.runner_startup_ms.after}ms (${implementerRuntime.runner_startup_ms.delta}ms)`,
          `  skill manifest: ${implementerRuntime.skill_manifest_bytes.before}B → ${implementerRuntime.skill_manifest_bytes.after}B (${implementerRuntime.skill_manifest_bytes.delta}B)`,
        ]
      : []),
    `  issues created in period: ${report.operations.issues_created_in_period}`,
    `  issues closed today: ${report.operations.issues_closed_today}`,
    `  issues closed in period: ${report.operations.issues_closed_in_period}`,
    `  issues due today: ${report.operations.issues_due_today}`,
    `  issues due in period: ${report.operations.issues_due_in_period}`,
    `  overdue open issues: ${report.operations.overdue_open_issues}`,
    "",
    "Flow",
    `  open PRs: ${report.flow.open_prs}`,
    `  PRs merged in period: ${report.flow.prs_merged_in_period}`,
    `  average issue cycle time: ${fmtNullableDays(report.flow.average_issue_cycle_time_days)}`,
    `  average PR lead time: ${fmtNullableDays(report.flow.average_pr_lead_time_days)}`,
    "",
    "DORA proxies",
    `  deployment frequency: ${report.dora.deployment_frequency_in_period} releases`,
    `  lead time for changes: ${fmtNullableDays(report.dora.lead_time_for_changes_days)}`,
    `  change failure rate proxy: ${fmtNullableRate(report.dora.change_failure_rate_proxy)}`,
    `  failure-like issues closed: ${report.dora.failure_like_issues_closed_in_period}`,
    `  MTTR proxy: ${fmtNullableDays(report.dora.mttr_days_proxy)}`,
  ];
  if (report.warnings.length > 0) {
    lines.push("", "Warnings", ...report.warnings.map((warning) => `  - ${warning}`));
  }
  return lines.join("\n");
}

/**
 * The default agent-facing render (PRD #928 / ADR 0081): the same pre-computed
 * report object as TOON. Every group (operations/flow/dora) is already a minimal
 * schema of aggregates; an empty `warnings` array renders as the definitive
 * `warnings[0]:` empty state rather than a silent omission.
 */
export function renderDashboardReportToon(report: DashboardReport): string {
  const summary =
    `${report.operations.open_issues} open issues · ${report.operations.open_specs} open specs · ` +
    `${report.flow.open_prs} open PRs · ${report.dora.deployment_frequency_in_period} deployments`;
  return appendSummaryField(report as unknown as JsonObject, summary);
}
