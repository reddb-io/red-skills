import { describe, expect, it } from "vitest";
import {
  auditComment,
  parseBlockedBy,
  planUnblockSweep,
  refToNumber,
  shouldPromote,
  shouldWarnStragglers,
  stragglerCounts,
  type BlockerState,
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
    const body = "## Parent\nPRD #500\n## Blocked by\n- [ ] #1\n";
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

describe("shouldPromote", () => {
  it("promotes when every blocker is CLOSED", () => {
    expect(shouldPromote(["CLOSED", "CLOSED"])).toBe(true);
  });

  it("does not promote when any blocker is not closed", () => {
    const mixed: BlockerState[] = ["CLOSED", "open-or-unknown"];
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
      { number: 7, body: "## Blocked by\n- [ ] #1\n- [ ] #2\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "CLOSED" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans).toEqual([
      {
        number: 7,
        refs: ["#1", "#2"],
        comment: "🤖 /afk promoted to ready-for-agent: all blockers closed (#1, #2).",
      },
    ]);
    expect(lookup.calls).toEqual([1, 2]);
  });

  it("does not promote when one blocker is still OPEN", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, body: "## Blocked by\n- [ ] #1\n- [ ] #2\n" },
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "OPEN" });
    expect(await planUnblockSweep(candidates, lookup.fetch)).toEqual([]);
  });

  it("treats a 404 / transient lookup (undefined) as not-closed", async () => {
    const candidates: UnblockCandidate[] = [
      { number: 7, body: "## Blocked by\n- [ ] #1\n" },
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
      { number: 7, body: "## Blocked by\n- [ ] #1\n" }, // closed → promote
      { number: 8, body: "## Blocked by\n- [ ] #2\n" }, // open → skip
      { number: 9, body: "## What to build\nno refs" }, // none → skip
    ];
    const lookup = lookupFor({ 1: "CLOSED", 2: "OPEN" });
    const plans = await planUnblockSweep(candidates, lookup.fetch);
    expect(plans.map((p) => p.number)).toEqual([7]);
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
