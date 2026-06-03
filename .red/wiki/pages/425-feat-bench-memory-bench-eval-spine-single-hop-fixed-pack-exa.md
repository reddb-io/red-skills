---
title: feat(bench): memory bench eval spine — single-hop, fixed-pack, exact-match/F1, JSONL (#334)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-425]
pr: 425
merge_sha: 446f9349d7868966ab793b00c786c3daad5a987e
---

# feat(bench): memory bench eval spine — single-hop, fixed-pack, exact-match/F1, JSONL (#334)

- **PR:** [#425](https://github.com/reddb-io/red-skills/pull/425)
- **Author:** @filipeforattini
- **Merge SHA:** `446f9349d7868966ab793b00c786c3daad5a987e`
- **Format:** merged pull request

## Summary

Lands the completed work from AFK attempt `wCUL2` on #334.

## Context

The AFK agent implemented #334 end-to-end (62m run), committed it, and reported `The branch is ready to merge` — but exited **without emitting the `<promise>` sentinel**, so the runtime classified it `no-sentinel`/`blocked:crashed` and escalated to `ready-for-human`. This is the no-sentinel-on-completion pattern, not a work defect. Resolved via `/dev:hitl` (maintainer decision: merge as-is).

## What's here (780 lines, one commit)

The minimal deterministic eval spine: a hand-authored single-hop engineering question set with exact gold, a fixed context pack per question over the RedDB substrate, an exact-match/F1 scorer, JSONL per-question records, driven by `benchmark-memory bench eval`.

- `src/apps/memory/src/bench-eval.ts` (scorer + runner) + `tests/bench-eval.test.ts`
- `src/apps/memory/bench/eval/single-hop/` — corpus.json, questions.json, README
- `src/apps/benchmark-memory/src/cli.ts` — wires `bench eval` alongside the existing `bench recall`/`bench latency`

## Validation (merged onto current main)

- `tsc --noEmit` clean
- `vitest tests/bench-eval.test.ts` → **14/14 pass**
- Clean merge — none of the 6 files overlap changes main made since the attempt's base.

## Acceptance criteria

- [x] Runs end-to-end + emits a score (`benchmark-memory bench eval`; the bench harness app, consistent with `bench recall`/`bench latency` — the brief's literal `memory bench` is satisfied by the bench app's `bench eval`)
- [x] Exact-match/F1 scorer is a pure, unit-tested module
- [x] Raw per-question records written as JSONL with a stable schema
- [x] Deterministic (same input → same output)

Closes #334.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/425"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783074704&installation_id=129708444&pr_number=425&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F425&signature=9c2f84b526ebbce452bb70641e22902c89580786da154520432fa81ad6c8aa3c"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(bench): memory bench eval spine — single-hop, fixed-pack, exact-…

## Files changed

- `src/apps/benchmark-memory/src/cli.ts`
- `src/apps/memory/bench/eval/single-hop/README.md`
- `src/apps/memory/bench/eval/single-hop/corpus.json`
- `src/apps/memory/bench/eval/single-hop/questions.json`
- `src/apps/memory/src/bench-eval.ts`
- `src/apps/memory/tests/bench-eval.test.ts`

