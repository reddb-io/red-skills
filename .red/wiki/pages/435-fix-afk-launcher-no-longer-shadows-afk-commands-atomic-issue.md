---
title: fix(afk): launcher no longer shadows AFK commands + atomic issue claim (#434)
type: source
tags: [pr, merged]
created: 2026-06-03
updated: 2026-06-03
sources: [pr-435]
pr: 435
merge_sha: 01d2f8e9deb9f7e30862787259bbbdc18a32c04e
---

# fix(afk): launcher no longer shadows AFK commands + atomic issue claim (#434)

- **PR:** [#435](https://github.com/reddb-io/red-skills/pull/435)
- **Author:** @filipeforattini
- **Merge SHA:** `01d2f8e9deb9f7e30862787259bbbdc18a32c04e`
- **Format:** merged pull request

## Summary

Closes #434.

## Defect 1 — launcher CLI ambiguity (`run` shadowed)
The shared entrypoint (`src/packages/shared/entrypoint-cli.ts`, ADR 0039) checked the generic `run`/`fetch` subcommands **before** the build's `run:<plugin>` pin. The dedicated `afk.mjs` launcher (role `run:dev`) is meant to forward *all* args to the dev bundle, but `argv[0]==="run"` won first — so `afk.mjs run --boot-only` parsed `--boot-only` as a **plugin name** and 404'd fetching a bogus bundle; only the bare form happened to work.

**Fix:** honour the `run:<plugin>` pin first, so a dedicated launcher forwards everything to its bundle (which owns `run`/`monitor`/`fleet`/…). The generic verbs remain on `red-fetch.mjs` (the fetch-role build). Rebuilt `afk.mjs` + `red-fetch.mjs` from the source. Verified: `afk.mjs run --boot-only` now reaches the orchestrator.

## Defect 2 — claim race → duplicate PRs
`claimLock.acquire` was **check-then-act**: `pathExists(dir)` then `ensureDir(dir)`. `ensureDir` is `mkdir -p` (idempotent) so two simultaneous boots both passed the existence check and both created the dir → **both claimed the same oldest issue → duplicate PRs** (#934/#936 class). The SKILL promised a "POSIX-atomic mkdir lock" that the implementation never delivered.

**Fix:** `tryAcquireClaimDir` — a **non-recursive** `mkdir` that fails `EEXIST` (the real atomic primitive), and writes the holder pid so the boot-time stale-claim sweep works.

## Tests
- `entrypoint-cli.test.ts`: run-pin wins over `run`/`fetch` verbs; `run --boot-only`, `monitor`, AFK's own `run`, literal `fetch` all forward to the bundle.
- `fs-sweep.test.ts`: `tryAcquireClaimDir` grants once, denies the second, and lets **exactly one of 8 concurrent racers** win the same issue.
- Dev suite 843/874 local-green; the single miss is a heap-OOM under concurrent AFK load, not a test failure (all touched files pass in isolation).

## Acceptance criteria
- [x] A documented invocation reliably starts ONE worker (both `afk.mjs run …` and bare now work; SKILL documents the forwarder contract).
- [x] `--runner`/`-n`/`--issues` parse correctly through the launcher.
- [x] Two near-simultaneous boots never both claim the same issue.
- [x] Regression coverage for the claim race and launcher arg-parsing.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/435"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783084286&installation_id=129708444&pr_number=435&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F435&signature=bded91ae50141562a6f69f32b8ded203227febe51f28e0cfef21f5555ae62a38"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- fix(afk): launcher no longer shadows AFK commands + atomic issue clai…

## Files changed

- `plugins/dev/hooks/red-fetch.mjs`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/bin/afk.mjs`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/runtime/fs.ts`
- `src/apps/dev/tests/fs-sweep.test.ts`
- `src/packages/shared/entrypoint-cli.test.ts`
- `src/packages/shared/entrypoint-cli.ts`

