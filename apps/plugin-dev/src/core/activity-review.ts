import type { HistoryRecord } from "./history.js";
import { LABEL_HUMAN } from "./triage-labels.js";
import { blockedKindOf, blockedLabelsIn } from "./state-transition.js";
import { encode as encodeToon, type JsonValue as ToonValue } from "@reddb-io/toon";

export type ActivityReviewKind = "daily" | "weekly";

export interface ActivityReviewIssue {
  number: number;
  title: string;
  state: string;
  createdAt: string | null;
  closedAt: string | null;
  labels: string[];
  body?: string | null;
  url?: string | null;
  comments?: ActivityReviewComment[];
}

export interface ActivityReviewComment {
  body: string;
  createdAt?: string | null;
  author?: string | null;
}

export interface ActivityReviewPullRequest {
  number: number;
  title: string;
  state: string;
  createdAt: string | null;
  closedAt: string | null;
  mergedAt: string | null;
  url?: string | null;
}

export interface ActivityReviewGitStats {
  commits: number;
  added: number;
  removed: number;
}

export interface ActivityReviewActiveWorker {
  worker: string;
  runner: string;
  issue: number | null;
  title: string;
  startedAt: string | null;
  live: boolean;
}

export interface ActivityReviewTokenSummary {
  available: boolean;
  total: number | null;
  input: number | null;
  output: number | null;
  sourceRecords: number;
}

export interface ActivityReviewInput {
  kind: ActivityReviewKind;
  now: Date;
  issues: ActivityReviewIssue[];
  pullRequests: ActivityReviewPullRequest[];
  gitStats: ActivityReviewGitStats;
  history: HistoryRecord[];
  activeWorkers: ActivityReviewActiveWorker[];
  tokenSummary: ActivityReviewTokenSummary;
}

export interface ActivityReviewInterval {
  start: Date;
  end: Date;
}

export interface ActivityReviewWorkerSummary {
  worker: string;
  attempts: number;
  issues: number[];
  runners: string[];
  durationSeconds: number;
  activeSeconds: number;
  events: Record<string, number>;
}

export interface ActivityReviewCycleRow {
  number: number;
  title: string;
  createdAt: string | null;
  completedAt: string | null;
  durationDays: number | null;
  openedBeforeInterval: boolean;
  url?: string | null;
}

export interface ActivityReviewChallenge {
  issue: number;
  title: string;
  state: string;
  why: string;
  resolution: string;
  labels: string[];
  url?: string | null;
}

export interface ActivityReviewReport {
  schema_version: "red.dev.activity_review.v1";
  kind: ActivityReviewKind;
  generated_at: string;
  interval: {
    start: string;
    end: string;
  };
  big_numbers: {
    issues_created: number;
    issues_closed: number;
    prs_created: number;
    prs_closed: number;
    prs_merged: number;
    commits: number;
    lines_added: number;
    lines_removed: number;
    local_workers: number;
    local_attempts: number;
    local_worker_seconds: number;
    tokens: ActivityReviewTokenSummary;
  };
  workers: ActivityReviewWorkerSummary[];
  challenges: ActivityReviewChallenge[];
  issue_cycle_times: ActivityReviewCycleRow[];
  pr_cycle_times: ActivityReviewCycleRow[];
  warnings: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function activityReviewInterval(kind: ActivityReviewKind, now: Date): ActivityReviewInterval {
  const daysBack = kind === "daily" ? 1 : 6;
  return {
    start: new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, 0, 0, 0, 0),
    end: now,
  };
}

function parseDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function inRange(date: Date | null, interval: ActivityReviewInterval): boolean {
  return date !== null && date.getTime() >= interval.start.getTime() && date.getTime() <= interval.end.getTime();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function daysBetween(start: Date | null, end: Date | null): number | null {
  if (!start || !end) return null;
  return round2(Math.max(0, end.getTime() - start.getTime()) / DAY_MS);
}

function lowerLabels(labels: readonly string[]): string[] {
  return labels.map((label) => label.toLowerCase());
}

function isHitlOrBlocked(issue: ActivityReviewIssue): boolean {
  const labels = lowerLabels(issue.labels);
  if (labels.includes(LABEL_HUMAN)) return true;
  if (blockedLabelsIn(labels).length > 0) return true;
  const text = [
    issue.body ?? "",
    ...(issue.comments ?? []).map((comment) => comment.body),
  ].join("\n");
  return /ready-for-human|human guidance|hitl|data-attempt-status="(?:blocked|no-sentinel|merge-conflict|exhausted)"/i.test(text);
}

function firstUsefulLine(text: string): string | null {
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (line.length === 0) continue;
    if (/^[-_*#<>\s]+$/.test(line)) continue;
    return line.slice(0, 220);
  }
  return null;
}

function challengeWhy(issue: ActivityReviewIssue, history: readonly HistoryRecord[]): string {
  const labels = issue.labels.filter((label) => {
    const normalized = label.toLowerCase();
    return blockedKindOf(normalized) !== null || normalized === LABEL_HUMAN;
  });
  const reasons = history
    .filter((record) => record.issue === issue.number && record.reason)
    .map((record) => record.reason as string);
  if (reasons.length > 0) return reasons[reasons.length - 1]!;
  if (labels.length > 0) return `Labels: ${labels.join(", ")}`;
  const text = [
    issue.body ?? "",
    ...(issue.comments ?? []).map((comment) => comment.body),
  ].join("\n");
  const match = text.match(/data-attempt-status="([^"]+)"/i);
  if (match) return `Attempt status: ${match[1]}`;
  return firstUsefulLine(text) ?? "HITL/blocker signal found, but no explicit reason was captured.";
}

function challengeResolution(issue: ActivityReviewIssue): string {
  const comments = issue.comments ?? [];
  const guidance = [...comments].reverse().find((comment) => /human guidance|hitl decision|resolved|done|closed/i.test(comment.body));
  const line = guidance ? firstUsefulLine(guidance.body) : null;
  if (line) return line;
  const closed = parseDate(issue.closedAt);
  if (closed) return `Closed at ${closed.toISOString()}.`;
  if (issue.state.toUpperCase() === "OPEN") return "Still open or waiting for follow-up.";
  return "Resolution not captured in local/GitHub evidence.";
}

function buildWorkerSummaries(
  history: readonly HistoryRecord[],
  activeWorkers: readonly ActivityReviewActiveWorker[],
  interval: ActivityReviewInterval,
): ActivityReviewWorkerSummary[] {
  const byWorker = new Map<string, ActivityReviewWorkerSummary>();
  const ensure = (worker: string): ActivityReviewWorkerSummary => {
    const key = worker || "(unknown)";
    let row = byWorker.get(key);
    if (!row) {
      row = {
        worker: key,
        attempts: 0,
        issues: [],
        runners: [],
        durationSeconds: 0,
        activeSeconds: 0,
        events: {},
      };
      byWorker.set(key, row);
    }
    return row;
  };

  for (const record of history) {
    const at = new Date(record.epoch * 1000);
    if (!inRange(at, interval)) continue;
    const row = ensure(record.worker);
    row.attempts += 1;
    if (record.issue > 0 && !row.issues.includes(record.issue)) row.issues.push(record.issue);
    if (record.runner && !row.runners.includes(record.runner)) row.runners.push(record.runner);
    row.durationSeconds += Math.max(0, record.duration_s || 0);
    row.events[record.event] = (row.events[record.event] ?? 0) + 1;
  }

  for (const active of activeWorkers) {
    if (!active.live) continue;
    const started = parseDate(active.startedAt);
    if (!started) continue;
    const row = ensure(active.worker);
    if (active.runner && !row.runners.includes(active.runner)) row.runners.push(active.runner);
    if (active.issue !== null && active.issue > 0 && !row.issues.includes(active.issue)) row.issues.push(active.issue);
    const countedFrom = Math.max(started.getTime(), interval.start.getTime());
    row.activeSeconds += Math.max(0, Math.floor((interval.end.getTime() - countedFrom) / 1000));
  }

  return [...byWorker.values()].sort((a, b) => a.worker.localeCompare(b.worker));
}

function cycleRow(
  item: { number: number; title: string; createdAt: string | null; url?: string | null },
  completedAt: string | null,
  interval: ActivityReviewInterval,
): ActivityReviewCycleRow {
  const created = parseDate(item.createdAt);
  const completed = parseDate(completedAt);
  return {
    number: item.number,
    title: item.title,
    createdAt: item.createdAt,
    completedAt,
    durationDays: daysBetween(created, completed),
    openedBeforeInterval: created !== null && created.getTime() < interval.start.getTime(),
    url: item.url,
  };
}

export function buildActivityReviewReport(input: ActivityReviewInput): ActivityReviewReport {
  const interval = activityReviewInterval(input.kind, input.now);
  const issuesCreated = input.issues.filter((issue) => inRange(parseDate(issue.createdAt), interval));
  const issuesClosed = input.issues.filter((issue) => inRange(parseDate(issue.closedAt), interval));
  const prsCreated = input.pullRequests.filter((pr) => inRange(parseDate(pr.createdAt), interval));
  const prsClosed = input.pullRequests.filter((pr) => inRange(parseDate(pr.closedAt), interval));
  const prsMerged = input.pullRequests.filter((pr) => inRange(parseDate(pr.mergedAt), interval));
  const historyInRange = input.history.filter((record) => inRange(new Date(record.epoch * 1000), interval));
  const workers = buildWorkerSummaries(input.history, input.activeWorkers, interval);
  const challenges = input.issues
    .filter((issue) => {
      const relevant =
        inRange(parseDate(issue.closedAt), interval) ||
        inRange(parseDate(issue.createdAt), interval) ||
        (issue.comments ?? []).some((comment) => inRange(parseDate(comment.createdAt), interval));
      return relevant && isHitlOrBlocked(issue);
    })
    .map((issue) => ({
      issue: issue.number,
      title: issue.title,
      state: issue.state,
      why: challengeWhy(issue, historyInRange),
      resolution: challengeResolution(issue),
      labels: issue.labels,
      url: issue.url,
    }))
    .sort((a, b) => a.issue - b.issue);

  const warnings: string[] = [];
  if (!input.tokenSummary.available) {
    warnings.push("Token spend was not available in retained local worker logs; runner usage is best-effort and not guaranteed by the AFK artifact schema.");
  }

  return {
    schema_version: "red.dev.activity_review.v1",
    kind: input.kind,
    generated_at: input.now.toISOString(),
    interval: {
      start: interval.start.toISOString(),
      end: interval.end.toISOString(),
    },
    big_numbers: {
      issues_created: issuesCreated.length,
      issues_closed: issuesClosed.length,
      prs_created: prsCreated.length,
      prs_closed: prsClosed.length,
      prs_merged: prsMerged.length,
      commits: input.gitStats.commits,
      lines_added: input.gitStats.added,
      lines_removed: input.gitStats.removed,
      local_workers: workers.length,
      local_attempts: historyInRange.length,
      local_worker_seconds: workers.reduce((sum, worker) => sum + worker.durationSeconds + worker.activeSeconds, 0),
      tokens: input.tokenSummary,
    },
    workers,
    challenges,
    issue_cycle_times: issuesClosed
      .map((issue) => cycleRow(issue, issue.closedAt, interval))
      .sort((a, b) => a.number - b.number),
    pr_cycle_times: prsClosed
      .map((pr) => cycleRow(pr, pr.closedAt ?? pr.mergedAt, interval))
      .sort((a, b) => a.number - b.number),
    warnings,
  };
}

function fmtDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${r}s`;
  return `${r}s`;
}

function fmtDays(days: number | null): string {
  return days === null ? "n/a" : `${days}d`;
}

function fmtTokenSummary(tokens: ActivityReviewTokenSummary): string {
  if (!tokens.available) return "n/a";
  const parts: string[] = [];
  if (tokens.total !== null) parts.push(`total ${tokens.total}`);
  if (tokens.input !== null) parts.push(`input ${tokens.input}`);
  if (tokens.output !== null) parts.push(`output ${tokens.output}`);
  return parts.length > 0 ? parts.join(" / ") : "observed";
}

export function renderActivityReviewReport(report: ActivityReviewReport): string {
  const title = report.kind === "daily" ? "RedSkills daily review" : "RedSkills weekly review";
  const lines = [
    title,
    `generated: ${report.generated_at}`,
    `interval: ${report.interval.start} -> ${report.interval.end}`,
    "",
    "Big numbers",
    `  issues created: ${report.big_numbers.issues_created}`,
    `  issues closed: ${report.big_numbers.issues_closed}`,
    `  PRs created: ${report.big_numbers.prs_created}`,
    `  PRs closed: ${report.big_numbers.prs_closed}`,
    `  PRs merged: ${report.big_numbers.prs_merged}`,
    `  commits: ${report.big_numbers.commits}`,
    `  lines: +${report.big_numbers.lines_added} -${report.big_numbers.lines_removed}`,
    `  local workers: ${report.big_numbers.local_workers}`,
    `  local attempts: ${report.big_numbers.local_attempts}`,
    `  local worker time: ${fmtDuration(report.big_numbers.local_worker_seconds)}`,
    `  tokens: ${fmtTokenSummary(report.big_numbers.tokens)}`,
    "",
    "Local workers",
  ];

  if (report.workers.length === 0) {
    lines.push("  (none observed in retained local AFK history)");
  } else {
    for (const worker of report.workers) {
      const events = Object.entries(worker.events).map(([event, count]) => `${event}:${count}`).join(", ") || "active";
      const issues = worker.issues.length > 0 ? worker.issues.map((issue) => `#${issue}`).join(",") : "-";
      const runners = worker.runners.length > 0 ? worker.runners.join(",") : "-";
      lines.push(
        `  ${worker.worker}: attempts ${worker.attempts}, issues ${issues}, runner ${runners}, time ${fmtDuration(worker.durationSeconds + worker.activeSeconds)}, ${events}`,
      );
    }
  }

  lines.push("", "Challenges");
  if (report.challenges.length === 0) {
    lines.push("  (none detected)");
  } else {
    for (const challenge of report.challenges) {
      lines.push(`  #${challenge.issue} ${challenge.title}`);
      lines.push(`    why: ${challenge.why}`);
      lines.push(`    resolution: ${challenge.resolution}`);
    }
  }

  lines.push("", "Issue cycle times");
  if (report.issue_cycle_times.length === 0) {
    lines.push("  (no issues closed in interval)");
  } else {
    for (const row of report.issue_cycle_times) {
      const old = row.openedBeforeInterval ? " opened-before-interval" : "";
      lines.push(`  #${row.number} ${fmtDays(row.durationDays)}${old}  ${row.title}`);
    }
  }

  lines.push("", "PR cycle times");
  if (report.pr_cycle_times.length === 0) {
    lines.push("  (no PRs closed in interval)");
  } else {
    for (const row of report.pr_cycle_times) {
      const old = row.openedBeforeInterval ? " opened-before-interval" : "";
      lines.push(`  #${row.number} ${fmtDays(row.durationDays)}${old}  ${row.title}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push("", "Warnings");
    for (const warning of report.warnings) lines.push(`  ${warning}`);
  }

  return lines.join("\n");
}

/**
 * The default agent-facing render (PRD #928 / ADR 0081): the pre-computed report
 * as TOON. The `workers`, `challenges`, `issue_cycle_times`, and `pr_cycle_times`
 * arrays are uniform flat rows, so TOON names their fields once per table instead
 * of once per row -- the bulk of the saving over pretty JSON. Empty tables render
 * as the definitive `key[0]:` empty state.
 */
export function renderActivityReviewReportToon(report: ActivityReviewReport): string {
  return encodeToon(toToonSafeActivityReviewReport(report));
}

function toToonSafeActivityReviewReport(report: ActivityReviewReport): ToonValue {
  const payload = {
    ...report,
    workers: report.workers.map((worker) => ({
      ...worker,
      issues: worker.issues.length > 0 ? worker.issues.map((issue) => `#${issue}`).join(",") : "",
      runners: worker.runners.join(","),
      events: Object.entries(worker.events).map(([event, count]) => `${event}:${count}`).join(","),
    })),
    challenges: report.challenges.map((challenge) => ({
      ...challenge,
      labels: challenge.labels.join(","),
    })),
  };
  return JSON.parse(JSON.stringify(payload)) as ToonValue;
}
