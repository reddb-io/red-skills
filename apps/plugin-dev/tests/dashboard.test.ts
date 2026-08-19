import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  aggregateImplementerRuntimeMetrics,
  buildDashboardReport,
  parseDueDate,
  renderDashboardReport,
  renderDashboardReportToon,
  type DashboardIssue,
} from "../src/core/dashboard.js";

const issue = (over: Partial<DashboardIssue>): DashboardIssue => ({
  number: 1,
  title: "Regular issue",
  state: "OPEN",
  createdAt: "2026-06-01T00:00:00Z",
  closedAt: null,
  labels: [],
  body: "",
  ...over,
});

describe("dashboard report", () => {
  it("aggregates per-run implementer deltas for the throughput reader", () => {
    expect(
      aggregateImplementerRuntimeMetrics([
        {
          runner_startup_before_ms: 900,
          runner_startup_after_ms: 500,
          skill_manifest_before_bytes: 4000,
          skill_manifest_after_bytes: 1000,
        },
        {
          runner_startup_before_ms: 700,
          runner_startup_after_ms: 400,
          skill_manifest_before_bytes: 3000,
          skill_manifest_after_bytes: 900,
        },
      ]),
    ).toEqual({
      samples: 2,
      runner_startup_ms: { before: 800, after: 450, delta: -350 },
      skill_manifest_bytes: { before: 3500, after: 950, delta: -2550 },
    });
  });

  it("counts operational issue states, local workers, and due-date buckets", () => {
    const report = buildDashboardReport({
      now: new Date("2026-06-05T12:00:00Z"),
      periodDays: 30,
      localWorkers: { live: 2, stale: 1, total: 3 },
      issues: [
        issue({ number: 1, title: "Spec: dashboard", labels: ["type:spec"] }),
        issue({ number: 2, labels: ["running"], body: "due: 2026-06-05" }),
        issue({ number: 3, body: "deadline: 2026-06-01" }),
        issue({
          number: 4,
          state: "CLOSED",
          createdAt: "2026-06-01T00:00:00Z",
          closedAt: "2026-06-05T00:00:00Z",
        }),
      ],
      pullRequests: [],
      releases: [],
    });

    expect(report.operations).toMatchObject({
      open_specs: 1,
      open_issues: 2,
      global_running_workers: 1,
      local_workers: { live: 2, stale: 1, total: 3 },
      issues_created_in_period: 4,
      issues_closed_today: 1,
      issues_closed_in_period: 1,
      issues_due_today: 1,
      issues_due_in_period: 2,
      overdue_open_issues: 1,
    });
    expect(report.flow.average_issue_cycle_time_days).toBe(4);
  });

  it("computes flow and DORA proxy metrics from PRs, releases, and failure-like issues", () => {
    const report = buildDashboardReport({
      now: new Date("2026-06-05T12:00:00Z"),
      periodDays: 30,
      localWorkers: { live: 0, stale: 0, total: 0 },
      issues: [
        issue({
          number: 10,
          state: "CLOSED",
          labels: ["type:bug"],
          createdAt: "2026-06-01T00:00:00Z",
          closedAt: "2026-06-03T00:00:00Z",
        }),
      ],
      pullRequests: [
        {
          number: 1,
          title: "ship",
          state: "MERGED",
          createdAt: "2026-06-01T00:00:00Z",
          closedAt: "2026-06-02T00:00:00Z",
          mergedAt: "2026-06-02T00:00:00Z",
        },
      ],
      releases: [
        {
          tagName: "v1.2.3",
          publishedAt: "2026-06-04T00:00:00Z",
          isDraft: false,
          isPrerelease: false,
        },
      ],
    });

    expect(report.flow).toMatchObject({
      open_prs: 0,
      prs_merged_in_period: 1,
      average_pr_lead_time_days: 1,
    });
    expect(report.dora).toMatchObject({
      deployment_frequency_in_period: 1,
      lead_time_for_changes_days: 1,
      change_failure_rate_proxy: 1,
      failure_like_issues_closed_in_period: 1,
      mttr_days_proxy: 2,
    });
  });

  it("parses due dates from labels and issue body fields", () => {
    expect(parseDueDate(issue({ labels: ["due:2026-06-07"] }))?.toISOString()).toBe(
      "2026-06-07T00:00:00.000Z",
    );
    expect(parseDueDate(issue({ body: "target date: 2026-06-08" }))?.toISOString()).toBe(
      "2026-06-08T00:00:00.000Z",
    );
  });

  it("renders a readable text dashboard", () => {
    const report = buildDashboardReport({
      now: new Date("2026-06-05T12:00:00Z"),
      periodDays: 7,
      localWorkers: {
        live: 1,
        stale: 0,
        total: 1,
        implementer_runtime: {
          samples: 1,
          runner_startup_ms: { before: 840, after: 510, delta: -330 },
          skill_manifest_bytes: { before: 4200, after: 1300, delta: -2900 },
        },
      },
      issues: [],
      pullRequests: [],
      releases: [],
    });
    const text = renderDashboardReport(report);
    expect(text).toContain("RedSkills dashboard (7d)");
    expect(text).toContain("Operations");
    expect(text).toContain("implementer runtime samples: 1");
    expect(text).toContain("runner startup: 840ms → 510ms (-330ms)");
    expect(text).toContain("skill manifest: 4200B → 1300B (-2900B)");
    expect(text).toContain("DORA proxies");
  });

  it("renders the default agent-facing dashboard as TOON, cheaper than JSON", () => {
    const report = buildDashboardReport({
      now: new Date("2026-06-05T12:00:00Z"),
      periodDays: 7,
      localWorkers: { live: 2, stale: 1, total: 3 },
      issues: [],
      pullRequests: [],
      releases: [],
    });
    const toon = renderDashboardReportToon(report);
    const decoded = decode(toon) as unknown as typeof report & { summary: string };
    // Indentation key:value tree with nested groups and a definitive empty state.
    expect(toon).toContain("schema_version: red.dev.dashboard.v1");
    expect(decoded.operations.open_specs).toBe(0);
    expect(decoded.operations.local_workers).toEqual({ live: 2, stale: 1, total: 3 });
    expect(decoded.warnings).toEqual(report.warnings);
    expect(decoded.summary).toBe("0 open issues · 0 open specs · 0 open PRs · 0 deployments");
    // No field name is repeated per element the way pretty JSON repeats keys.
    expect(toon.length).toBeLessThan(JSON.stringify(report, null, 2).length);
  });
});
