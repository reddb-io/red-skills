---
title: fix: document host-neutral dashboard invocation
type: source
tags: [pr, merged]
created: 2026-06-05
updated: 2026-06-05
sources: [pr-506]
pr: 506
merge_sha: 2208926834133347f0f73c73fdaa28e6a52e25f7
---

# fix: document host-neutral dashboard invocation

- **PR:** [#506](https://github.com/reddb-io/red-skills/pull/506)
- **Author:** @filipeforattini
- **Merge SHA:** `2208926834133347f0f73c73fdaa28e6a52e25f7`
- **Format:** merged pull request

## Summary

Closes #505

## Summary
- Updates /dashboard SKILL.md to resolve PLUGIN_ROOT in Claude Code, Codex, or from the loaded SKILL.md path.
- Keeps repo-local command documented only as a source-checkout fallback.

## Validation
- scripts/validate-install-metadata.sh
- scripts/test-validate-agent-metadata.sh


<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Enhanced dashboard documentation with clearer guidance on determining the correct plugin root and updated command instructions.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(dev): document host-neutral dashboard invocation

## Files changed

- `plugins/dev/skills/engineering/dashboard/SKILL.md`

