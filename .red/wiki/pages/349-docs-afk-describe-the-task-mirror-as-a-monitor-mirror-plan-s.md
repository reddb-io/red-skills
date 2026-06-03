---
title: docs(afk): describe the Task Mirror as a `monitor --mirror-plan` subcommand
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-349]
pr: 349
merge_sha: 7c25743c6ee5e1f59c11b68fc4b76c8052081f08
---

# docs(afk): describe the Task Mirror as a `monitor --mirror-plan` subcommand

- **PR:** [#349](https://github.com/reddb-io/red-skills/pull/349)
- **Author:** @filipeforattini
- **Merge SHA:** `7c25743c6ee5e1f59c11b68fc4b76c8052081f08`
- **Format:** merged pull request

## Summary

Recovered from uncommitted WIP in the primary checkout and committed here so it isn't lost / eaten by an AFK pre-merge snapshot.

## What
Reworks the Task Mirror protocol in `afk/SKILL.md`: instead of the `mirror_plan` / `mirror_sink_codex` shell-abstraction prose, the doc now describes a concrete CLI subcommand — pipe the tracked task JSONL into `afk.mjs monitor --mirror-plan`, with `--runner codex` emitting an empty plan (Codex has no native task surface). Re-hydration and idempotency prose updated to match.

## ⚠️ Doc is ahead of code — needs author confirmation
The internal reconciler `mirrorPlan()` exists (`src/domains/dev/src/core/mirror.ts`), but a `monitor --mirror-plan` **CLI flag** does not appear to be wired in the bundle yet (no `--mirror-plan` parsing found in `src/domains/dev/src` or `afk/bin`). So this doc currently describes a subcommand that may not be runnable.

**Author: please confirm** either (a) the flag is implemented elsewhere / in a sibling branch, or (b) this doc should land together with the CLI wiring. I did not author this change — it was uncommitted WIP I recovered; flagging rather than assuming it's complete.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/349"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782869817&installation_id=129708444&pr_number=349&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F349&signature=e326298d138c0af24e1054d2ddeea69b1d0421e83a2772c8bb6e8e12fa03998b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated monitoring documentation to standardize mirroring behavior across different runner environments.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(afk): describe the Task Mirror as a `monitor --mirror-plan` subc…

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`

