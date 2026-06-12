---
title: fix(afk): allow the https remote in the CI lane (precheck killed every GHA attempt)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-724]
pr: 724
merge_sha: 85efae8a67559801a5aa19a239447a692be13132
---

# fix(afk): allow the https remote in the CI lane (precheck killed every GHA attempt)

- **PR:** [#724](https://github.com/reddb-io/red-skills/pull/724)
- **Author:** @filipeforattini
- **Merge SHA:** `85efae8a67559801a5aa19a239447a692be13132`
- **Format:** merged pull request

## Summary

## The blocker (live GHA run)
The first real GHA run of the AFK lane on #585 got past the trust gate AND the submodule checkout, then died at:
```
[afk] precheck failed: https-remote-forbidden
```
The **SSH-only** hard precondition is a *local-dev* safety net (don't drive autonomous runs through a token-in-URL https remote). But `actions/checkout` configures an **https** remote authed by the ephemeral `GITHUB_TOKEN` — exactly the intended CI setup. So the rule must NOT fire in the lane, or every cloud attempt dies at precheck.

## Fix
New `allowHttpsRemote` fact on `PrecheckFacts`; the runtime facts-builder sets it from `RED_AFK_LANE=actions || GITHUB_ACTIONS=true`; `precheck` skips the https rejection when set. **Local dev unchanged** (those env vars are absent there). Covered with a test.

## Still needed for the lane to fully run (your infra)
The same run also showed `MINIMAX_API_KEY:` **empty** — the **org secret isn't reaching red-skills**. red-skills is a **public** repo, and **org secrets are NOT shared with public repos by default**. Enable **Public repositories** access on the `MINIMAX_API_KEY` org secret (or add it as a repo secret). Then the lane has both halves: a passing precheck (this PR) + a real auth key.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/724"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783819247&installation_id=129708444&pr_number=724&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F724&signature=392c19e1a8553b7c6a2950ae8dcde5636e3c202f855e085989e9005d29fa73e6"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added support for HTTPS remote URLs in CI/GitHub Actions environments through optional configuration flag.

* **Bug Fixes**
  * HTTPS remotes are now automatically allowed when running in GitHub Actions or CI pipelines, removing the previous blanket rejection.

* **Tests**
  * Added test coverage for HTTPS remote validation in CI environments.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(afk): allow the https remote in the CI lane (precheck killed ever…

## Files changed

- `apps/dev/src/core/boot.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/boot.test.ts`

