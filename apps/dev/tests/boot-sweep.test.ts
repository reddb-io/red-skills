import { describe, expect, it } from "vitest";
import {
  auditComment,
  cascadeAuditComment,
  executeUnblockSweep,
  findOwnedBranch,
  isParkedMechanical,
  issueFromAFKBranch,
  parseBlockedBy,
  executeMixedBlockedNormalize,
  parseReqLabels,
  planCloseCascade,
  planMixedBlockedNormalize,
  type MixedBlockedCandidate,
  planReconcileSweep,
  planUnblockSweep,
  refToNumber,
  shouldPromote,
  shouldWarnStragglers,
  stragglerCounts,
  type DependencyClosureState,
  type DependentIssue,
  type ReconcileSweepCandidate,
  type StragglerCountLookup,
  type UnblockCandidate,
} from "../src/core/boot-sweep.js";

describe("parseBlockedBy", () => {
  it("extracts a single ref under the heading", () => {
    const body = "## Blocked by\n\n- [ ] #123\n";
    expect(parseBlockedBy(body)).toEqual(["#123"]);
  });

  it("extracts many refs in sorted-unique (lexical) order", () => {
    const body = "## Blocked by\n- [ ] #10\n- [x] #2\n- [ ] #10\n";
    // `sort -u` is lexical, so #10 sorts before #2 and the dup collapses.
    expect(parseBlockedBy(body)).toEqual(["#10", "#2"]);
  });

  it("ignores checkbox state — checked and unchecked both count", () => {
    const body = "## Blocked by\n- [x] #1\n- [ ] #2\n";
    expect(parseBlockedBy(body)).toEqual(["#1", "#2"]);
  });

  it("stops at the next ## heading", () => {
    const body = "## Blocked by\n- [ ] #1\n## What to build\n- [ ] #999\n";
    expect(parseBlockedBy(body)).toEqual(["#1"]);
  });

  it("ignores refs before the heading", () => {
    const body = "## Parent\nSpec #500\n## Blocked by\n- [ ] #1\n";
    expect(parseBlockedBy(body)).toEqual(["#1"]);
  });

  it("returns [] when there is no Blocked by section", () => {
    expect(parseBlockedBy("## What to build\njust prose with #42 in it")).toEqual([]);
  });

  it("returns [] for an empty / 'None' Blocked by section", () => {
    expect(parseBlockedBy("## Blocked by\n\nNone\n\n## What to build")).toEqual([]);
  });

  it("does not match a non-literal heading (extra text on the line)", () => {
    // awk anchors `^## Blocked by[[:space:]]*$`; trailing prose disqualifies it.
    const body = "## Blocked by these things\n- [ ] #7\n";
    expect(parseBlockedBy(body)).toEqual([]);
  });

  it("scrapes any #N token on a malformed (non task-list) line", () => {
    // grep -oE '#[0-9]+' is not anchored to the `- [ ]` shape.
    const body = "## Blocked by\nwaiting on #88 and #89 to land\n";
    expect(parseBlockedBy(body)).toEqual(["#88", "#89"]);
  });
});

describe("refToNumber", () => {
  it("parses a hashed ref", () => {
    expect(refToNumber("#123")).toBe(123);
  });
  it("parses a bare numeric ref", () => {
    expect(refToNumber("123")).toBe(123);
  });
  it("returns null for garbage", () => {
    expect(refToNumber("#")).toBeNull();
    expect(refToNumber("abc")).toBeNull();
  });
});

describe("parseReqLabels", () => {
  it("extracts dependency ids from req:<N> labels, numeric-sorted-unique", () => {
    expect(parseReqLabels(["req:10", "req:2", "req:10", "blocked:dependency"])).toEqual([2, 10]);
  });

  it("ignores non-numeric and non-req labels", () => {
    expect(parseReqLabels(["req:foo", "spec:5", "ready-for-agent", "req:7"])).toEqual([7]);
  });

  it("returns [] for an empty / req-free label set", () => {
    expect(parseReqLabels([])).toEqual([]);
    expect(parseReqLabels(["blocked:dependency", "type:feature"])).toEqual([]);
  });
});

describe("cascadeAuditComment", () => {
  it("names the satisfied deps in #N form, comma-joined", () => {
    expect(cascadeAuditComment([101, 102])).toBe(
      "🤖 /afk unblocked: all dependencies closed (#101, #102).",
    );
  });
  it("formats a single dep", () => {
    expect(cascadeAuditComment([9])).toBe("🤖 /afk unblocked: all dependencies closed (#9).");
  });
});

describe("planCloseCascade", () => {
  it("promotes a dependent whose every req is closed", () => {
    const deps: DependentIssue[] = [
      { number: 20, reqs: [{ n: 9, closed: true }] },
    ];
    expect(planCloseCascade(9, deps)).toEqual([
      { number: 20, refs: ["#9"], reqLabels: ["req:9"], comment: "🤖 /afk unblocked: all dependencies closed (#9).", lane: "agent", hitlTypes: [] },
    ]);
  });

  it("does not promote when one req is still open", () => {
    const deps: DependentIssue[] = [
      { number: 21, reqs: [{ n: 9, closed: true }, { n: 8, closed: false }] },
    ];
    expect(planCloseCascade(9, deps)).toEqual([]);
  });

  it("does not promote a dependent with no reqs", () => {
    const deps: DependentIssue[] = [{ number: 22, reqs: [] }];
    expect(planCloseCascade(9, deps)).toEqual([]);
  });

  it("names every satisfied dep in ascending order on a multi-req promote", () => {
    const deps: DependentIssue[] = [
      { number: 30, reqs: [{ n: 9, closed: true }, { n: 8, closed: true }] },
    ];
    expect(planCloseCascade(9, deps)).toEqual([
      { number: 30, refs: ["#8", "#9"], reqLabels: ["req:8", "req:9"], comment: "🤖 /afk unblocked: all dependencies closed (#8, #9).", lane: "agent", hitlTypes: [] },
    ]);
  });

  it("plans only the satisfied dependents across a mixed batch", () => {
    const deps: DependentIssue[] = [
      { number: 20, reqs: [{ n: 9, closed: true }] }, // promote
      { number: 21, reqs: [{ n: 9, closed: true }, { n: 8, closed: false }] }, // skip
      { number: 22, reqs: [] }, // skip
    ];
    expect(planCloseCascade(9, deps).map((p) => p.number)).toEqual([20]);
  });
});

describe("shouldPromote", () => {
  it("promotes when every blocker is CLOSED", () => {
    expect(shouldPromote(["CLOSED", "CLOSED"])).toBe(true);
  });

  it("does not promote when any blocker is not closed", () => {
    const mixed: DependencyClosureState[] = ["CLOSED", "open-or-unknown"];
    expect(shouldPromote(mixed)).toBe(false);
  });

  it("does not promote with no blockers (empty ref set)", () => {
    // Mirrors bash `[[ -z "$refs" ]] && continue`: empty never promotes.
    expect(shouldPromote([])).toBe(false);
  });
});

describe("auditComment", () => {
  it("formats the promotion audit comment with comma-joined refs", () => {
    expect(auditComment(["#1", "#2"])).toBe(
      "🤖 /afk promoted to ready-for-agent: all blockers closed (#1, #2).",
    );
  });

  it("formats a single-ref comment", () => {
    expect(auditComment(["#42"])).toBe(
      "🤖 /afk promoted to ready-for-agent: all blockers closed (#42).",
    );
  });
});

describe("planUnblockSweep", () => {
  const lookupFor = (states: Record<number, string | undefined>) => {
    const calls: number[] = [];
    return {
      calls,
      fetch: async (n: number) => {
        calls.push(n);
        return states[n];
      },
    };
  };

  it("promotes a candidate whose blockers are all CLOSED", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #1\n- [ ] #2\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "CLOSED" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans).toEqual([
      {
        number: 7,
        refs: ["#1", "#2"],
        reqLabels: [],
        comment: "🤖 /afk promoted to ready-for-agent: all blockers closed (#1, #2).",
        lane: "agent",
        hitlTypes: [],
      },
    ]);
    expect(lookup.calls).toEqual([1, 2]);
  });

  it("does not promote when one blocker is still OPEN", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #1\n- [ ] #2\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "OPEN" });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
  });

  it("treats a 404 / transient lookup (undefined) as not-closed", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #1\n" },
    ];
    const lookup = lookupFor({ 1: undefined });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
  });

  it("skips candidates with no Blocked by refs without any lookup", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, body: "## What to build\nno blockers here" },
    ];
    const lookup = lookupFor({});
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
    expect(lookup.calls).toEqual([]);
  });

  it("plans each promotable candidate across a mixed batch", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #1\n" }, // closed → promote
      { number: 8, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #2\n" }, // open → skip
      { number: 9, body: "## What to build\nno refs" }, // none → skip
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "OPEN" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans.map((p) => p.number)).toEqual([7]);
  });

  it("prefers req:* labels over the body parse and uses the dependency wording", async () => {
    // The candidate carries BOTH a `req:*` label and a `## Blocked by` body.
    // The structured label wins: deps come from req:*, not the body.
    const candidates: UnblockCandidate[] = [
      {
        number: 7,
        labels: ["blocked:dependency", "req:101", "req:102"],
        body: "## Blocked by\n- [ ] #999\n", // ignored when req:* present
      },
    ];
    const lookup = lookupFor({ 101: "CLOSED", 102: "CLOSED", 999: "OPEN" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans).toEqual([
      {
        number: 7,
        refs: ["#101", "#102"],
        reqLabels: ["req:101", "req:102"],
        comment: "🤖 /afk unblocked: all dependencies closed (#101, #102).",
        lane: "agent",
        hitlTypes: [],
      },
    ]);
    // The body ref (#999) was never consulted — only the req:* deps.
    expect(lookup.calls).toEqual([101, 102]);
  });

  it("does not promote a req:* candidate while a dep is still open", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency", "req:101", "req:102"], body: "" },
    ];
    const lookup = lookupFor({ 101: "CLOSED", 102: "OPEN" });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
  });

  it("falls back to the body parse for legacy blocked:dependency candidates with no req:* label", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency"], body: "## Blocked by\n- [ ] #1\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans).toEqual([
      {
        number: 7,
        refs: ["#1"],
        reqLabels: [],
        comment: "🤖 /afk promoted to ready-for-agent: all blockers closed (#1).",
        lane: "agent",
        hitlTypes: [],
      },
    ]);
  });

  it("does not use legacy body blockers to promote ready-for-human gates", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["ready-for-human"], body: "## Blocked by\n- [ ] #1\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED" });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
    expect(lookup.calls).toEqual([]);
  });

  it("does not promote ready-for-human even when stale req:* labels are present", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["ready-for-human", "req:1"], body: "" },
    ];
    const lookup = lookupFor({ 1: "CLOSED" });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
    expect(lookup.calls).toEqual([]);
  });
});

describe("executeUnblockSweep", () => {
  const lookupFor = (states: Record<number, string | undefined>) => async (n: number) => states[n];

  // Records the gh mutations the sweep applies, so a test can assert the exact
  // label rotation + audit comment per promoted issue.
  function recordingGh(issueReference?: (issue: number) => Promise<{ number: number; title?: string; url?: string } | undefined>) {
    const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];
    const comments: Array<{ issue: number; body: string }> = [];
    return {
      edits,
      comments,
      gh: {
        editLabels: async (issue: number, remove: string[], add: string[]) => {
          edits.push({ issue, remove, add });
        },
        comment: async (issue: number, body: string) => {
          comments.push({ issue, body });
        },
        issueReference,
      },
    };
  }

  it("promotes a fully-unblocked dependent exactly once: -blocked:dependency +ready-for-agent + audit", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency", "req:101", "req:102"], body: "" },
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(candidates, lookupFor({ 101: "CLOSED", 102: "CLOSED" }), rec.gh);

    expect(promoted).toEqual([7]);
    expect(rec.edits).toEqual([
      { issue: 7, remove: ["blocked:dependency", "req:101", "req:102"], add: ["ready-for-agent"] },
    ]);
    expect(rec.comments).toEqual([
      { issue: 7, body: "🤖 /afk unblocked: all dependencies closed (#101, #102)." },
    ]);
  });

  it("renders dependency refs as title+number links when metadata resolves", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency", "req:101", "req:102"], body: "" },
    ];
    const rec = recordingGh(async (issue) =>
      issue === 101
        ? { number: 101, title: "Wayfinder fidelity restoration", url: "https://github.com/reddb-io/red-skills/issues/101" }
        : undefined,
    );
    await executeUnblockSweep(candidates, lookupFor({ 101: "CLOSED", 102: "CLOSED" }), rec.gh);

    expect(rec.comments).toEqual([
      {
        issue: 7,
        body: "🤖 /afk unblocked: all dependencies closed ([Wayfinder fidelity restoration (#101)](https://github.com/reddb-io/red-skills/issues/101), #102).",
      },
    ]);
  });

  it("leaves a partially-blocked dependent untouched (no label edit, no comment)", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency", "req:101", "req:102"], body: "" },
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(candidates, lookupFor({ 101: "CLOSED", 102: "OPEN" }), rec.gh);

    expect(promoted).toEqual([]);
    expect(rec.edits).toEqual([]);
    expect(rec.comments).toEqual([]);
  });

  it("never auto-promotes a ready-for-human gate", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["ready-for-human", "req:101"], body: "## Blocked by\n- [ ] #101\n" },
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(candidates, lookupFor({ 101: "CLOSED" }), rec.gh);

    expect(promoted).toEqual([]);
    expect(rec.edits).toEqual([]);
    expect(rec.comments).toEqual([]);
  });

  it("promotes only the unblockable issues across a mixed batch", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, labels: ["blocked:dependency", "req:101"], body: "" }, // closed → promote
      { number: 8, labels: ["blocked:dependency", "req:102"], body: "" }, // open → leave
      { number: 9, labels: ["ready-for-human", "req:103"], body: "" }, // human gate → never
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(
      candidates,
      lookupFor({ 101: "CLOSED", 102: "OPEN", 103: "CLOSED" }),
      rec.gh,
    );

    expect(promoted).toEqual([7]);
    expect(rec.edits.map((e) => e.issue)).toEqual([7]);
  });
});

// #2966: the sweep promoted EVERY unblocked dependent into the autonomous queue,
// so closing a decision Ticket handed the human's own decisions to an agent. The
// HUMAN-ONLY types are read from the repo's installed label vocabulary
// (`afk.labels.hitl_types`) — never from a hard-coded `wayfinder:*` list.
describe("executeUnblockSweep — HUMAN-ONLY type routing", () => {
  const lookupFor = (states: Record<number, string | undefined>) => async (n: number) => states[n];
  const HITL_TYPES = ["wayfinder:grilling", "wayfinder:prototype"];

  function recordingGh() {
    const edits: Array<{ issue: number; remove: string[]; add: string[] }> = [];
    const comments: Array<{ issue: number; body: string }> = [];
    return {
      edits,
      comments,
      gh: {
        editLabels: async (issue: number, remove: string[], add: string[]) => {
          edits.push({ issue, remove, add });
        },
        comment: async (issue: number, body: string) => {
          comments.push({ issue, body });
        },
      },
    };
  }

  it("routes a dependent carrying a declared HUMAN-ONLY type to ready-for-human", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 12, labels: ["blocked:dependency", "req:8", "wayfinder:grilling"], body: "" },
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(
      candidates,
      lookupFor({ 8: "CLOSED" }),
      rec.gh,
      HITL_TYPES,
    );

    expect(promoted).toEqual([12]);
    expect(rec.edits).toEqual([
      { issue: 12, remove: ["blocked:dependency", "req:8"], add: ["ready-for-human"] },
    ]);
    expect(rec.comments[0]!.body).toContain("all dependencies closed (#8)");
    expect(rec.comments[0]!.body).toContain("`ready-for-human`");
    expect(rec.comments[0]!.body).toContain("wayfinder:grilling");
  });

  it("still routes a dependent with no HUMAN-ONLY type to ready-for-agent", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 13, labels: ["blocked:dependency", "req:8", "wayfinder:task"], body: "" },
    ];
    const rec = recordingGh();
    const promoted = await executeUnblockSweep(
      candidates,
      lookupFor({ 8: "CLOSED" }),
      rec.gh,
      HITL_TYPES,
    );

    expect(promoted).toEqual([13]);
    expect(rec.edits).toEqual([
      { issue: 13, remove: ["blocked:dependency", "req:8"], add: ["ready-for-agent"] },
    ]);
    expect(rec.comments[0]!.body).toContain("`ready-for-agent`");
  });

  it("leaves a repo that declares no HUMAN-ONLY type byte-identical to before", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 12, labels: ["blocked:dependency", "req:8", "wayfinder:grilling"], body: "" },
    ];
    const rec = recordingGh();
    await executeUnblockSweep(candidates, lookupFor({ 8: "CLOSED" }), rec.gh, []);

    expect(rec.edits).toEqual([
      { issue: 12, remove: ["blocked:dependency", "req:8"], add: ["ready-for-agent"] },
    ]);
    expect(rec.comments).toEqual([
      { issue: 12, body: "🤖 /afk unblocked: all dependencies closed (#8)." },
    ]);
  });

  it("names every HUMAN-ONLY type the dependent carries", async () => {
    const candidates: UnblockCandidate[] = [
      {
        number: 14,
        labels: ["blocked:dependency", "req:8", "wayfinder:grilling", "wayfinder:prototype"],
        body: "",
      },
    ];
    const rec = recordingGh();
    await executeUnblockSweep(candidates, lookupFor({ 8: "CLOSED" }), rec.gh, HITL_TYPES);

    expect(rec.comments[0]!.body).toContain("wayfinder:grilling, wayfinder:prototype");
  });

  it("routes the legacy `## Blocked by` promotion by the same rule", async () => {
    const candidates: UnblockCandidate[] = [
      {
        number: 15,
        labels: ["blocked:dependency", "wayfinder:prototype"],
        body: "## Blocked by\n- [x] #8\n",
      },
    ];
    const rec = recordingGh();
    await executeUnblockSweep(candidates, lookupFor({ 8: "CLOSED" }), rec.gh, HITL_TYPES);

    expect(rec.edits).toEqual([
      { issue: 15, remove: ["blocked:dependency"], add: ["ready-for-human"] },
    ]);
  });

  it("plans the lane so a close cascade routes a HUMAN-ONLY dependent too", () => {
    const dependents: DependentIssue[] = [
      { number: 12, labels: ["blocked:dependency", "req:8", "wayfinder:grilling"], reqs: [{ n: 8, closed: true }] },
      { number: 13, labels: ["blocked:dependency", "req:8"], reqs: [{ n: 8, closed: true }] },
    ];
    const plans = planCloseCascade(8, dependents, HITL_TYPES);

    expect(plans.map((p) => [p.number, p.lane])).toEqual([
      [12, "human"],
      [13, "agent"],
    ]);
    expect(plans[0]!.hitlTypes).toEqual(["wayfinder:grilling"]);
  });
});

describe("straggler check", () => {
  const lookupFor = (
    counts: { unlabeled: number; needsTriage: number; needsInfo: number },
  ): StragglerCountLookup => ({
    unlabeled: async () => counts.unlabeled,
    needsTriage: async () => counts.needsTriage,
    needsInfo: async () => counts.needsInfo,
  });

  it("gathers the three counts", async () => {
    const counts = await stragglerCounts(lookupFor({ unlabeled: 2, needsTriage: 1, needsInfo: 0 }));
    expect(counts).toEqual({ unlabeled: 2, needsTriage: 1, needsInfo: 0 });
  });

  it("clamps non-finite / negative probe results to 0", async () => {
    const counts = await stragglerCounts(lookupFor({ unlabeled: NaN, needsTriage: -3, needsInfo: 5 }));
    expect(counts).toEqual({ unlabeled: 0, needsTriage: 0, needsInfo: 5 });
  });

  it("does not warn when all buckets are empty", () => {
    expect(shouldWarnStragglers({ unlabeled: 0, needsTriage: 0, needsInfo: 0 })).toBe(false);
  });

  it("warns when any single bucket is non-zero", () => {
    expect(shouldWarnStragglers({ unlabeled: 1, needsTriage: 0, needsInfo: 0 })).toBe(true);
    expect(shouldWarnStragglers({ unlabeled: 0, needsTriage: 1, needsInfo: 0 })).toBe(true);
    expect(shouldWarnStragglers({ unlabeled: 0, needsTriage: 0, needsInfo: 1 })).toBe(true);
  });
});

describe("issueFromAFKBranch", () => {
  it("extracts the issue number from a well-formed live branch ref", () => {
    expect(issueFromAFKBranch("afk/wA1B5/101-add-feature")).toBe(101);
    expect(issueFromAFKBranch("afk/wXXX/42-fix-bug")).toBe(42);
  });

  it("returns null for afk-attempts/* refs", () => {
    expect(issueFromAFKBranch("afk-attempts/wA1B5/101-add-feature")).toBeNull();
  });

  it("returns null for refs that don't match the pattern", () => {
    expect(issueFromAFKBranch("main")).toBeNull();
    expect(issueFromAFKBranch("afk/wA1B5/101")).toBeNull(); // missing slug
    expect(issueFromAFKBranch("")).toBeNull();
  });

  it("parses multi-digit and leading-digit issue numbers", () => {
    expect(issueFromAFKBranch("afk/wAAA/999-some-long-slug")).toBe(999);
  });
});

describe("findOwnedBranch", () => {
  const branches = [
    "afk/wA1B5/101-add-feature",
    "afk/wA1B5/202-fix-bug",
    "afk/wOther/303-other-worker",
  ];

  it("returns the branch that owns the given issue number", () => {
    expect(findOwnedBranch(branches, 101)).toBe("afk/wA1B5/101-add-feature");
    expect(findOwnedBranch(branches, 303)).toBe("afk/wOther/303-other-worker");
  });

  it("returns null when no branch owns the issue", () => {
    expect(findOwnedBranch(branches, 404)).toBeNull();
    expect(findOwnedBranch([], 101)).toBeNull();
  });

  it("returns the first match when multiple workers own the same issue", () => {
    const dupes = ["afk/wA/50-slug", "afk/wB/50-other"];
    expect(findOwnedBranch(dupes, 50)).toBe("afk/wA/50-slug");
  });
});

describe("isParkedMechanical", () => {
  it("returns true for blocked:stalled", () => {
    expect(isParkedMechanical(["blocked:stalled", "type:feature"])).toBe(true);
  });

  it("returns true for blocked:crashed", () => {
    expect(isParkedMechanical(["blocked:crashed"])).toBe(true);
  });

  it("returns true for blocked:merge-conflict (#1095)", () => {
    expect(isParkedMechanical(["blocked:merge-conflict", "ready-for-human"])).toBe(true);
  });

  it("returns false for non-mechanical labels", () => {
    expect(isParkedMechanical(["blocked:spec", "ready-for-human"])).toBe(false);
    expect(isParkedMechanical(["blocked:validation"])).toBe(false);
    expect(isParkedMechanical([])).toBe(false);
  });
});

describe("planReconcileSweep", () => {
  const branches = [
    "afk/wA1B5/101-add-feature",
    "afk/wA1B5/202-fix-bug",
  ];

  it("plans an issue that has a parked-mechanical label AND an owned branch", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 101, title: "Add feature", body: "", labels: ["blocked:stalled"] },
    ];
    const plans = planReconcileSweep(candidates, branches);
    expect(plans).toEqual([
      { number: 101, title: "Add feature", body: "", labels: ["blocked:stalled"], branch: "afk/wA1B5/101-add-feature" },
    ]);
  });

  it("skips an issue with no owned branch (no-branch→skip)", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 999, title: "No branch", body: "", labels: ["blocked:stalled"] },
    ];
    expect(planReconcileSweep(candidates, branches)).toEqual([]);
  });

  it("skips a candidate without a parked-mechanical label", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 101, title: "Add feature", body: "", labels: ["blocked:dependency"] },
    ];
    expect(planReconcileSweep(candidates, branches)).toEqual([]);
  });

  it("plans a running issue only after the stale-claim sweep released it", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 101, title: "Add feature", body: "", labels: ["running"] },
    ];
    expect(planReconcileSweep(candidates, branches)).toEqual([]);
    expect(planReconcileSweep(candidates, branches, [101])).toEqual([
      { number: 101, title: "Add feature", body: "", labels: ["running"], branch: "afk/wA1B5/101-add-feature" },
    ]);
  });

  it("plans blocked:crashed candidates", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 202, title: "Fix bug", body: "", labels: ["blocked:crashed"] },
    ];
    const plans = planReconcileSweep(candidates, branches);
    expect(plans).toHaveLength(1);
    expect(plans[0].branch).toBe("afk/wA1B5/202-fix-bug");
  });

  it("does NOT filter blocked:spec — the reconcile guard handles that", () => {
    // A candidate may carry BOTH blocked:stalled AND blocked:spec. planReconcileSweep
    // only checks for owned branch; the reconcile() guard rejects non-mechanical ones.
    const candidates: ReconcileSweepCandidate[] = [
      { number: 101, title: "Add feature", body: "", labels: ["blocked:stalled", "blocked:spec"] },
    ];
    const plans = planReconcileSweep(candidates, branches);
    expect(plans).toHaveLength(1); // planner yields it; reconcile() will skip it
  });

  it("plans each eligible candidate from a mixed batch", () => {
    const candidates: ReconcileSweepCandidate[] = [
      { number: 101, title: "Add feature", body: "", labels: ["blocked:stalled"] }, // owned → plan
      { number: 202, title: "Fix bug", body: "", labels: ["blocked:crashed"] },     // owned → plan
      { number: 303, title: "No branch", body: "", labels: ["blocked:stalled"] },  // no branch → skip
      { number: 404, title: "Wrong label", body: "", labels: ["blocked:spec"] },   // not mechanical → skip
    ];
    const plans = planReconcileSweep(candidates, branches);
    expect(plans.map((p) => p.number)).toEqual([101, 202]);
  });
});

describe("planMixedBlockedNormalize", () => {
  it("heals a queued issue carrying a stale blocked:* label", () => {
    const candidates: MixedBlockedCandidate[] = [
      { number: 1, labels: ["ready-for-agent", "blocked:spec"] },
    ];
    expect(planMixedBlockedNormalize(candidates)).toEqual([{ number: 1, remove: ["blocked:spec"] }]);
  });

  it("heals a running issue and sheds every blocked:* label", () => {
    const candidates: MixedBlockedCandidate[] = [
      { number: 2, labels: ["running", "blocked:validation", "blocked:spec"] },
    ];
    expect(planMixedBlockedNormalize(candidates)).toEqual([
      { number: 2, remove: ["blocked:spec", "blocked:validation"] },
    ]);
  });

  it("leaves legal states untouched", () => {
    const candidates: MixedBlockedCandidate[] = [
      { number: 3, labels: ["ready-for-agent"] },        // cleanly queued
      { number: 4, labels: ["blocked:dependency"] },     // cleanly blocked
      { number: 5, labels: ["ready-for-human", "blocked:spec"] }, // legal human park
    ];
    expect(planMixedBlockedNormalize(candidates)).toEqual([]);
  });

  it("executes the plan, stripping blocked:* and returning healed numbers", async () => {
    const edits: { issue: number; remove: string[]; add: string[] }[] = [];
    const gh = {
      async editLabels(issue: number, remove: string[], add: string[]) {
        edits.push({ issue, remove, add });
      },
    };
    const candidates: MixedBlockedCandidate[] = [
      { number: 11, labels: ["ready-for-agent", "blocked:spec"] },
      { number: 12, labels: ["ready-for-agent"] }, // clean → no edit
    ];
    const healed = await executeMixedBlockedNormalize(candidates, gh);
    expect(healed).toEqual([11]);
    expect(edits).toEqual([{ issue: 11, remove: ["blocked:spec"], add: [] }]);
  });
});
