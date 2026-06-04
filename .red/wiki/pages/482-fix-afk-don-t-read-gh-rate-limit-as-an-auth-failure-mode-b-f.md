---
title: fix(afk): don't read gh rate-limit as an auth failure (Mode B fast-death)
type: source
tags: [pr, merged]
created: 2026-06-04
updated: 2026-06-04
sources: [pr-482]
pr: 482
merge_sha: 857fbbce1330d214082b624717577aba76598051
---

# fix(afk): don't read gh rate-limit as an auth failure (Mode B fast-death)

- **PR:** [#482](https://github.com/reddb-io/red-skills/pull/482)
- **Author:** @filipeforattini
- **Merge SHA:** `857fbbce1330d214082b624717577aba76598051`
- **Format:** merged pull request

## Summary

Part of the AFK fast-death investigation. **Mode B**: during a GitHub rate-limit burst, an AFK fleet run logged `ERROR: gh not authenticated — run 'gh auth login'` ×31 and bricked claims/labels fleet-wide — even though `gh` was fully authenticated.

## Root cause
`ghAuthenticated` (`src/apps/dev/src/runtime/gh.ts`) was `gh auth status` → `r.code === 0`. But `gh auth status` validates the configured token via a live API call, so it exits **non-zero on a transient rate-limit / network / 5xx blip while a valid token is still present**. The boot precheck (`boot.ts:85`) then fails with `gh-unauthenticated` and every supervisor respawn re-trips it.

This is structurally identical to the exhaustion-vs-crash collapse on the runner side: a rate-limit signal arriving in a shape the matcher does not recognise.

## Fix
Discriminate on the `gh auth status` report text:
- definitive unauthenticated (not logged in / bad credentials / token invalid/expired/revoked) → `false`
- transient blip (rate limit / abuse / network / 5xx / TLS) → `true` (token is configured; boot proceeds, and each gh call still degrades on its own `r.code !== 0` guard)
- unrecognised non-zero → conservative `false`

## Tests
New `tests/gh-auth.test.ts` (7 cases): exit-0, real not-logged-in, bad-credentials, API rate-limit, network/5xx, rate-limit-must-not-trip-unauth, unrecognised. Full dev suite: **928 passing** (the lone failing suite is `packages/shared/args.test.ts` failing to resolve `cli-args-parser` — an environmental worktree node_modules-symlink gap, verified passing in a normal checkout; unrelated to this change).

## Scope note
Touches AFK runtime source only; the shipped bundle is not rebuilt here (red-release is gated while a fleet runs). Follow-up still open: **Mode A** prevention — a stale-claims boot crash should self-heal or fail as a loud boot-error instead of masquerading as a per-issue no-sentinel.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/482"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783130681&installation_id=129708444&pr_number=482&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F482&signature=2cf22787cdae986c9581ecbd74346781f5ceec2937ca46a3af490321d7d79d42"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Bug Fixes**
  * Enhanced GitHub authentication detection to accurately distinguish between credential validity issues and transient failures.

* **Tests**
  * Added comprehensive test coverage for authentication validation scenarios.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): don't read gh rate-limit as an auth failure

## Files changed

- `src/apps/dev/src/runtime/gh.ts`
- `src/apps/dev/tests/gh-auth.test.ts`

