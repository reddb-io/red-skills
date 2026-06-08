---
title: feat(config): unify plugin config under .red/config.yaml (plugins.<name>)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-06
sources: [pr-390]
pr: 390
merge_sha: d37478888666249c8c841968fad3b461a89bef10
---

# feat(config): unify plugin config under .red/config.yaml (plugins.<name>)

- **PR:** [#390](https://github.com/reddb-io/red-skills/pull/390)
- **Author:** @filipeforattini
- **Merge SHA:** `d37478888666249c8c841968fad3b461a89bef10`
- **Format:** merged pull request

## Summary

## What — ADR 0042

One config file per repo: `.red/config.yaml`, namespaced by plugin under `plugins:`. Memory config moves out of the standalone `.red/memory/config.json` (JSON) into a sparse `plugins.memory` block of the same file `dev` reads under `plugins.dev`.

```yaml
plugins:
  dev:
    afk:
      default_runner: codex
  memory:
    mode: graph
    hooks:
      sessionStart: true
```

## Why

Two plugins resolved config in two formats, two locations, for no principled reason. Memory's config is **write-once (the init wizard) and choice-or-default** — never a runtime machine-writer — and both sides already have a read seam, so unification is cheap and safe. (Grilled via `/start`: total unification + wizard emits a sparse block.)

## How (contained at the seams)

- **memory**: new `shared-config.ts` — parse `plugins.memory`, emit a **sparse** block (only non-defaults; `reddb`/`version` derived, never persisted), merge into the yaml preserving the rest. `readConfig`/`writeConfig`/`configPath` retarget the yaml with a **legacy `.red/memory/config.json` read fallback**. `MemoryConfig` interface unchanged → all 23 read sites + the wizard untouched. **No YAML dependency** (same constrained-subset grammar `dev` uses).
- **dev**: `loadConfig` folds `plugins.dev.afk.*` down to the bare `afk.*` accessor keys (namespaced wins; legacy top-level `afk.*` still read) → accessors untouched.
- **gate (ADR 0009)**: `dev` soft-detects memory via a `plugins.memory` block **or** the legacy json. The installed git-hook guard + the triage/zoom-out/diagnose/context/afk skill snippets mirror it.
- **backup** embeds a synthesized `config.json` snapshot → self-contained regardless of where the live config lives.

## Back-compat

Both sides read the legacy location as a fallback (deprecated, removable later). No forced migration — a repo upgrades when it re-runs `memory init`. ADR 0009 annotated (gate mechanism partially superseded). **Bundles unchanged** — release builds from source; the `afk.mjs` launcher (ADR 0038) is untouched.

## Current ADR record (2026-06-06)

ADR 0042 is accepted and travels with the memory migration to `red-memory`: the
contract is `.red/config.yaml` with plugin namespaces under `plugins.*`. ADR
0009's one-directional soft-use decision still stands, but its detection-gate
mechanism is partially superseded by the `plugins.memory` block, with the legacy
`.red/memory/config.json` fallback retained only for compatibility.

## Tests

- `dev`: full suite **841 pass**, typecheck clean. New: `plugins.dev` fold + yaml-gate tests.
- `memory`: default gate **689 pass** + impacted integration (init-wizard, backup, graph-store, vcs-hooks-e2e, mcp-server, provenance, extraction-status) pass; typecheck clean. New: `shared-config.test.ts` (parse / sparse emit / merge round-trip).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/390"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783002640&installation_id=129708444&pr_number=390&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F390&signature=b719f24c6fcd85e0d10bd1c166d73368da724e583f9b67fb57f1fe9082324b5a"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(config): unify plugin config under .red/config.yaml (plugins.<na…
- docs(memory): mark ADR changes for deferred ingest

## Files changed

- `.red/adr/0009-dev-soft-uses-memory-one-directional.md`
- `.red/adr/0042-plugin-config-unified-under-red-config-yaml.md`
- `plugins/dev/skills/engineering/afk/AGENT-PROMPT.md`
- `plugins/dev/skills/engineering/context/SKILL.md`
- `plugins/dev/skills/engineering/diagnose/SKILL.md`
- `plugins/dev/skills/engineering/triage/SKILL.md`
- `plugins/dev/skills/engineering/zoom-out/SKILL.md`
- `plugins/memory/README.md`
- `plugins/memory/skills/core/doctor/SKILL.md`
- `plugins/memory/skills/core/export/SKILL.md`
- `plugins/memory/skills/core/extract/SKILL.md`
- `plugins/memory/skills/core/health/SKILL.md`
- `plugins/memory/skills/core/ingest/SKILL.md`
- `plugins/memory/skills/core/init/SKILL.md`
- `plugins/memory/skills/core/recall/SKILL.md`
- `plugins/memory/skills/core/store/SKILL.md`
- `src/apps/dev/src/commands/run.ts`
- `src/apps/dev/src/core/attempt-record.ts`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/tests/attempt-record.test.ts`
- `src/apps/dev/tests/config.test.ts`
- `src/apps/memory/src/backup.ts`
- `src/apps/memory/src/config.ts`
- `src/apps/memory/src/mcp-server.ts`
- `src/apps/memory/src/shared-config.ts`
- `src/apps/memory/src/vcs-hooks-install.ts`
- `src/apps/memory/tests/graph-store.test.ts`
- `src/apps/memory/tests/init-wizard.test.ts`
- `src/apps/memory/tests/shared-config.test.ts`
- `src/apps/memory/tests/vcs-hooks-install.test.ts`
