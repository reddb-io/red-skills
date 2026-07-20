import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decideMainRedAdminMerge,
  MAIN_RED_REPAIR_TITLE,
  planMainRedRepair,
  renderMainRedRepairBody,
  selectMainRedRepairIssue,
} from "../src/core/main-red-repair.js";
import { LABEL_BUG, LABEL_READY, LABEL_URGENT } from "../src/core/triage-labels.js";

describe("planMainRedRepair", () => {
  it("creates one urgent tracked repair issue when baseline failures exist and none is open", () => {
    const plan = planMainRedRepair(
      {
        sha: "0123456789abcdef0123456789abcdef01234567",
        failures: [
          {
            check: "test:apps/dev",
            summary: "failing: FAIL tests/pi-package-builder.test.ts > builds the package",
            outputTail: "AssertionError: expected stale manifest to equal generated manifest",
          },
          {
            check: "typecheck:workspace",
            summary: "error TS2322 in src/index.ts",
            outputTail: "src/index.ts(4,2): error TS2322: Type 'number' is not assignable to type 'string'",
          },
        ],
      },
      null,
    );

    expect(plan.action).toBe("create");
    if (plan.action !== "create") throw new Error("unreachable");
    expect(plan.title).toBe(MAIN_RED_REPAIR_TITLE);
    expect(plan.labels).toEqual([LABEL_READY, LABEL_URGENT, LABEL_BUG]);
    expect(plan.body).toContain("- test:apps/dev");
    expect(plan.body).toContain("- typecheck:workspace");
    expect(plan.body).toContain("`0123456789abcdef0123456789abcdef01234567`");
    expect(plan.body).toContain("FAIL tests/pi-package-builder.test.ts > builds the package");
    expect(plan.body).toContain("AssertionError: expected stale manifest to equal generated manifest");
  });

  it("comments on the matching issue instead of creating a duplicate", () => {
    const previous = renderMainRedRepairBody({
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      failures: [{ check: "test:apps/dev", summary: "old failure", outputTail: "old tail" }],
    });
    const plan = planMainRedRepair(
      {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        failures: [{ check: "test:apps/dev", summary: "new failure", outputTail: "new tail" }],
      },
      { number: 123, body: previous, labels: [LABEL_URGENT] },
    );

    expect(plan.action).toBe("comment");
    if (plan.action !== "comment") throw new Error("unreachable");
    expect(plan.issue).toBe(123);
    expect(plan.comment).toContain("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    expect(plan.comment).toContain("new failure");
  });

  it("creates a separate issue when the open repair issue has a different failing set", () => {
    const previous = renderMainRedRepairBody({
      sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      failures: [{ check: "lint:apps/dev", summary: "lint failed", outputTail: "lint tail" }],
    });
    const plan = planMainRedRepair(
      {
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        failures: [{ check: "test:apps/dev", summary: "tests failed", outputTail: "test tail" }],
      },
      { number: 123, body: previous },
    );

    expect(plan.action).toBe("create");
  });

  it("closes the open repair issue when the next baseline probe is green", () => {
    const plan = planMainRedRepair({ sha: "feedface", failures: [] }, { number: 55 });

    expect(plan).toEqual({
      action: "close",
      issue: 55,
      comment: "🤖 /afk baseline probe: main is green again; closing the auto-filed repair issue.",
    });
  });

  it("does nothing when main is green and no repair issue exists", () => {
    expect(planMainRedRepair({ sha: "feedface", failures: [] }, null)).toEqual({ action: "noop" });
  });
});

describe("renderMainRedRepairBody", () => {
  it("bounds the captured output tail while preserving failure identity", () => {
    const outputTail = Array.from({ length: 30 }, (_, i) => `diagnostic line ${i + 1}`).join("\n");
    const body = renderMainRedRepairBody({
      sha: "feedface",
      failures: [
        {
          check: " test:apps/dev ",
          summary: "failing: FAIL tests/createSandbox.test.ts > creates a sandbox",
          outputTail,
        },
      ],
    });

    expect(body).toContain("## Failing checks");
    expect(body).toContain("- test:apps/dev");
    expect(body).toContain("FAIL tests/createSandbox.test.ts > creates a sandbox");
    expect(body).toContain("diagnostic line 30");
    expect(body).not.toContain("diagnostic line 10\n");
  });
});

describe("selectMainRedRepairIssue", () => {
  it("selects the marked open issue with the same normalized failing-check set", () => {
    const matchingBody = renderMainRedRepairBody({
      sha: "aaaaaaaa",
      failures: [
        { check: "test:apps/dev", summary: "tests failed", outputTail: "tail" },
        { check: "lint:apps/dev", summary: "lint failed", outputTail: "tail" },
      ],
    });
    const otherBody = renderMainRedRepairBody({
      sha: "bbbbbbbb",
      failures: [{ check: "typecheck:workspace", summary: "types failed", outputTail: "tail" }],
    });

    expect(
      selectMainRedRepairIssue(
        [
          { number: 10, body: otherBody },
          { number: 11, body: matchingBody },
          { number: 12, body: matchingBody.replace("red-skills:main-red-repair", "not-the-marker") },
        ],
        [" lint:apps/dev", "test:apps/dev", "test:apps/dev"],
      )?.number,
    ).toBe(11);
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
