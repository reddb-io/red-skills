---
title: fix(dev): resync dev claude plugin.json version (unblock red-release)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-384]
pr: 384
merge_sha: 8daab18689951eeffe3bd4420e28b7f51572ffae
---

# fix(dev): resync dev claude plugin.json version (unblock red-release)

- **PR:** [#384](https://github.com/reddb-io/red-skills/pull/384)
- **Author:** @filipeforattini
- **Merge SHA:** `8daab18689951eeffe3bd4420e28b7f51572ffae`
- **Format:** merged pull request

## Summary

red-release has failed on the last 3 pushes with `error: dev: Claude and Codex plugin versions must match`. Cause: #381/#382 landed a stale local `plugins/dev/.claude-plugin/plugin.json` (version 1.147.6) over main's 1.148.2 while `.codex-plugin` stayed 1.148.2. This resyncs claude→1.148.2 so the validator passes; the next release re-syncs both to the bump. Validated locally with `scripts/validate-install-metadata.sh` → ok. Unblocks publishing of /dev:doctor, /dev:review-adrs, and ADR 0039.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/384"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782997135&installation_id=129708444&pr_number=384&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F384&signature=acc9ad04c48ef5579b0dd5fc4a1855baa6be7c8b2a69dc26ab934784ad7bec02"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(dev): resync claude plugin.json version to 1.148.2 (unblock red-r…

## Files changed

- `plugins/dev/.claude-plugin/plugin.json`

