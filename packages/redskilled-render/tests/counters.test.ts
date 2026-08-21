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
import { trunkLinesToken } from "../counters.js";
import { counters, payload } from "./fixture.js";

const LOCAL = { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" };
const TABLE = { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" };

const FIVE = { open_pull_requests: 3, open_issues: 24, merged_today: 7, ready_queue: 5, human_queue: 2 };

describe("remote counters ride the daemon payload", () => {
  it("renders the compact daemon tail without repeating the project label", () => {
    const line = stripAnsi(
      renderRedskilledStatusline(payload({ remote_counters: counters(FIVE) }), LOCAL).line,
    );

    expect(line).toBe("1w rdy=5 pr=3 mrg=7 512M v3.3.11");
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

    expect(fresh).toContain("rdy=5 pr=3 mrg=7");
    expect(fresh).not.toContain("(");
    expect(stale).toContain("rdy=5(15m) pr=3(15m) mrg=7(15m)");
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
    expect(line).toContain("pr=3");
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

    // The table separates its parts and the line does not; a counter both draw
    // carries the same value and the same age either way. The LINE draws three
    // of the four — `iss` costs width the day's landed volume needed more, and
    // the table, which has the room, keeps it.
    expect(header).toContain("rdy=5(15m) · iss=24(15m) · pr=3(15m) · mrg=7(15m)");
    expect(header).not.toContain("!counts stale");
    for (const token of ["rdy=5(15m)", "pr=3(15m)", "mrg=7(15m)"]) {
      expect(line).toContain(token);
    }
    expect(line).not.toContain("iss=");
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

    expect(line).toContain("pr=3");
    expect(line).not.toContain("cpr=");
    expect(line).not.toContain("rdy=");
    expect(header).toContain("iss=24 · pr=3");
    expect(header).not.toContain("cpr=");
    expect(header).toContain("!counts stale");
  });
});

describe("the day's landed lines ride the same poll as the merge count", () => {
  const activity = (
    counts: Record<string, number | null> | null,
    project = "acme/widgets",
  ) => ({
    fetched_at: "2026-08-03T00:02:00.000Z",
    age_ms: 5_000,
    stale: false,
    reason: "fetched 5000ms ago",
    projects: [{ project_label: project, repository: project, counts: counts as never }],
  });

  it("renders the landed volume beside the merge counter", () => {
    const line = stripAnsi(
      renderRedskilledStatusline(
        payload({
          remote_counters: counters(FIVE),
          repository_activity: activity({
            open_pull_requests: 3,
            open_issues: 24,
            recently_closed: 1,
            merged_today: 7,
            trunk_lines_added: 12_400,
            trunk_lines_removed: 3_100,
          }),
        }),
        LOCAL,
      ).line,
    );

    expect(line).toContain("mrg=7 +12.4k -3.1k");
  });

  it("humanizes through the one humanizer, keeping a whole thousand whole", () => {
    expect(
      trunkLinesToken(
        payload({ repository_activity: activity({ trunk_lines_added: 12_000, trunk_lines_removed: 940 }) }),
        "acme/widgets",
      ),
    ).toBe("+12k -940");
  });

  it("states an absence rather than a calm zero when the poll could not measure", () => {
    expect(
      trunkLinesToken(
        payload({ repository_activity: activity({ trunk_lines_added: null, trunk_lines_removed: null }) }),
        "acme/widgets",
      ),
    ).toBeNull();
  });

  it("says nothing on a day the trunk did not move — the no-zero-noise rule", () => {
    expect(
      trunkLinesToken(
        payload({ repository_activity: activity({ trunk_lines_added: 0, trunk_lines_removed: 0 }) }),
        "acme/widgets",
      ),
    ).toBeNull();
  });

  it("says nothing for a daemon that predates the measurement, and for another project's", () => {
    expect(trunkLinesToken(payload({ repository_activity: activity({ merged_today: 7 }) }), "acme/widgets"))
      .toBeNull();
    expect(
      trunkLinesToken(
        payload({ repository_activity: activity({ trunk_lines_added: 5, trunk_lines_removed: 1 }, "other/repo") }),
        "acme/widgets",
      ),
    ).toBeNull();
  });
});
