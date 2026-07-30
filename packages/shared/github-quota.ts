// github-quota.ts — the single owner of GitHub's quota taxonomy (#2830).
//
// GitHub signals quota exhaustion three ways, and none of them is an
// authentication problem:
//   - PRIMARY rate limit   — REST 403 (or 429) carrying "API rate limit exceeded"
//   - SECONDARY/abuse limit — 403 "secondary rate limit" / "abuse detection mechanism"
//   - GraphQL exhaustion   — a RATE_LIMITED error type
//
// All three are TRANSIENT: the cure is to wait for the window to reset, never to
// inspect a credential. Every boundary that classifies a GitHub failure consults
// this module rather than growing its own pattern list — re-deriving the taxonomy
// per boundary is exactly how the structured-error surface and the runner-spawn
// exhaustion detector drifted apart.

/**
 * Patterns covering REST 403/429 rate-limit bodies (primary and secondary),
 * GitHub's abuse-detection response, and GraphQL RATE_LIMITED.
 */
const GITHUB_QUOTA_PATTERN =
  /rate limit exceeded|secondary rate limit|abuse detection mechanism|API rate limit|API rate limited|RATE_LIMITED|too many requests|\b429\b/i;

/**
 * The operator-facing remedy for a GitHub quota failure: wait for the window to
 * reset. Deliberately says nothing about credentials — quota exhaustion happens
 * with a perfectly valid token, and pointing the operator at `gh auth status`
 * sends them to inspect something that is not broken.
 */
export const GITHUB_QUOTA_REMEDY = "wait for the GitHub rate limit window to reset, then retry: gh api rate_limit";

/**
 * True when `text` carries a GitHub quota signal — a primary or secondary rate
 * limit, an abuse-detection response, or GraphQL RATE_LIMITED. Permanent
 * failures (bad credentials, missing scopes, 404) carry none of these markers
 * and stay false.
 */
export function isGithubQuotaText(text: string): boolean {
  return GITHUB_QUOTA_PATTERN.test(text);
}
