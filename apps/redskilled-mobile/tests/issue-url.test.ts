import { describe, expect, it } from "vitest";

import {
  InvalidGitHubIssueUrlError,
  parseGitHubIssueUrl,
} from "../src/domain/issue-url";

describe("parseGitHubIssueUrl", () => {
  it("derives repository and Ticket from a GitHub Issue URL", () => {
    expect(
      parseGitHubIssueUrl("https://github.com/reddb-io/red-skills/issues/4312"),
    ).toEqual({
      owner: "reddb-io",
      repository: "red-skills",
      ticket: 4312,
      canonicalUrl: "https://github.com/reddb-io/red-skills/issues/4312",
    });
  });

  it("trims input and removes query, fragment, and trailing slash", () => {
    expect(
      parseGitHubIssueUrl(
        "  https://github.com/reddb-io/red-skills/issues/42/?notification_referrer_id=1#issuecomment-2  ",
      ).canonicalUrl,
    ).toBe("https://github.com/reddb-io/red-skills/issues/42");
  });

  it.each([
    "",
    "https://gitlab.com/reddb-io/red-skills/issues/42",
    "http://github.com/reddb-io/red-skills/issues/42",
    "https://github.com/reddb-io/red-skills/pull/42",
    "https://github.com/reddb-io/red-skills/issues/0",
    "https://github.com/reddb-io/red-skills/issues/not-a-number",
    "https://github.com/reddb-io/red-skills/issues/42/extra",
  ])("refuses non-Issue input %s", (input) => {
    expect(() => parseGitHubIssueUrl(input)).toThrow(
      InvalidGitHubIssueUrlError,
    );
  });
});
