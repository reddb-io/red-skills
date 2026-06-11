---
title: feat(afk): model/effort override via --model/--effort flag + RED_AFK_MODEL/RED_AFK_EFFORT env
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-677]
pr: 677
merge_sha: 006514229ed673cb2063bdfefd57aaecbab9e6ef
---

# feat(afk): model/effort override via --model/--effort flag + RED_AFK_MODEL/RED_AFK_EFFORT env

- **PR:** [#677](https://github.com/reddb-io/red-skills/pull/677)
- **Author:** @filipeforattini
- **Merge SHA:** `006514229ed673cb2063bdfefd57aaecbab9e6ef`
- **Format:** merged pull request

## Summary

Closes the gap you flagged: the per-issue model was **config-file-only**, inconsistent with `--runner`/`RED_AFK_RUNNER` and `RED_AFK_SANDBOX` (both flag+env). You couldn't point AFK at a MiniMax subscription (or any model) without editing `.red/config.yaml`.

## What
A runtime override with the same precedence pattern as the other knobs:

```
--model flag  >  RED_AFK_MODEL env  >  .red/config.yaml  >  defaults     (idem --effort / RED_AFK_EFFORT)
```

- **`config.ts` `resolveTier`**: optional `env` param; a non-empty `RED_AFK_MODEL`/`RED_AFK_EFFORT` **flattens every tier** onto one slug (`""` = unset). Opt-in per call site — the AFK run path passes `process.env`; the interactive model-tier route does **not** (so it's unaffected).
- **`run.ts`**: `--model`/`--effort` flags pre-set `process.env.RED_AFK_MODEL/EFFORT` (flag wins over a pre-existing env), so the override flows through both `--once` (in-process) **and** the fleet (`buildWorkerEnv` passes them — not in the denylist).
- **`wire.ts`**: `resolveRunSettings` threads its `env` into `resolveTier`.
- **CI**: the `afk-attempt` composite action **and** the reusable workflow gain `model`/`effort` inputs → `RED_AFK_MODEL`/`RED_AFK_EFFORT` (the reusable's previously-reserved `model_slug` becomes the functional `model`).
- **Docs**: `model-tier-policy/SKILL.md` documents the knob with the MiniMax example.

## Your MiniMax case — now config-free
```bash
# local
MINIMAX_API_KEY=… afk run --runner opencode --model minimax/MiniMax-M2 --issues 42
# or env-only
RED_AFK_RUNNER=opencode RED_AFK_MODEL=minimax/MiniMax-M2 MINIMAX_API_KEY=… afk run --issues 42
```
```yaml
# CI (composable action)
- uses: reddb-io/red-skills/.github/actions/afk-attempt@v1
  with: { issue: …, runner: opencode, model: minimax/MiniMax-M2, minimax-api-key: ${{ secrets.MINIMAX_API_KEY }} }
```
The slug's leading segment routes the endpoint; `opencode-env.ts` picks the matching key.

## Validation
- `resolveTier` override unit test (config.test.ts **41/41**), run-flags **18/18**, dev typecheck clean, dev bundle builds, actionlint clean.
- Runtime proof: `RED_AFK_MODEL=minimax/MiniMax-M2` → `resolveTier` returns it; `""` ignored; no-env arg → default.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/677"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783741670&installation_id=129708444&pr_number=677&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F677&signature=37704cc88f4e1748c77f6087594f7746603ce016f288cf3635ffe93d8ef5637a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(afk): override model/effort via --model/--effort flag and RED_AF…

## Files changed

- `.github/actions/afk-attempt/action.yml`
- `.github/workflows/red-afk-attempt.yml`
- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/config.ts`
- `apps/dev/src/runtime/wire.ts`
- `apps/dev/tests/config.test.ts`
- `plugins/dev/skills/engineering/model-tier-policy/SKILL.md`

