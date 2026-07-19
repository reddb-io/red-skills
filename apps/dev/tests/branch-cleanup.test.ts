import { describe, expect, it } from "vitest";
import {
  attemptIssueFromBranch,
  branchesToKeep,
  branchesToReap,
  classifyIssueState,
  liveIssueFromBranch,
  planLiveBranchCleanup,
  planLocalBranchCleanup,
  type BranchRef,
  type IssueLookup,
  type IssueMeta,
} from "../src/core/branch-cleanup.js";

const DAY = 86400;
const NOW = 1700000000;

/** Build a CLOSED issue meta with closedAt N seconds before NOW. */
function closedAgo(seconds: number): IssueMeta {
  return { state: "CLOSED", closedAt: new Date((NOW - seconds) * 1000).toISOString() };
}

/** Construct an injectable lookup from a fixture map keyed by issue number.
 * A missing key returns undefined (transient), matching the bash gh-500 path. */
function lookupFrom(map: Record<number, IssueMeta | null | undefined>): IssueLookup {
  return (issue) => (issue in map ? map[issue] : undefined);
}

function action(decisions: ReturnType<typeof planLiveBranchCleanup>, branch: string): string | undefined {
  return decisions.find((d) => d.branch === branch)?.action;
}

describe("ref parsing", () => {
  it("parses the issue from a live ref and rejects the snapshot namespace", () => {
    expect(liveIssueFromBranch("afk/wAAA/142-some-slug")).toBe(142);
    expect(liveIssueFromBranch("afk-attempts/wAAA/142-some-slug")).toBeNull();
    expect(liveIssueFromBranch("feature/142-not-afk")).toBeNull();
    expect(liveIssueFromBranch("afk/wAAA/notanumber-slug")).toBeNull();
  });

  it("keeps legacy snapshot ref parsing available for old attempt ledgers only", () => {
    expect(attemptIssueFromBranch("afk-attempts/wAAA/300-old-completed")).toBe(300);
    expect(attemptIssueFromBranch("afk/wAAA/300-live")).toBeNull();
    expect(attemptIssueFromBranch("afk-attempts/wAAA/bad-slug")).toBeNull();
  });
});

describe("classifyIssueState", () => {
  it("maps gh metadata onto the S1 vocabulary by the grace window", () => {
    expect(classifyIssueState({ state: "OPEN" }, NOW, 7 * DAY)).toBe("open");
    expect(classifyIssueState(closedAgo(1 * DAY), NOW, 7 * DAY)).toBe("closed-within-grace");
    expect(classifyIssueState(closedAgo(30 * DAY), NOW, 7 * DAY)).toBe("closed-past-grace");
    expect(classifyIssueState(null, NOW, 7 * DAY)).toBe("not-found");
    expect(classifyIssueState(undefined, NOW, 7 * DAY)).toBe("unresolved-transient");
    // CLOSED without a parseable closedAt is transient, never silently reaped.
    expect(classifyIssueState({ state: "CLOSED", closedAt: "" }, NOW, 7 * DAY)).toBe("unresolved-transient");
    expect(classifyIssueState({ state: "CLOSED", closedAt: "garbage" }, NOW, 7 * DAY)).toBe(
      "unresolved-transient",
    );
    // grace 0 → any issue closed in the past is past grace (now - closedAt > 0).
    expect(classifyIssueState(closedAgo(1), NOW, 0)).toBe("closed-past-grace");
    // Boundary: exactly at the window is still within grace (strict > , mirrors bash).
    expect(classifyIssueState(closedAgo(0), NOW, 0)).toBe("closed-within-grace");
  });
});

describe("remote live reaper (afk/*)", () => {
  const refs: BranchRef[] = [
    { branch: "afk/wAAA/500-closed" },
    { branch: "afk/wBBB/501-open" },
    { branch: "afk/wCCC/502-rate-limited" },
    { branch: "afk/wDDD/503-missing" },
  ];
  const lookup = lookupFrom({
    500: closedAgo(1 * DAY), // closed → within-grace, but live policy reaps on close
    501: { state: "OPEN" },
    502: undefined, // transient
    503: null, // 404
  });

  it("reaps closed-issue branches and keeps open / transient / not-found", () => {
    const decisions = planLiveBranchCleanup(refs, lookup, NOW);
    expect(action(decisions, "afk/wAAA/500-closed")).toBe("reap");
    expect(action(decisions, "afk/wBBB/501-open")).toBe("keep");
    expect(action(decisions, "afk/wCCC/502-rate-limited")).toBe("keep");
    expect(action(decisions, "afk/wDDD/503-missing")).toBe("keep");
  });

  it("reaps a closed issue regardless of how recently it closed (no grace)", () => {
    const justClosed = planLiveBranchCleanup(
      [{ branch: "afk/wAAA/600-just-closed" }],
      lookupFrom({ 600: closedAgo(0) }),
      NOW,
    );
    expect(justClosed[0]).toMatchObject({ action: "reap" });
  });

  it("ignores snapshot-namespace and malformed refs", () => {
    const mixed: BranchRef[] = [
      { branch: "afk-attempts/wEEE/500-snapshot" },
      { branch: "afk/wAAA/notanumber-slug" },
    ];
    expect(planLiveBranchCleanup(mixed, lookup, NOW)).toEqual([]);
  });
});

describe("local live reaper (afk/*)", () => {
  // Mirrors local-branch-cleanup.test.sh: #274 closed → reap, #275 open → keep.
  // The bash reaper also skips checked-out branches and the afk-attempts/*
  // namespace; both are the caller's responsibility, so they are simply absent
  // from the refs handed to the planner here.
  it("deletes closed-issue branches and keeps open ones", () => {
    const refs: BranchRef[] = [
      { branch: "afk/wAAA/274-closed" },
      { branch: "afk/wBBB/275-open" },
    ];
    const lookup = lookupFrom({ 274: closedAgo(20 * DAY), 275: { state: "OPEN" } });
    const decisions = planLocalBranchCleanup(refs, lookup, NOW);

    expect(branchesToReap(decisions).map((d) => d.branch)).toEqual(["afk/wAAA/274-closed"]);
    expect(branchesToKeep(decisions).map((d) => d.branch)).toEqual(["afk/wBBB/275-open"]);
  });

  it("never reaps a snapshot-namespace ref that leaks in", () => {
    const decisions = planLocalBranchCleanup(
      [{ branch: "afk-attempts/wAAA/274-snapshot" }],
      lookupFrom({ 274: closedAgo(20 * DAY) }),
      NOW,
    );
    expect(decisions).toEqual([]);
  });
});

describe("issue-state caching", () => {
  it("classifies each issue exactly once across its branches", () => {
    const calls: number[] = [];
    const lookup: IssueLookup = (issue) => {
      calls.push(issue);
      return closedAgo(30 * DAY);
    };
    planLiveBranchCleanup(
      [
        { branch: "afk/wAAA/300-x", commitS: NOW - 30 * DAY },
        { branch: "afk/wBBB/300-y", commitS: NOW - 30 * DAY },
      ],
      lookup,
      NOW,
    );
    expect(calls).toEqual([300]);
  });
});
