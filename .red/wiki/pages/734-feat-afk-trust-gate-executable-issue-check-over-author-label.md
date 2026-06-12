---
title: feat(afk): trust gate — executable-issue check over author × label-actor × allowlist (#621)
type: source
tags: [pr, merged]
created: 2026-06-12
updated: 2026-06-12
sources: [pr-734]
pr: 734
merge_sha: bfdc33816431e288ed212aec62ffcb2531ea5979
---

# feat(afk): trust gate — executable-issue check over author × label-actor × allowlist (#621)

- **PR:** [#734](https://github.com/reddb-io/red-skills/pull/734)
- **Author:** @filipeforattini
- **Merge SHA:** `bfdc33816431e288ed212aec62ffcb2531ea5979`
- **Format:** merged pull request

## Summary

Closes #621

## Summary

- `core/trust-gate.ts` — pure IO-free predicate: `parseTrustPolicy` (absent allowlist → permissive), `evaluateTrustGate` (author AND label-actor must both be allowlisted), `planTrustStrip` (sweep with audit comment)
- `core/process-issue.ts` — claim-time enforcement before any worktree/handoff; no-op when permissive
- `runtime/gh.ts` — `issueTrust` reads author + `ready-for-agent` label actor from the issue timeline
- `commands/run.ts` — wires `issueTrust` into the per-issue claim deps
- `tests/trust-gate.test.ts` + `tests/process-issue.test.ts` — full author × actor × allowlist matrix, claim-path refusal, permissive-default
- `config-template.yaml` — documents `afk.trust-gate.allowlist` (absent = permissive)

Rebased cleanly onto current `origin/main` (resolving the `process-issue.ts` conflict against the ADR 0066 atomic-claim architecture). 1447/1447 tests pass, tsc clean.

> Branch pointer fix: inner agent rebased correctly inside sandcastle worktree; the outer AFK live branch pointer (`afk/wWH31/621-...`) was never updated, causing the feedback gate to run on the stale pre-rebase branch. This PR is off the properly rebased snapshot (`afk-attempts/wWH31/621-...`).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/734"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783869023&installation_id=129708444&pr_number=734&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F734&signature=2215959ca89324ad73a66d2969b5299f50e4c74739786daeb36d6f2f7adbaaa3"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): pure trust-gate predicate — executable-issue check over au…
- test(afk): exhaustive trust-gate matrix — author/actor/allowlist/perm…
- feat(afk): gh issueTrust provenance — author + ready-for-agent label …
- feat(afk): enforce trust gate at claim time before any worktree/handoff
- feat(afk): wire gh.issueTrust into the per-issue claim deps
- test(afk): claim-path trust-gate refusal + permissive-default coverage
- docs(afk): document trust-gate.allowlist config (absent = permissive)

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/process-issue.ts`
- `apps/dev/src/core/trust-gate.ts`
- `apps/dev/src/runtime/gh.ts`
- `apps/dev/tests/process-issue.test.ts`
- `apps/dev/tests/trust-gate.test.ts`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`

