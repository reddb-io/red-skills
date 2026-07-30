// branch-reclaim.test.ts — local branches are reclaimed when their work has
// LANDED, and infrastructure refs are named and never eligible (#2866).
//
// The incident this encodes: a hand sweep of "merged" branches deleted
// `red-trunk`, the fleet's trunk mirror, because to a merged-ness test it looks
// exactly like an ordinary merged branch. Every test below asks the planner the
// question that sweep asked, and demands the answer that sweep got wrong.

import { describe, expect, it } from "vitest";
import {
  INFRASTRUCTURE_BRANCHES,
  planBranchReclaim,
  type BranchReclaimCandidate,
} from "../src/core/branch-reclaim.js";

function verdictFor(
  plan: ReturnType<typeof planBranchReclaim>,
  branch: string,
): { reclaim: boolean; verdict: string; reason: string } {
  const found = [...plan.reclaim, ...plan.spare].find((entry) => entry.branch === branch);
  if (found === undefined) throw new Error(`no verdict for ${branch}`);
  return { reclaim: found.reclaim, verdict: found.verdict, reason: found.reason };
}

const landed: BranchReclaimCandidate = { branch: "afk/2100-landed-slice", landed: true };

describe("infrastructure refs are named and never eligible", () => {
  it("names red-trunk", () => {
    expect(INFRASTRUCTURE_BRANCHES).toContain("red-trunk");
  });

  it("spares red-trunk even when it is fully merged into the trunk", () => {
    const plan = planBranchReclaim([{ branch: "red-trunk", landed: true }], { trunk: "main" });
    expect(verdictFor(plan, "red-trunk").reclaim).toBe(false);
    expect(verdictFor(plan, "red-trunk").verdict).toBe("infrastructure");
    expect(plan.reclaim).toEqual([]);
  });

  it("spares the configured trunk itself, whatever it is named", () => {
    const plan = planBranchReclaim([{ branch: "develop", landed: true }], { trunk: "develop" });
    expect(verdictFor(plan, "develop").verdict).toBe("trunk");
    expect(plan.reclaim).toEqual([]);
  });

  it("spares a branch outside any Worker namespace rather than guessing", () => {
    const plan = planBranchReclaim([{ branch: "release/v2", landed: true }], { trunk: "main" });
    expect(verdictFor(plan, "release/v2").verdict).toBe("unrecognised");
    expect(plan.reclaim).toEqual([]);
  });
});

describe("a Worker branch whose work has landed is reclaimed", () => {
  it("reclaims a landed branch even while its issue is still open", () => {
    const plan = planBranchReclaim([{ ...landed, issueClosed: false }], { trunk: "main" });
    expect(verdictFor(plan, landed.branch).reclaim).toBe(true);
    expect(verdictFor(plan, landed.branch).verdict).toBe("landed");
  });

  it("reclaims a branch whose issue is closed even when merged-ness is unknown", () => {
    const plan = planBranchReclaim(
      [{ branch: "afk/2101-closed-slice", issueClosed: true }],
      { trunk: "main" },
    );
    expect(verdictFor(plan, "afk/2101-closed-slice").verdict).toBe("issue-closed");
  });

  it("spares a Worker branch whose work has not landed", () => {
    const plan = planBranchReclaim([{ branch: "afk/2102-in-flight" }], { trunk: "main" });
    expect(verdictFor(plan, "afk/2102-in-flight").reclaim).toBe(false);
    expect(verdictFor(plan, "afk/2102-in-flight").verdict).toBe("unlanded");
  });

  it("spares a landed branch a worktree still holds", () => {
    const plan = planBranchReclaim([{ ...landed, checkedOut: true }], { trunk: "main" });
    expect(verdictFor(plan, landed.branch).reclaim).toBe(false);
    expect(verdictFor(plan, landed.branch).verdict).toBe("checked-out");
  });

  it("spares a legacy per-worker branch that has not landed", () => {
    const plan = planBranchReclaim([{ branch: "afk/wZK2Z/2103-legacy" }], { trunk: "main" });
    expect(verdictFor(plan, "afk/wZK2Z/2103-legacy").verdict).toBe("unlanded");
  });
});

describe("the plan reports what it removed and what it deliberately spared", () => {
  it("accounts for every candidate exactly once", () => {
    const candidates: BranchReclaimCandidate[] = [
      { branch: "red-trunk", landed: true },
      { branch: "main", landed: true },
      { branch: "afk/2100-landed-slice", landed: true },
      { branch: "afk/2102-in-flight" },
      { branch: "release/v2", landed: true },
    ];
    const plan = planBranchReclaim(candidates, { trunk: "main" });
    expect(plan.totals.considered).toBe(candidates.length);
    expect(plan.totals.reclaim + plan.totals.spare).toBe(candidates.length);
    expect(plan.totals.reclaim).toBe(plan.reclaim.length);
    expect(plan.totals.spare).toBe(plan.spare.length);
  });

  it("carries a reason on every spare, so a reader never has to guess", () => {
    const plan = planBranchReclaim(
      [
        { branch: "red-trunk", landed: true },
        { branch: "afk/2102-in-flight" },
      ],
      { trunk: "main" },
    );
    for (const spared of plan.spare) expect(spared.reason).not.toBe("");
  });

  it("never reclaims the same branch twice, and says why the repeat was spared", () => {
    const plan = planBranchReclaim([landed, landed], { trunk: "main" });
    expect(plan.reclaim.map((entry) => entry.branch)).toEqual([landed.branch]);
    expect(plan.spare.map((entry) => entry.verdict)).toEqual(["already-planned"]);
    expect(plan.totals.considered).toBe(2);
    expect(plan.totals.reclaim + plan.totals.spare).toBe(2);
  });
});
