---
title: feat(afk): dev.lock.branch static base lock — runtime > config > pin > main (stage 2, extends ADR 0031)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-701]
pr: 701
merge_sha: 22841366e788804728ddbbe3050103253083e6ad
---

# feat(afk): dev.lock.branch static base lock — runtime > config > pin > main (stage 2, extends ADR 0031)

- **PR:** [#701](https://github.com/reddb-io/red-skills/pull/701)
- **Author:** @filipeforattini
- **Merge SHA:** `22841366e788804728ddbbe3050103253083e6ad`
- **Format:** merged pull request

## Summary

Stage 2 of the lock redesign (stage 1 = #700). `dev.lock.branch` is a **static, committed base lock**: when set, AFK bases/merges on that branch. It slots into the ADR 0031 precedence:

```
runtime .red/tmp/branch-lock.yaml  >  config dev.lock.branch  >  pin  >  main
```

Your decision: **config = default, runtime overrides** — the `/branch-lock` skill still re-locks dynamically per session (runtime wins), but a repo can commit a default base lock.

- `base-resolver.ts` — `configLockedBranch` dep in the precedence.
- `run.ts` — both `resolveBase` sites (boot-reconcile + per-issue `buildProcessDeps`) read `dev.lock.branch`.
- `config-template.yaml` documents it.
- Deliberately **not** in CONFIG_DEFAULTS (default is *unset*; `getConfig` returns "" for an absent key, preserving the every-default-non-empty invariant).

Tests: runtime overrides config; config wins over pin (short-circuits resolution); empty falls through. **62/62**, typecheck clean.

Now the full shape works:
```yaml
plugins:
  dev:
    lock:
      primary-branch: true
      branch: my-branch
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/701"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783775659&installation_id=129708444&pr_number=701&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F701&signature=ece3fb1a17ca96709a86fc69a803bb0ad3bb328e60fa3483468fa69011a7bbb6"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Added support for a configurable default locked branch via `dev.lock.branch` in configuration files. When set, this value serves as a fallback for branch resolution when no runtime lock is active, with runtime locks maintaining priority. Configuration template updated with usage examples.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): dev.lock.branch — a static config base lock (runtime > con…

## Files changed

- `apps/dev/src/commands/run.ts`
- `apps/dev/src/core/base-resolver.ts`
- `apps/dev/src/core/config.ts`
- `apps/dev/tests/base-resolver.test.ts`
- `plugins/dev/skills/engineering/setup-red-skills/config-template.yaml`

