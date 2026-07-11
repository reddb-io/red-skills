import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideMainRedAdminMerge,
  MAIN_RED_REPAIR_TITLE,
  planMainRedRepair,
  renderMainRedRepairBody,
} from "../src/core/main-red-repair.js";
import { LABEL_BUG, LABEL_READY, LABEL_URGENT } from "../src/core/triage-labels.js";

describe("planMainRedRepair", () => {
  it("creates one urgent tracked repair issue when baseline failures exist and none is open", () => {
    const plan = planMainRedRepair(["test:apps/dev", "typecheck:workspace"], null);

    expect(plan.action).toBe("create");
    if (plan.action !== "create") throw new Error("unreachable");
    expect(plan.title).toBe(MAIN_RED_REPAIR_TITLE);
    expect(plan.labels).toEqual([LABEL_READY, LABEL_URGENT, LABEL_BUG]);
    expect(plan.body).toContain("- test:apps/dev");
    expect(plan.body).toContain("- typecheck:workspace");
  });

  it("updates the existing repair issue instead of creating a duplicate for same or overlapping failures", () => {
    const plan = planMainRedRepair(["test:apps/dev", "test:apps/dev", "lint:apps/dev"], {
      number: 123,
      labels: [LABEL_URGENT],
    });

    expect(plan.action).toBe("update");
    if (plan.action !== "update") throw new Error("unreachable");
    expect(plan.issue).toBe(123);
    expect(plan.body.match(/test:apps\/dev/g)).toHaveLength(1);
    expect(plan.body).toContain("- lint:apps/dev");
  });

  it("closes the open repair issue when the next baseline probe is green", () => {
    const plan = planMainRedRepair([], { number: 55 });

    expect(plan).toEqual({
      action: "close",
      issue: 55,
      comment: "🤖 /afk baseline probe: main is green again; closing the auto-filed repair issue.",
    });
  });

  it("does nothing when main is green and no repair issue exists", () => {
    expect(planMainRedRepair([], null)).toEqual({ action: "noop" });
  });
});

describe("renderMainRedRepairBody", () => {
  it("names each failing baseline check in a stable body", () => {
    const body = renderMainRedRepairBody([" typecheck:workspace ", "test:apps/dev"]);

    expect(body).toContain("## Failing checks");
    expect(body).toContain("- test:apps/dev");
    expect(body).toContain("- typecheck:workspace");
  });
});

describe("decideMainRedAdminMerge", () => {
  it("allows admin-merge onto a green main", () => {
    expect(decideMainRedAdminMerge({ mainRed: false, openRepairIssue: null })).toEqual({ ok: true });
  });

  it("allows admin-merge onto a red main when a repair issue is open", () => {
    expect(decideMainRedAdminMerge({ mainRed: true, openRepairIssue: { number: 123 } })).toEqual({ ok: true });
  });

  it("refuses admin-merge onto a red main with no open repair issue", () => {
    const decision = decideMainRedAdminMerge({ mainRed: true, openRepairIssue: null });

    expect(decision.ok).toBe(false);
    if (decision.ok) throw new Error("unreachable");
    expect(decision.message).toContain("Refusing admin-merge onto red main");
    expect(decision.message).toContain("main-red repair issue");
    expect(decision.message).toContain("syncMainRedRepairIssue");
  });
});

describe("root main-red feedback scripts", () => {
  it("do not pull red-castle back in through Turbo dependency tasks", () => {
    const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, "../../..", "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const script of ["build", "typecheck"]) {
      expect(pkg.scripts[script]).toContain("--filter=!@reddb-io/red-castle");
      expect(pkg.scripts[script]).toContain("--only");
    }
  });
});
