---
title: feat(doctor): `--fix` gated apply lane — heal every adoption finding (read-only stays default)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-704]
pr: 704
merge_sha: b31e83922c5985b90cee50a9746cd7fc97fe877b
---

# feat(doctor): `--fix` gated apply lane — heal every adoption finding (read-only stays default)

- **PR:** [#704](https://github.com/reddb-io/red-skills/pull/704)
- **Author:** @filipeforattini
- **Merge SHA:** `b31e83922c5985b90cee50a9746cd7fc97fe877b`
- **Format:** merged pull request

## Summary

Answers "the doctor should be able to fix **anything** with `--fix`."

`/dev:doctor` was report-only; the only apply path was re-running the conservative one-time `/setup-red-skills` (leaves existing `.red/config.yaml` untouched, create-if-missing for labels) — so renamed config keys and legacy label names never self-heal. This makes the doctor the **recurring reconciler**.

- **Default stays read-only** (Pass 1 — Diagnose): the 9 checks unchanged, with every read-only guarantee the `doctor-docs` contract test pins.
- **New Pass 2 — Fix** (`--fix` only): for **every** non-green finding, applies the canonical fix via a new *Apply* table —
  - **safe batch**: missing labels, AGENTS≡CLAUDE parity (injector), `dev.lock.primary-branch`, statusline drift;
  - **confirm per-item** (hard-to-reverse): label rename/retire, stale config-key migration, `blocked:*` rotation, `.mcp.json` rewrite;
  - **delegate**: version coherence (single-writer version tool, ADR 0040), context-stack (memory/context skills).
  - **No finding is reported-but-unhealable.**
- Closes the two real gaps you flagged: **renamed-config-key migration** + **legacy-label rename**.

Tests: `doctor-docs` + `label-vocabulary-docs` green; `agent metadata ok`. README + frontmatter updated for the dual mode.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/704"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783780045&installation_id=129708444&pr_number=704&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F704&signature=2a0531cc483b1dd8aff25c84677e17cecdc788bf84ce48b1d1e90289c04ad954"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(doctor): `--fix` gated apply lane — the recurring reconciler tha…

## Files changed

- `README.md`
- `plugins/dev/skills/engineering/doctor/SKILL.md`

