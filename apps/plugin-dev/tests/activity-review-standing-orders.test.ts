import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  buildActivityReviewReport,
  renderActivityReviewReport,
  renderActivityReviewReportToon,
  renderStandingOrderPromotions,
  standingOrderPromotionCandidates,
  STANDING_ORDER_PROMOTION_MIN_DRAINS,
  activityReviewInterval,
  type ActivityReviewInput,
  type ActivityReviewStandingOrder,
} from "../src/core/activity-review.js";

const NOW = new Date("2026-08-19T12:00:00.000Z");

/** The recurring order the fixture drains share, spelled as the operator wrote it. */
const RECURRING = "Run the repo gate before pushing.";

function order(
  drain: string,
  n: number,
  text: string,
  ts: string | null,
): ActivityReviewStandingOrder {
  return { drain, n, text, ts };
}

function reviewInput(
  kind: "daily" | "weekly",
  standingOrders: ActivityReviewStandingOrder[],
): ActivityReviewInput {
  return {
    kind,
    now: NOW,
    issues: [],
    pullRequests: [],
    gitStats: { commits: 0, added: 0, removed: 0 },
    history: [],
    activeWorkers: [],
    tokenSummary: { available: true, total: 10, input: 6, output: 4, sourceRecords: 1 },
    standingOrders,
  };
}

describe("standingOrderPromotionCandidates — recurrence across the week's drains", () => {
  const interval = activityReviewInterval("weekly", NOW);

  it("flags an order two drains share, naming the order and both drains", () => {
    const candidates = standingOrderPromotionCandidates(
      [
        order("drain-mon", 1, RECURRING, "2026-08-15T09:00:00.000Z"),
        order("drain-mon", 2, "Prefer REST over GraphQL here.", "2026-08-15T10:00:00.000Z"),
        order("drain-thu", 1, "run the repo gate before pushing", "2026-08-18T09:00:00.000Z"),
      ],
      interval,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      text: RECURRING,
      drains: ["drain-mon", "drain-thu"],
      occurrences: 2,
      firstSeen: "2026-08-15T09:00:00.000Z",
      lastSeen: "2026-08-18T09:00:00.000Z",
    });
  });

  it("does not flag an order seen in a single drain, however often it was appended", () => {
    const candidates = standingOrderPromotionCandidates(
      [
        order("drain-mon", 1, "Only this drain says so.", "2026-08-15T09:00:00.000Z"),
        order("drain-mon", 2, "Only this drain says so.", "2026-08-15T11:00:00.000Z"),
      ],
      interval,
    );

    expect(candidates).toEqual([]);
    expect(STANDING_ORDER_PROMOTION_MIN_DRAINS).toBe(2);
  });

  it("leaves an order stamped outside the week out of the comparison", () => {
    const candidates = standingOrderPromotionCandidates(
      [
        order("drain-old", 1, RECURRING, "2026-06-01T09:00:00.000Z"),
        order("drain-thu", 1, RECURRING, "2026-08-18T09:00:00.000Z"),
      ],
      interval,
    );

    expect(candidates).toEqual([]);
  });
});

describe("weekly_review report — the promotion-candidates section", () => {
  const shared = [
    order("drain-mon", 1, RECURRING, "2026-08-15T09:00:00.000Z"),
    order("drain-thu", 1, RECURRING, "2026-08-18T09:00:00.000Z"),
    order("drain-thu", 2, "Only this drain says so.", "2026-08-18T09:30:00.000Z"),
  ];

  it("reports the recurring order with the drains it recurred in", () => {
    const report = buildActivityReviewReport(reviewInput("weekly", shared));

    expect(report.standing_order_promotions).toEqual([
      {
        text: RECURRING,
        drains: ["drain-mon", "drain-thu"],
        occurrences: 2,
        firstSeen: "2026-08-15T09:00:00.000Z",
        lastSeen: "2026-08-18T09:00:00.000Z",
      },
    ]);

    const rendered = renderActivityReviewReport(report);
    expect(rendered).toContain("Standing order promotion candidates");
    expect(rendered).toContain(RECURRING);
    expect(rendered).toContain("recurred in 2 drains (drain-mon, drain-thu), 2 appends");
    expect(rendered).not.toContain("Only this drain says so.");
    expect(renderStandingOrderPromotions(report).join("\n")).toContain(
      "promote by PR into CLAUDE.md; this review writes nothing.",
    );
  });

  it("carries the candidate through the TOON render as one flat row", () => {
    const payload = decode(
      renderActivityReviewReportToon(buildActivityReviewReport(reviewInput("weekly", shared))),
    ) as { standing_order_promotions: Array<{ text: string; drains: string; occurrences: number }> };

    expect(payload.standing_order_promotions).toEqual([
      expect.objectContaining({ text: RECURRING, drains: "drain-mon,drain-thu", occurrences: 2 }),
    ]);
  });

  it("says so plainly when no order recurred", () => {
    const report = buildActivityReviewReport(
      reviewInput("weekly", [order("drain-mon", 1, "Only this drain says so.", "2026-08-15T09:00:00.000Z")]),
    );

    expect(report.standing_order_promotions).toEqual([]);
    expect(renderActivityReviewReport(report)).toContain(
      "(no standing order recurred across drains this week)",
    );
  });

  it("warns rather than guesses when a register row carries no stamp", () => {
    const report = buildActivityReviewReport(
      reviewInput("weekly", [
        order("drain-mon", 1, RECURRING, null),
        order("drain-thu", 1, RECURRING, "2026-08-18T09:00:00.000Z"),
      ]),
    );

    expect(report.standing_order_promotions).toEqual([]);
    expect(report.warnings.join("\n")).toContain(
      "1 standing order(s) carry no usable timestamp",
    );
  });

  it("keeps promotion candidates out of the daily window", () => {
    const report = buildActivityReviewReport(reviewInput("daily", shared));

    expect(report.standing_order_promotions).toEqual([]);
    expect(renderActivityReviewReport(report)).not.toContain("Standing order promotion candidates");
  });
});

describe("the review changes nothing on its own", () => {
  it("writes to neither CLAUDE.md nor the standing-orders register", () => {
    const dir = mkdtempSync(join(tmpdir(), "activity-review-readonly-"));
    const claudeMd = join(dir, "CLAUDE.md");
    const register = join(dir, "redskilled.orders.toonl");
    writeFileSync(claudeMd, "# Project instructions\n", "utf8");
    writeFileSync(
      register,
      [
        JSON.stringify({ version: 1, n: 1, text: RECURRING, ts: "2026-08-15T09:00:00.000Z" }),
        JSON.stringify({ version: 1, n: 1, text: RECURRING, ts: "2026-08-18T09:00:00.000Z" }),
        "",
      ].join("\n"),
      "utf8",
    );

    const snapshot = (): string =>
      JSON.stringify(
        readdirSync(dir).sort().map((name) => {
          const path = join(dir, name);
          const stats = statSync(path);
          return [name, readFileSync(path, "utf8"), stats.size, stats.mtimeMs];
        }),
      );
    const before = snapshot();

    const report = buildActivityReviewReport(
      reviewInput("weekly", [
        order("drain-mon", 1, RECURRING, "2026-08-15T09:00:00.000Z"),
        order("drain-thu", 1, RECURRING, "2026-08-18T09:00:00.000Z"),
      ]),
    );
    renderActivityReviewReport(report);
    renderActivityReviewReportToon(report);

    // The signal is reported...
    expect(report.standing_order_promotions).toHaveLength(1);
    // ...and promotion stays a human PR: nothing on disk moved.
    expect(snapshot()).toBe(before);
  });
});
