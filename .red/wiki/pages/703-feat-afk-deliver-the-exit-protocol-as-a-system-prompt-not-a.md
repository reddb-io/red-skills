---
title: feat(afk): deliver the exit-protocol as a system prompt, not a handoff footer (slice 4)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-703]
pr: 703
merge_sha: a9de91437501f6730dd775cfd006c10c7de74230
---

# feat(afk): deliver the exit-protocol as a system prompt, not a handoff footer (slice 4)

- **PR:** [#703](https://github.com/reddb-io/red-skills/pull/703)
- **Author:** @filipeforattini
- **Merge SHA:** `a9de91437501f6730dd775cfd006c10c7de74230`
- **Format:** merged pull request

## Summary

Consumes red-castle's new `RunOptions.systemPrompt` (submodule `6406bcb`→`bb1b1445`, reddb-io/red-castle#5) to deliver the AFK exit-protocol contract as a **system prompt** instead of a handoff-body footer.

- claude (the dominant runner): `--append-system-prompt` — a real appended system prompt, kept out of the user turn / cached separately.
- codex / opencode (no per-invocation flag exists — verified via `--help`): red-castle prepends the contract to the handoff content.
- `buildHandoff` no longer appends the footer — the handoff body is back to pure issue data; `EXIT_PROTOCOL` stays exported and is now the `systemPrompt` payload passed on both runAgent calls.

The substrate owns the per-CLI 'how'; AFK passes the contract once. Typecheck clean; 1255 apps/dev + 388 red-castle tests green.

Refs #623

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/703"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783778690&installation_id=129708444&pr_number=703&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F703&signature=017a0f4dd6e0aa5a8fe713370ae087b9b3b1ecb178ee072cde709ede9c2a8608"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): deliver the exit-protocol as a system prompt, not a handof…

## Files changed

- `apps/dev/src/core/execution.ts`
- `apps/dev/src/core/handoff.ts`
- `apps/dev/src/core/process-issue.ts`
- `apps/dev/tests/execution.test.ts`
- `apps/dev/tests/handoff.test.ts`
- `packages/red-castle`

