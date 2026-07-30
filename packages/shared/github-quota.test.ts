import { describe, expect, it } from "vitest";

import { GITHUB_QUOTA_REMEDY, isGithubQuotaText } from "./github-quota.js";

describe("isGithubQuotaText (the one owner of GitHub's quota taxonomy)", () => {
  it("recognises the primary rate limit, which GitHub returns as a 403", () => {
    expect(isGithubQuotaText("HTTP 403: API rate limit exceeded for user ID 12345. (https://api.github.com/graphql)")).toBe(true);
    expect(isGithubQuotaText("API rate limit exceeded for installation ID 12345.")).toBe(true);
  });

  it("recognises secondary and abuse limits", () => {
    expect(isGithubQuotaText("HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes.")).toBe(true);
    expect(isGithubQuotaText("You have triggered an abuse detection mechanism.")).toBe(true);
    expect(isGithubQuotaText("HTTP 429: Too Many Requests")).toBe(true);
  });

  it("recognises GraphQL exhaustion", () => {
    expect(isGithubQuotaText('{"errors":[{"type":"RATE_LIMITED","message":"API rate limit exceeded"}]}')).toBe(true);
  });

  it("stays false for permanent failures — credentials, scopes, and not-found", () => {
    expect(isGithubQuotaText("HTTP 401: Bad credentials")).toBe(false);
    expect(isGithubQuotaText("gh: To use GitHub CLI in a GitHub Actions workflow, set the GH_TOKEN environment variable.")).toBe(false);
    expect(isGithubQuotaText("You are not logged into any GitHub hosts. Run gh auth login to authenticate.")).toBe(false);
    expect(isGithubQuotaText("HTTP 404: Not Found")).toBe(false);
    expect(isGithubQuotaText("normal command output")).toBe(false);
  });
});

describe("GITHUB_QUOTA_REMEDY", () => {
  it("describes waiting and never credential inspection", () => {
    expect(GITHUB_QUOTA_REMEDY).toMatch(/wait/i);
    expect(GITHUB_QUOTA_REMEDY).not.toMatch(/auth/i);
  });
});
