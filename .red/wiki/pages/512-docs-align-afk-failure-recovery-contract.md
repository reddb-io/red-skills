---
title: docs: align AFK failure recovery contract
type: source
tags: [pr, merged]
created: 2026-06-06
updated: 2026-06-06
sources: [pr-512]
pr: 512
merge_sha: e208bb72354151027326393952c4fbab4569a439
---

# docs: align AFK failure recovery contract

- **PR:** [#512](https://github.com/reddb-io/red-skills/pull/512)
- **Author:** @filipeforattini
- **Merge SHA:** `e208bb72354151027326393952c4fbab4569a439`
- **Format:** merged pull request

## Summary

Closes #353.

## Summary
- Updates the AFK SKILL.md lifecycle diagram to show bounded auto-recovery before human escalation.
- Documents typed `blocked:<reason>` labels, retry caps, and the Attempt Outcome to envelope-status mapping.
- Adds `--boot-only` to the CLI surface paragraph and corrects runner exhaustion / exit 75 wording.

## Verification
- `git diff --check`
- `scripts/test-validate-*.sh`
- `scripts/validate-agent-metadata.sh`
- `scripts/validate-install-metadata.sh`
- `scripts/validate-zoom-out-contract.sh`
- `scripts/list-skills.sh`

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/512"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783298474&installation_id=129708444&pr_number=512&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F512&signature=c87fff06e530e737049f53580056c4dc826acc62b7527cc11d3261ce3ae99c62"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **Documentation**
  * Clarified CLI flags and documented full command set for the AFK skill.
  * Refined runner exhaustion and fallback semantics, including bounded recovery and explicit exit 75 stop behavior.
  * Redesigned terminal-failure classification with typed failure labels, recovery-policy caps, and updated envelope schema.
  * Clarified sentinel/EOF handling, user-hook envelope inclusion, and merge-gate stop/rejection routing.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs: align afk failure recovery contract

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`

