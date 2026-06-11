---
title: docs(afk): consolidate the Actions-lane / reusable-workflow docs into one adopter guide
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-678]
pr: 678
merge_sha: a1b0bc7b002f5dd855798a7bac335fda09adf1c7
---

# docs(afk): consolidate the Actions-lane / reusable-workflow docs into one adopter guide

- **PR:** [#678](https://github.com/reddb-io/red-skills/pull/678)
- **Author:** @filipeforattini
- **Merge SHA:** `a1b0bc7b002f5dd855798a7bac335fda09adf1c7`
- **Format:** merged pull request

## Summary

The reusable workflow + composite action (ADR 0059/0062) were documented only in scattered YAML comments, two examples, and ADRs — and the `afk/SKILL.md` section had gone **stale**: 3 triggers (not 4), a `pnpm install` caller table that no longer applies, no mention of the composite action, and a duplicated code block. README had **zero** mention of the lane.

## What
- **New `plugins/dev/skills/engineering/afk/actions-lane.md`** — the single adopter guide:
  - 3-layer architecture (reusable workflow → composite action → launcher + Release bundle)
  - turnkey (reusable) vs composable (action) adoption, with both example links
  - the 4 triggers, the ADR 0056 trust gate, the full input table
  - opencode auth precedence + the **MiniMax recipe**, the `runner`/`model`/`effort` overrides
  - CI invariants (`RED_AFK_SANDBOX=none`, minimal permissions)
  - notes the lane depends only on **GitHub-official actions + our own**
- **`afk/SKILL.md`** — replaced the stale "execution environment" subsection with a tight, accurate summary pointing to the new guide.
- **`README.md`** — added a "Running /afk from GitHub Actions" pointer + the run-time `--runner`/`--model`/`--effort` override note.
- **caller example** — pinned the reusable to `@v1` (matches the composable example).

Cross-links verified; English-only; no watched memory surfaces (code-only docs PR).

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/678"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783742280&installation_id=129708444&pr_number=678&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F678&signature=6eecb7f5f7c9848bcd86ca992be50820a0d96e70300ac3436def876599ed156e"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(afk): consolidate the Actions-lane / reusable-workflow docs into…

## Files changed

- `README.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/actions-lane.md`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-caller.yml`

