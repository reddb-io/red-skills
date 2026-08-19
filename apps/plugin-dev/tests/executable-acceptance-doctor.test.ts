import { describe, expect, it } from "vitest";
import {
  auditExecutableAcceptanceCriteria,
} from "../src/core/executable-acceptance-doctor.js";
import type { IssueCandidate } from "../src/core/session.js";

function candidate(overrides: Partial<IssueCandidate>): IssueCandidate {
  return {
    number: 1,
    title: "Ticket",
    body: `## Acceptance criteria

- [ ] Running \`pnpm --filter @reddb-io/dev test\` passes.
`,
    labels: ["ready-for-agent"],
    ...overrides,
  };
}

describe("auditExecutableAcceptanceCriteria", () => {
  it("reports ready executable tickets with vague acceptance criteria", () => {
    const report = auditExecutableAcceptanceCriteria([
      candidate({
        number: 42,
        body: `## Acceptance criteria

- [ ] The implementation passes review.
`,
      }),
    ]);

    expect(report.row).toMatchObject({
      check: "executable-acceptance-criteria",
      verdict: "warn",
      fixHome: "→ /triage",
    });
    expect(report.row.evidence).toContain("#42 acceptance criteria item is not machine-checkable");
    expect(report.findings).toEqual([
      {
        issue: 42,
        verdict: "warn",
        reason: "acceptance criteria item is not machine-checkable: The implementation passes review.",
        remediation: "refresh ## Acceptance criteria with machine-checkable checklist items, then let /triage re-run readiness",
      },
    ]);
  });

  it("ignores parent specs because they are not executable tickets", () => {
    const report = auditExecutableAcceptanceCriteria([
      candidate({
        number: 7,
        labels: ["ready-for-agent", "type:spec"],
        body: "",
      }),
    ]);

    expect(report.row.verdict).toBe("ok");
    expect(report.checked.candidates).toBe(0);
    expect(report.findings).toEqual([]);
  });

  it("reports transport failure as a read-only doctor error", () => {
    const report = auditExecutableAcceptanceCriteria([], {
      transportFailures: ["gh issue list failed"],
    });

    expect(report.row.verdict).toBe("error");
    expect(report.row.evidence).toContain("candidate-list-unavailable");
    expect(report.findings[0]?.reason).toContain("could not list ready-for-agent candidates");
  });
});
