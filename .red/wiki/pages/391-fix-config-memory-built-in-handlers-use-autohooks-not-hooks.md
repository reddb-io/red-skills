---
title: fix(config): memory built-in handlers use autohooks, not hooks (ADR 0042 refine)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-391]
pr: 391
merge_sha: d9dae1f4af5720609bf8c4c0a81c897ccb487b37
---

# fix(config): memory built-in handlers use autohooks, not hooks (ADR 0042 refine)

- **PR:** [#391](https://github.com/reddb-io/red-skills/pull/391)
- **Author:** @filipeforattini
- **Merge SHA:** `d9dae1f4af5720609bf8c4c0a81c897ccb487b37`
- **Format:** merged pull request

## Summary

Follow-up to #390 (ADR 0042). Fixes an overload I introduced: `plugins.memory.hooks.sessionStart: true` put **booleans** under `hooks:`, but `.red/config.yaml`'s `hooks:` convention (AFK, ADR 0026) is **user-authored shell** — ordered lists of inline commands or script paths.

## The distinction (ADR 0042 point 6)

- **User hooks** (`hooks:`, any plugin) — shell interceptors the user *writes and controls*. `plugins.dev.afk.hooks.pre_session: [./.red/hooks/boot.sh, …]`.
- **Built-in hooks** — handlers the plugin *ships and owns* (memory's 4 auto-firing Claude Code event handlers; AFK's cargo/gradle defaults). Not user config; where toggleable, the toggle is a plain enable under a **different** key → `plugins.memory.autohooks.<event>: true`.

```yaml
plugins:
  dev:
    afk:
      hooks:                 # user shell
        pre_session: [ ./.red/hooks/boot.sh ]
  memory:
    mode: graph
    autohooks:               # enable OUR handlers
      sessionStart: true
```

## Change

- `shared-config.ts` parse/emit `autohooks` instead of `hooks`. `MemoryConfig` interface unchanged (in-memory `hooks` object stays); only the yaml key changes.
- ADR 0042 example + new decision point 6.

## Tests

memory typecheck clean; `shared-config` 11 pass; init-wizard + backup + graph-store round-trips pass (autohooks flows init→write→read). drift-guard: `Memory-NoIngest` trailer (ADR 0027).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/391"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783003615&installation_id=129708444&pr_number=391&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F391&signature=4f6728e3591414487c82ab514bee6c0950527969420da065584b613a56fd15ca"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Breaking Changes**
  * Memory plugin configuration now uses `autohooks` for built-in handlers instead of `hooks`.
  * Reserved `hooks:` key for user-authored shell hooks within plugin namespaces.
  * Update existing memory plugin configurations accordingly.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- fix(config): memory built-in handlers use autohooks, not hooks (ADR 0…

## Files changed

- `.red/adr/0042-plugin-config-unified-under-red-config-yaml.md`
- `src/apps/memory/src/shared-config.ts`
- `src/apps/memory/tests/shared-config.test.ts`

