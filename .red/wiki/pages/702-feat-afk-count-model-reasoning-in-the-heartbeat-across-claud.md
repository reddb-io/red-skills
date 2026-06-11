---
title: feat(afk): count model reasoning in the heartbeat across claude/codex/opencode (slice 2)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-702]
pr: 702
merge_sha: 9cd986ef3b90cb6ab7daf094e281a984e12d88fc
---

# feat(afk): count model reasoning in the heartbeat across claude/codex/opencode (slice 2)

- **PR:** [#702](https://github.com/reddb-io/red-skills/pull/702)
- **Author:** @filipeforattini
- **Merge SHA:** `9cd986ef3b90cb6ab7daf094e281a984e12d88fc`
- **Format:** merged pull request

## Summary

## What

Slice 2 of the richer liveness heartbeat. Consumes red-castle's new normalised `reasoning` stream event (submodule `34b5bfa`→`6406bcb`, reddb-io/red-castle#4) so the proof-of-life heartbeat carries a **cross-runner** reasoning signal:

- `thinking_called_count` — cumulative reasoning events (claude: one per thinking block; codex/opencode: one per reasoning-bearing turn/step)
- `reasoning_tokens` — summed reasoning tokens (codex/opencode; 0 for claude, which folds thinking tokens into output)
- `afk.log` tail gains a `think:N[/Ntok]` fragment

## Why it works on all 3 CLIs (confirmed by live capture)

| CLI | reasoning in stream | how we count it |
|---|---|---|
| claude | discrete `thinking` content blocks | one event each (text-bearing) |
| codex | **no** discrete item — only `turn.completed.usage.reasoning_output_tokens` (verified live: a trivial prompt → `reasoning_output_tokens:13`) | token-bearing event |
| opencode | **no** discrete part — only `step_finish.part.tokens.reasoning` (per the committed reference capture) | token-bearing event |

So a uniform *event count* isn't possible — the metric is defined semantically ("is the model reasoning, and how much") and each runner populates it from its confirmed real shape. Additive: a claude-only attempt accrues counts but 0 tokens; an attempt with no reasoning accrues neither.

## Submodule bump also strips red-castle's standalone machinery

red-castle is vendored source consumed as `workspace:*`, never published to npm / never tagged (the pin is the SHA). The bump pulls in the removal of its CI/release/changeset/agent workflows + a rewritten CLAUDE.md documenting the vendored-source model.

## Verification

red-castle: 383 tests green (8 new reasoning parser tests). apps/dev: 1253 tests green (new reasoning meter/heartbeat tests). Typecheck clean both sides.

Refs #623

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/702"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783776931&installation_id=129708444&pr_number=702&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F702&signature=6ce08a96b16bb50fe0e86a1386e8d42b1d52913dfb1869150b60621103e8a320"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): count model reasoning in the heartbeat across all 3 CLIs (…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/activity-meter.ts`
- `apps/dev/src/core/heartbeat.ts`
- `apps/dev/tests/activity-meter.test.ts`
- `apps/dev/tests/heartbeat.test.ts`
- `packages/red-castle`

