import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode, encodeToonlLines } from "@reddb-io/toon";
import {
  activityReviewInterval,
  buildActivityReviewReport,
  renderActivityReviewReport,
  renderActivityReviewReportToon,
  type ActivityReviewIssue,
} from "../src/core/activity-review.js";
import { collectTokenSummary, collectTokensFromObject, parseGitLogStats } from "../src/commands/activity-review.js";
import type { HistoryRecord } from "../src/core/history.js";

const issue = (over: Partial<ActivityReviewIssue>): ActivityReviewIssue => ({
  number: 1,
  title: "Regular issue",
  state: "OPEN",
  createdAt: "2026-06-06T10:00:00.000Z",
  closedAt: null,
  labels: [],
  body: "",
  comments: [],
  ...over,
});

const history = (over: Partial<HistoryRecord>): HistoryRecord => ({
  ts: "2026-06-06T12:00:00.000Z",
  epoch: Math.floor(Date.parse("2026-06-06T12:00:00.000Z") / 1000),
  worker: "wTEST",
  issue: 1,
  event: "done",
  duration_s: 120,
  runner: "codex",
  ...over,
});

describe("activity review", () => {
  it("uses yesterday midnight for daily and six-days-ago midnight for weekly", () => {
    const now = new Date("2026-06-06T14:25:00.000Z");
    const daily = activityReviewInterval("daily", now).start;
    const weekly = activityReviewInterval("weekly", now).start;
    expect([daily.getFullYear(), daily.getMonth(), daily.getDate(), daily.getHours(), daily.getMinutes()]).toEqual([
      2026,
      5,
      5,
      0,
      0,
    ]);
    expect([weekly.getFullYear(), weekly.getMonth(), weekly.getDate(), weekly.getHours(), weekly.getMinutes()]).toEqual([
      2026,
      4,
      31,
      0,
      0,
    ]);
  });

  it("counts work in the interval and marks old issues closed during the interval", () => {
    const report = buildActivityReviewReport({
      kind: "daily",
      now: new Date("2026-06-06T14:25:00.000Z"),
      issues: [
        issue({ number: 1, createdAt: "2026-05-01T10:00:00.000Z", closedAt: "2026-06-05T12:00:00.000Z" }),
        issue({ number: 2, createdAt: "2026-06-06T10:00:00.000Z" }),
      ],
      pullRequests: [
        {
          number: 10,
          title: "Ship work",
          state: "MERGED",
          createdAt: "2026-06-05T04:00:00.000Z",
          closedAt: "2026-06-06T00:00:00.000Z",
          mergedAt: "2026-06-06T00:00:00.000Z",
        },
      ],
      gitStats: { commits: 3, added: 20, removed: 5 },
      history: [history({ issue: 1, event: "done", duration_s: 300 })],
      activeWorkers: [],
      tokenSummary: { available: false, total: null, input: null, output: null, sourceRecords: 0 },
    });

    expect(report.big_numbers).toMatchObject({
      issues_created: 1,
      issues_closed: 1,
      prs_created: 1,
      prs_closed: 1,
      prs_merged: 1,
      commits: 3,
      lines_added: 20,
      lines_removed: 5,
      local_workers: 1,
      local_attempts: 1,
      local_worker_seconds: 300,
    });
    expect(report.issue_cycle_times[0]).toMatchObject({
      number: 1,
      openedBeforeInterval: true,
    });
  });

  it("surfaces HITL and blocker evidence as challenges", () => {
    const report = buildActivityReviewReport({
      kind: "daily",
      now: new Date("2026-06-06T14:25:00.000Z"),
      issues: [
        issue({
          number: 7,
          title: "Needs decision",
          state: "CLOSED",
          createdAt: "2026-06-05T01:00:00.000Z",
          closedAt: "2026-06-06T01:00:00.000Z",
          labels: ["ready-for-human"],
          comments: [
            { body: "Human guidance: use the smaller migration.", createdAt: "2026-06-05T12:00:00.000Z" },
          ],
        }),
      ],
      pullRequests: [],
      gitStats: { commits: 0, added: 0, removed: 0 },
      history: [history({ issue: 7, event: "blocked", reason: "schema decision needed" })],
      activeWorkers: [],
      tokenSummary: { available: true, total: 100, input: 60, output: 40, sourceRecords: 1 },
    });

    expect(report.challenges).toHaveLength(1);
    expect(report.challenges[0]?.why).toBe("schema decision needed");
    expect(report.challenges[0]?.resolution).toContain("Human guidance");
    expect(renderActivityReviewReport(report)).toContain("Challenges");
  });

  it("counts active worker time only inside the review interval", () => {
    const now = new Date("2026-06-06T14:25:00.000Z");
    const interval = activityReviewInterval("daily", now);
    const report = buildActivityReviewReport({
      kind: "daily",
      now,
      issues: [],
      pullRequests: [],
      gitStats: { commits: 0, added: 0, removed: 0 },
      history: [],
      activeWorkers: [
        {
          worker: "wLIVE",
          runner: "codex",
          issue: 9,
          title: "Long-running work",
          startedAt: "2026-06-01T00:00:00.000Z",
          live: true,
        },
      ],
      tokenSummary: { available: false, total: null, input: null, output: null, sourceRecords: 0 },
    });

    expect(report.big_numbers.local_worker_seconds).toBe(
      Math.floor((now.getTime() - interval.start.getTime()) / 1000),
    );
  });

  it("renders the default agent-facing review as TOON with tabular tables", () => {
    const report = buildActivityReviewReport({
      kind: "daily",
      now: new Date("2026-06-06T14:25:00.000Z"),
      issues: [
        issue({ number: 7, title: "One", state: "CLOSED", closedAt: "2026-06-06T01:00:00.000Z" }),
      ],
      pullRequests: [],
      gitStats: { commits: 3, added: 10, removed: 2 },
      history: [],
      activeWorkers: [],
      tokenSummary: { available: false, total: null, input: null, output: null, sourceRecords: 0 },
    });
    const toon = renderActivityReviewReportToon(report);
    const decoded = decode(toon) as unknown as typeof report;
    expect(toon).toContain("schema_version: red.dev.activity_review.v1");
    expect(decoded.big_numbers.commits).toBe(3);
    // Empty tables render as the definitive empty state, not silent omission.
    expect(decoded.workers).toEqual([]);
    // Cheaper than the JSON baseline it replaces.
    expect(toon.length).toBeLessThan(JSON.stringify(report, null, 2).length);
  });

  it("parses commit counts and diffstat from git log output", () => {
    expect(parseGitLogStats([
      "commit:aaa",
      " 2 files changed, 10 insertions(+), 1 deletion(-)",
      "commit:bbb",
      " 1 file changed, 3 deletions(-)",
    ].join("\n"))).toEqual({ commits: 2, added: 10, removed: 4 });
  });

  it("collects tokens from old raw JSON strings and new structured raw payloads", () => {
    const oldRaw = {
      ts: "2026-06-06T12:00:00.000Z",
      type: "raw",
      msg: "{\"type\":\"usage\",\"inputTokens\":3,\"outputTokens\":5}",
    };
    const newRaw = {
      ts: "2026-06-06T12:00:01.000Z",
      type: "raw",
      msg: { iteration: 1, line: "{\"type\":\"usage\",\"inputTokens\":7,\"outputTokens\":11}" },
    };

    expect(collectTokensFromObject(oldRaw)).toEqual({ input: 3, output: 5, total: 0, hits: 2 });
    expect(collectTokensFromObject(newRaw)).toEqual({ input: 7, output: 11, total: 0, hits: 2 });
  });

  it("activity-review token scan reads the canonical Worker log", async () => {
    const root = await mkdtemp(join(tmpdir(), "activity-review-firehose-"));
    const workerDir = join(root, "wAAAA");
    await mkdir(workerDir, { recursive: true });
    const log = join(workerDir, "worker.log.toonl");
    const lane = encodeToonlLines({ trailer: false });
    await writeFile(
      log,
      lane.push({ at: "2026-07-15T11:00:00.000Z", kind: "worker.stdout", msg: "{\"inputTokens\":3,\"outputTokens\":5}" })
        + lane.push({ at: "2026-07-15T12:00:00.000Z", kind: "worker.stdout", msg: "{\"inputTokens\":7,\"outputTokens\":11}" }),
      "utf8",
    );

    const summary = await collectTokenSummary(
      root,
      new Date("2026-07-15T00:00:00.000Z"),
      new Date("2026-07-16T00:00:00.000Z"),
    );
    expect(summary).toEqual({ available: true, input: 10, output: 16, total: null, sourceRecords: 2 });
  });

  it("activity-review token scan resumes from disposable cursor state without changing results", async () => {
    const root = await mkdtemp(join(tmpdir(), "activity-review-cursor-"));
    const workerDir = join(root, "wAAAA");
    await mkdir(workerDir, { recursive: true });
    const log = join(workerDir, "worker.log.toonl");
    const lane = encodeToonlLines({ trailer: false });
    await writeFile(log, lane.push({ at: "2026-07-15T12:00:00.000Z", kind: "worker.stdout", msg: "{\"inputTokens\":7,\"outputTokens\":11}" }));
    const start = new Date("2026-07-15T00:00:00.000Z");
    const end = new Date("2026-07-16T00:00:00.000Z");

    const first = await collectTokenSummary(root, start, end);
    expect(first).toEqual({ available: true, input: 7, output: 11, total: null, sourceRecords: 1 });
    const cacheRaw = await readFile(join(root, ".activity-review-token-cursors.json"), "utf8");
    expect(cacheRaw.trimStart().startsWith("{")).toBe(false);
    // The per-file map sits under one envelope key so `rows` never lands a level below the document
    // root, where toon 0.13.0 reads it as the cyclic-array wire's meta key (issue #3072).
    const decoded = decode(cacheRaw) as Record<string, unknown>;
    expect(Object.keys(decoded)).toEqual(["files"]);
    expect(Object.values(decoded.files as Record<string, unknown>)[0]).toMatchObject({
      rows: [{ input: 7, output: 11, total: 0 }],
    });

    await appendFile(log, lane.push({ at: "2026-07-15T12:05:00.000Z", kind: "worker.stdout", msg: "{\"inputTokens\":13,\"outputTokens\":17}" }));
    const resumed = await collectTokenSummary(root, start, end);
    expect(resumed).toEqual({ available: true, input: 20, output: 28, total: null, sourceRecords: 2 });

    await writeFile(join(root, ".activity-review-token-cursors.json"), "", "utf8");
    const cold = await collectTokenSummary(root, start, end);
    expect(cold).toEqual(resumed);
  });
});
