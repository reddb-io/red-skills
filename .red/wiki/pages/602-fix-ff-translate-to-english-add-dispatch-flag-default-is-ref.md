---
title: fix(ff): translate to English + add --dispatch flag; default is reframe-only (#590)
type: source
tags: [pr, merged]
created: 2026-06-09
updated: 2026-06-09
sources: [pr-602]
pr: 602
merge_sha: 3a40a7a7155a476b05bd12ecf4a618ca26a2e53d
---

# fix(ff): translate to English + add --dispatch flag; default is reframe-only (#590)

- **PR:** [#602](https://github.com/reddb-io/red-skills/pull/602)
- **Author:** @filipeforattini
- **Merge SHA:** `3a40a7a7155a476b05bd12ecf4a618ca26a2e53d`
- **Format:** merged pull request

## Summary

Two fixes to the `/ff` skill.

**1. English-only (subsumes #590).** `/ff` shipped a Portuguese body — the recommendation template (`Acho que você quer …`), the seven option labels, and the trigger phrases — emitting Portuguese to every consumer and violating the repo English-only rule. Translated the whole skill to English.

**2. Default is reframe-only; `--dispatch` runs.** The old contract auto-continued the underlying task once the user picked a framing, so `/ff` 'went executing all at once' instead of handing the rewrite back. Now:
- **`/ff <text>`** (default): reframe → user picks → output the finalized rewrite and **stop**. Hands the prompt back; never executes.
- **`/ff --dispatch <text>`** / **`/ff -d <text>`** (new): reframe → user picks the format → **then run** the underlying task with that framing.

Frontmatter `description` + `argument-hint` updated. Doc-only (no runtime code). Recorded in `CHANGES.md`.

Closes #590.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/602"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783612613&installation_id=129708444&pr_number=602&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F602&signature=bf25e3c13e37907cb5a33ab6dae3ee67cfa1757804856332edcf3c30cbf8e4bd"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated `/ff` (fast-forward) skill: default mode now reframes text only, with new `--dispatch` flag to enable task execution after selecting a reframing option.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(ff): translate to English + add --dispatch flag; default is refra…

## Files changed

- `CHANGES.md`
- `plugins/dev/skills/productivity/ff/SKILL.md`

