import { describe, expect, it, vi } from "vitest";
import { LABEL_READY, LABEL_RUNNING } from "../src/core/triage-labels.js";
import { collectClaimHygieneIssues } from "../src/runtime/wire/boot.js";

describe("boot claim-hygiene wiring", () => {
  it("scans ready and running open issues and reads each claim history once", async () => {
    const listCandidates = vi.fn(async (label: string) =>
      label === LABEL_READY
        ? [{ number: 2480 }, { number: 2495 }]
        : [{ number: 2495 }, { number: 2501 }],
    );
    const listClaimComments = vi.fn(async (issue: number) => [
      {
        id: issue,
        body: `<!-- afk:claim v1 worker=local:w${issue} kind=claim runner=codex -->`,
      },
    ]);

    const issues = await collectClaimHygieneIssues({
      listCandidates,
      listClaimComments,
    });

    expect(listCandidates.mock.calls).toEqual([[LABEL_READY], [LABEL_RUNNING]]);
    expect(issues.map((issue) => issue.number)).toEqual([2480, 2495, 2501]);
    expect(listClaimComments.mock.calls).toEqual([[2480], [2495], [2501]]);
  });
});
