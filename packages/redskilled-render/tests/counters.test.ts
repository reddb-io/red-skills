/**
 * counters — the four remote numbers, drawn from the daemon's dated block.
 *
 * The claims are about what a READER sees: which counters reach the line, what a
 * stale one says about itself, what an absent one costs, and that the two
 * densities that draw them cannot disagree about one poll.
 */
import { describe, expect, it } from "vitest";
import {
  renderRedskilledDashboard,
  renderRedskilledStatusline,
  REDSKILLED_DASHBOARD_DEFAULTS,
  REDSKILLED_STATUSLINE_DEFAULTS,
  remoteCounterTokens,
  stripAnsi,
} from "../index.js";
import { counters, payload } from "./fixture.js";

const LOCAL = { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" };
const TABLE = { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" };

const FIVE = { open_pull_requests: 3, open_issues: 24, merged_today: 7, ready_queue: 5, human_queue: 2 };

describe("remote counters ride the daemon payload", () => {
  it("renders the compact daemon tail without repeating the project label", () => {
    const line = stripAnsi(
      renderRedskilledStatusline(payload({ remote_counters: counters(FIVE) }), LOCAL).line,
    );

    expect(line).toBe("1w rdy=5 iss=24 pr=3 mrg=7 512M v3.3.11");
    expect(line).not.toContain("acme/widgets");
  });

  it("states the age of a counter served past its window, and only then", () => {
    const fresh = stripAnsi(
      renderRedskilledStatusline(
        payload({ remote_counters: counters(FIVE, { ageMs: 5_000, thresholdMs: 120_000 }) }),
        LOCAL,
      ).line,
    );
    const stale = stripAnsi(
      renderRedskilledStatusline(
        payload({ remote_counters: counters(FIVE, { ageMs: 900_000, thresholdMs: 120_000 }) }),
        LOCAL,
      ).line,
    );

    expect(fresh).toContain("rdy=5 iss=24 pr=3 mrg=7");
    expect(fresh).not.toContain("(");
    expect(stale).toContain("rdy=5(15m) iss=24(15m) pr=3(15m) mrg=7(15m)");
  });

  it("costs the line nothing for a counter this poll never produced", () => {
    const line = stripAnsi(
      renderRedskilledStatusline(
        payload({ remote_counters: counters({ open_pull_requests: 3, open_issues: 24 }) }),
        LOCAL,
      ).line,
    );

    // NOT `rdy=0`: a queue nobody counted and a queue that drained are different
    // facts, and only one of them is a number.
    expect(line).toContain("iss=24 pr=3");
    expect(line).not.toContain("rdy=");
    expect(line).not.toContain("hmn=");
  });

  it("draws no repository counters on a host-wide head", () => {
    const line = stripAnsi(
      renderRedskilledStatusline(
        payload({ remote_counters: counters(FIVE) }),
        { ...LOCAL, mode: "global" },
      ).line,
    );

    expect(line).not.toContain("pr=");
    expect(line).not.toContain("rdy=");
  });

  it("draws nothing for a project this host holds no counters for", () => {
    expect(
      remoteCounterTokens(payload({ remote_counters: counters(FIVE) }), "other/repo"),
    ).toEqual([]);
    expect(remoteCounterTokens(payload({ remote_counters: counters(FIVE) }), null)).toEqual([]);
  });

  it("gives the table and the line the same counters for one poll", () => {
    const document = payload({
      remote_counters: counters(FIVE, { ageMs: 900_000, thresholdMs: 120_000 }),
    });
    const line = stripAnsi(renderRedskilledStatusline(document, LOCAL).line);
    const header = stripAnsi(renderRedskilledDashboard(document, TABLE).header.line);

    // The table separates its parts and the line does not; the counters, their
    // order and their ages are the same poll either way.
    expect(header).toContain("rdy=5(15m) · iss=24(15m) · pr=3(15m) · mrg=7(15m)");
    expect(header).not.toContain("!counts stale");
    for (const token of ["rdy=5(15m)", "iss=24(15m)", "pr=3(15m)", "mrg=7(15m)"]) {
      expect(line).toContain(token);
    }
    expect(renderRedskilledDashboard(document, TABLE).header.counts).toMatchObject({
      open_pull_requests: 3,
      merged_today: 7,
      open_issues: 24,
      ready_queue: 5,
      human_queue: 2,
    });
  });

  it("keeps a pre-block daemon's poll-dated counts and its blanket marker", () => {
    // ADR 0130 rule 3: one daemon serves checkouts pinned to different bundles,
    // so a payload without the dated block still renders every count it has.
    const document = payload({
      repository_activity: {
        fetched_at: "2026-08-03T00:00:00.000Z",
        age_ms: 900_000,
        stale: true,
        reason: "counted 900000ms ago",
        projects: [
          {
            project_label: "acme/widgets",
            repository: "acme/widgets",
            counts: { open_pull_requests: 3, open_issues: 24, recently_closed: 7 },
            stale: true,
          },
        ],
      },
    });

    const line = stripAnsi(renderRedskilledStatusline(document, LOCAL).line);
    const header = stripAnsi(renderRedskilledDashboard(document, TABLE).header.line);

    expect(line).toContain("iss=24 pr=3");
    expect(line).not.toContain("cpr=");
    expect(line).not.toContain("rdy=");
    expect(header).toContain("iss=24 · pr=3");
    expect(header).not.toContain("cpr=");
    expect(header).toContain("!counts stale");
  });
});
