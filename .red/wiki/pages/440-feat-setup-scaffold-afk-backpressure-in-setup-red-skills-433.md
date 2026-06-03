---
title: feat(setup): scaffold afk.backpressure in /setup-red-skills (#433)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-440]
pr: 440
merge_sha: 732fd8b581953e05b0d2458aaff9cd4df3a772ff
---

# feat(setup): scaffold afk.backpressure in /setup-red-skills (#433)

- **PR:** [#440](https://github.com/reddb-io/red-skills/pull/440)
- **Author:** @filipeforattini
- **Merge SHA:** `732fd8b581953e05b0d2458aaff9cd4df3a772ff`
- **Format:** merged pull request

## Summary

Closes #433. PRD #429.

Discoverability half of the backpressure feature (#430 is the runtime):

- `config-template.yaml` gains a **commented `afk.backpressure`** block (no-op until uncommented) with the documented shape.
- The setup `SKILL.md` documents the new step: on a **fresh** scaffold, detect `test`/`lint` scripts in the repo's `package.json` and **offer** to pre-fill the block with the matching `npm/pnpm run` lines (operator-confirmed); otherwise leave it commented.
- Existing `.red/config.yaml` is **never clobbered** — the clobber rule wins over the offer.

Template + skill-doc only (setup-red-skills is a prompt-driven skill; no runtime code).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/440"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783086632&installation_id=129708444&pr_number=440&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F440&signature=5191642e76480478c5d0e2c1e3e9f298a54140a5f4117635796e5b000751f688"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated setup-red-skills documentation to describe an optional backpressure pre-fill feature during configuration scaffolding.

* **Configuration**
  * Added new optional `backpressure` section to the configuration template, enabling merge-gate commands to run on successful iterations with failure handling.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(setup): scaffold afk.backpressure in /setup-red-skills (#433)

## Files changed

- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`

