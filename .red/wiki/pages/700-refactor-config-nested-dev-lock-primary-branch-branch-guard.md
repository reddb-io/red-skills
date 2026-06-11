---
title: refactor(config): nested dev.lock.primary-branch branch guard (stage 1 of the lock redesign)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-700]
pr: 700
merge_sha: a5585934ae7e7f237638c7063ca6ee6f959463a2
---

# refactor(config): nested dev.lock.primary-branch branch guard (stage 1 of the lock redesign)

- **PR:** [#700](https://github.com/reddb-io/red-skills/pull/700)
- **Author:** @filipeforattini
- **Merge SHA:** `a5585934ae7e7f237638c7063ca6ee6f959463a2`
- **Format:** merged pull request

## Summary

Stage 1 of the more-specific lock config: the guard flag moves from flat `dev.lock-primary-branch` to nested **`dev.lock.primary-branch`** (`dev:` → `lock:` → `primary-branch: true`), so `dev.lock.branch` can join it. **Clean rename, no legacy fallback** (your call).

Cross-cutting + **safety-critical** (the guard runs in bash AND TS):
- `config.ts` — key renamed; the `plugins.dev.*` fold already maps `plugins.dev.lock.primary-branch` → `dev.lock.primary-branch`.
- **Both bash readers** (`dev-config.sh`, `block-dangerous-git.sh`) match `dev.lock.primary-branch` OR `plugins.dev.lock.primary-branch`.
- `development-workflow.ts` injector rewritten to upsert the nested `lock:` block (handles: no dev block, dev-without-lock, lock-without-primary-branch, replace).
- `.red/config.yaml`, `config-template.yaml`, branch-lock/git-guardrails/setup/doctor docs, injected `## Development workflow` block.

**Verified:** 5/5 bash guard tests, 57/57 TS tests, typecheck clean, repo config resolves `dev.lock.primary-branch = true`.

Stage 2 (`dev.lock.branch` → base-resolver: runtime > config > pin > main) follows next.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/700"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783775162&installation_id=129708444&pr_number=700&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F700&signature=0bdf295ba1967d3be1c56c8631b3a9f617ea3e728240935eb5bf61a5e2df8c63"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- refactor(config): rename the branch guard to nested `dev.lock.primary…

## Files changed

- `.red/config.yaml`
- `AGENTS.md`
- `CLAUDE.md`
- `apps/dev/src/core/config.ts`
- `apps/dev/src/core/development-workflow.ts`
- `apps/dev/tests/config.test.ts`
- `apps/dev/tests/development-workflow.test.ts`
- `apps/dev/tests/doctor-docs.test.ts`
- `apps/dev/tests/label-vocabulary-docs.test.ts`
- `plugins/dev/hooks/branch-lock-codex.sh`
- `plugins/dev/skills/engineering/doctor/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/SKILL.md`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`
- `plugins/dev/skills/misc/branch-lock/SKILL.md`
- `plugins/dev/skills/misc/branch-lock/scripts/branch-lock-hook.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/lib/dev-config.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/claude-plugin-hook.test.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/codex-hook.test.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/dev-config.test.sh`
- `plugins/dev/skills/misc/branch-lock/scripts/tests/git-command-classifier.test.sh`
- `plugins/dev/skills/misc/git-guardrails-claude-code/SKILL.md`
- `plugins/dev/skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh`
- `plugins/dev/skills/misc/git-guardrails-claude-code/scripts/tests/block-dangerous-git.test.sh`

