---
title: feat(afk): Actions-lane reusable workflow — add the lanes input (#631 GHA target)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-688]
pr: 688
merge_sha: d21a1317c552d00a625ab5b0b0ce967da6666c7b
---

# feat(afk): Actions-lane reusable workflow — add the lanes input (#631 GHA target)

- **PR:** [#688](https://github.com/reddb-io/red-skills/pull/688)
- **Author:** @filipeforattini
- **Merge SHA:** `d21a1317c552d00a625ab5b0b0ce967da6666c7b`
- **Format:** merged pull request

## Summary

Parent PRD #614. Addresses the **GHA target** of #631 (k8s target deferred — see below).

The reusable workflow already shipped this session (ADR 0062: `red-afk-attempt.yml` + the `afk-attempt` composite action). Verified against #631's GHA acceptance:
- ✅ `workflow_call`, red-prefixed filename
- ✅ inputs: `issue_number`, `runner` (opencode default), `model`, `effort`, `enforce_trust_gate` — **+ `lanes` added here** (the one missing item)
- ✅ secrets: openrouter/minimax/openai/anthropic
- ✅ `permissions:` exactly `contents: write`, `issues: write`, `pull-requests: write`
- ✅ checks out, installs pnpm/runner, exports the key, runs the version-pinned launcher `--once`, posts the envelope

**`lanes`** (default `actions`) threads workflow → composite action `lane` → `RED_AFK_LANE` env. It is an observability/forward-compat tag — there is no `--lanes` runtime flag, so it does not change the one-attempt/one-issue/one-PR contract.

**k8s target deferred:** the job manifest needs cluster specifics (registry, namespace, secret refs) and was explicitly deferred by ADR 0062. **#631 stays open** for that piece; this PR completes the GHA half. Both YAML files parse clean.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/688"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783746605&installation_id=129708444&pr_number=688&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F688&signature=8b63a91efe1134f8fee255fed3b758455c470a60ed697c15361463d9281fcfe4"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added optional execution lane selection (actions or k8s) for improved observability capabilities.

* **Documentation**
  * Updated documentation to reflect new execution lane configuration option and its default behavior.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): Actions-lane reusable workflow — add the `lanes` input (#6…

## Files changed

- `.github/actions/afk-attempt/action.yml`
- `.github/workflows/red-afk-attempt.yml`
- `plugins/dev/skills/engineering/afk/actions-lane.md`

