import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  ASKED_BALANCE_ORIGIN_DECLARATION,
  ASKED_BALANCE_ORIGIN_FILE,
  ASKED_BALANCE_SCOPES,
  askedBalanceSources,
  findDerivedBalanceSites,
  renderDerivedBalanceSites,
  stripSourceComments,
  sweepAskedBalance,
} from "../src/core/asked-balance-guard.js";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

describe("no code path derives the GitHub balance by counting", () => {
  it("finds no local accumulator anywhere the budget is touched", () => {
    const sites = sweepAskedBalance(REPO_ROOT);

    expect(renderDerivedBalanceSites(sites)).toBe("");
    expect(sites).toEqual([]);
  });

  it("sweeps a non-empty set of files in every declared scope", () => {
    for (const scope of ASKED_BALANCE_SCOPES) {
      expect(askedBalanceSources(REPO_ROOT, scope.dir).length).toBeGreaterThan(0);
    }
  });

  it("catches the accumulator this ratchet exists to refuse", () => {
    const sites = findDerivedBalanceSites(
      "apps/redskilled/src/ledger.ts",
      ["let remaining = 5000;", "function spend(cost) {", "  remaining -= cost;", "}"].join("\n"),
    );

    expect(sites).toHaveLength(1);
    expect(sites[0]!.line).toBe(3);
    expect(sites[0]!.binding).toBe("remaining");
    expect(renderDerivedBalanceSites(sites)).toContain("GET /rate_limit");
  });

  it("catches the increment and the self-referential form too", () => {
    const increment = findDerivedBalanceSites("x.ts", "graphqlPointsSpent++;");
    const selfRef = findDerivedBalanceSites("x.ts", "const rateLimitRemaining = rateLimitRemaining - cost;");

    expect(increment).toHaveLength(1);
    expect(selfRef).toHaveLength(1);
  });

  it("lets a balance be READ out of an answer, which is the whole point", () => {
    const sites = findDerivedBalanceSites(
      "x.ts",
      ["const remaining = answer.resources.core.remaining;", "const used = answer.resources.core.used;"].join("\n"),
    );

    expect(sites).toEqual([]);
  });

  it("treats prose about an accumulator as documentation, not as one", () => {
    const source = [
      "// the rejected design did `remaining -= cost` on every call",
      "/* a ledger that counted would write balance += 1 here */",
      "const remaining = answer.remaining;",
    ].join("\n");

    expect(stripSourceComments(source)).not.toContain("-= cost");
    expect(findDerivedBalanceSites("x.ts", source)).toEqual([]);
  });

  it("ignores an accumulator that names no budget quantity", () => {
    expect(findDerivedBalanceSites("x.ts", "workerCount += 1;")).toEqual([]);
  });
});

describe("the balance declares an origin that only asking can produce", () => {
  it("keeps `origin` a single literal, so a derived balance cannot be built", () => {
    const source = readFileSync(join(REPO_ROOT, ASKED_BALANCE_ORIGIN_FILE), "utf8");

    expect(source).toContain(ASKED_BALANCE_ORIGIN_DECLARATION);
    expect(source).not.toMatch(/readonly origin:\s*"asked"\s*\|/);
  });
});
