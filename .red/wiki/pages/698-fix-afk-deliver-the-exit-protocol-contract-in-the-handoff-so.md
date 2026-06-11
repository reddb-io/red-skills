---
title: fix(afk): deliver the exit-protocol contract in the handoff so agents emit the DONE sentinel
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-698]
pr: 698
merge_sha: 0debf97be5aaffab3c0410b5985dd4f5dd2227ee
---

# fix(afk): deliver the exit-protocol contract in the handoff so agents emit the DONE sentinel

- **PR:** [#698](https://github.com/reddb-io/red-skills/pull/698)
- **Author:** @filipeforattini
- **Merge SHA:** `0debf97be5aaffab3c0410b5985dd4f5dd2227ee`
- **Format:** merged pull request

## Summary

## Problem

The inner agent's only prompt is the handoff file (sandcastle `promptFile`). red-castle deliberately delegates completion-signal instruction to the caller — `run.ts`: *"the caller must instruct the agent to emit the configured tag."* But `buildHandoff()` emitted only the issue body; the AGENT-PROMPT.md workflow that `runner-claude.md` documents as inlined (`<contents of AGENT-PROMPT.md>`) was never actually delivered.

Result: an agent that finishes the work writes a prose `Done.` instead of the literal `<promise>DONE</promise>`, so the orchestrator (which matches the exact sentinel) re-invokes it until the attempt guard reaps it. Worst on the *work-already-committed-by-a-prior-attempt* path — observed live on **#623**: 8 iterations re-verifying a finished branch, never signalling.

## Fix

Append a compact `<exit-protocol>` footer to every handoff (`apps/dev/src/core/handoff.ts`), inline, matching the existing `merge.ts` sub-prompt precedent:
- **Already-done short-circuit** — emit DONE immediately when the branch already satisfies the criteria (kills the re-verify loop).
- One-commit-per-file, stop-at-commit (orchestrator owns landing).
- The final line MUST be the literal `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` — a prose "done" is not a sentinel.

Also wires the same short-circuit into AGENT-PROMPT.md as Workflow step 0.

## Verification

- `apps/dev` typecheck clean.
- 1237/1237 tests pass (84 files; `supervisor.test.ts` excluded for the known environmental OOM). New test asserts every handoff carries the sentinel contract + short-circuit.

red-castle is **not** the fix site — it correctly delegates the instruction to the caller; the gap was AFK's handoff builder.

Refs #623

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/698"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783773787&installation_id=129708444&pr_number=698&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F698&signature=32a136427420ad6077f41090f97c44e32fb9f813e6645bae471c51cee3760146"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): deliver the exit-protocol contract in the handoff so agents…

## Files changed

- `apps/dev/src/core/handoff.ts`
- `apps/dev/tests/handoff.test.ts`
- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`

