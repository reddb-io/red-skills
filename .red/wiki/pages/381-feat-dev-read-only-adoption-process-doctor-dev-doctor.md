---
title: feat(dev): read-only adoption/process doctor (/dev:doctor)
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-381]
pr: 381
merge_sha: 02129ce9fa463eacc0e3831d3e470aacc37bab62
---

# feat(dev): read-only adoption/process doctor (/dev:doctor)

- **PR:** [#381](https://github.com/reddb-io/red-skills/pull/381)
- **Author:** @filipeforattini
- **Merge SHA:** `02129ce9fa463eacc0e3831d3e470aacc37bab62`
- **Format:** merged pull request

## Summary

Adds **`/dev:doctor`** — a read-only adoption/process doctor, the recurring counterpart to the one-time `/setup-red-skills` (same split the `memory` plugin has between `context-status` and setup).

Came out of an adoption study across `reddb` / `red-ui` / `red-skills`: the **core process is ~100% adopted** everywhere; the gaps are on the edges and are exactly what a read-only doctor should surface.

## What it checks (read-only — names the fix-home, never applies)
1. Composes `memory:context-status` (local stack: CLAUDE/AGENTS/.red/CONTEXT(-MAP)/adr/memory/wiki).
2. **Label conformance** vs the repo's `.red/agents/triage-labels.md` — flags non-canonical synonyms (`needs-human-decision`→`ready-for-human`), legacy (bare `blocked`), naming violations.
3. **`blocked:*` hygiene** — open issues carrying `ready-for-agent`/`running` + stale `blocked:*` (real: reddb #923-925).
4. **AGENTS≡CLAUDE parity** — both files + both with the `## Agent skills` block.
5. **Statusline drift** — installed command is the cached-bundle form, not the OLD launcher form that blanks on update.
6. **MCP wiring** — `code-nav`/`red-memory` wired for the repo's own dev.

Output: scorecard + readiness score + recommendations, each tagged `→ /setup-red-skills` / `→ AFK runtime` / `→ manual`.

## Notes
- Read-only by design (DON'Ts mirror `context-status`). Public-repo safe; **CI/CD standardization explicitly out of scope**.
- Registered in `plugin.json` + root README + engineering bucket README; Codex picks it up via the `./skills/` wildcard.
- Pairs with the upcoming `/dev:review-adrs` (decision-record coherence) and `memory:doctor` (graph) — three read-only doctors over different axes.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/381"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782996331&installation_id=129708444&pr_number=381&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F381&signature=be220237cedac82e263fe97c57129260b9b704113f1d964026d08c69f0630aaf"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- feat(dev): add read-only adoption/process doctor skill

## Files changed

- `README.md`
- `plugins/dev/.claude-plugin/plugin.json`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/doctor/SKILL.md`

