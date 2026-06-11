---
title: docs(afk): progressive disclosure — split the SKILL.md monolith (~21k → ~13.4k tokens)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-679]
pr: 679
merge_sha: bae3fd27f22235b40621fee1862ddb27f04b7715
---

# docs(afk): progressive disclosure — split the SKILL.md monolith (~21k → ~13.4k tokens)

- **PR:** [#679](https://github.com/reddb-io/red-skills/pull/679)
- **Author:** @filipeforattini
- **Merge SHA:** `bae3fd27f22235b40621fee1862ddb27f04b7715`
- **Format:** merged pull request

## Summary

`afk/SKILL.md` was a **113 KB / ~21k-token flat monolith** loaded in full on every `/afk` invocation. After reading it: most of the bulk is bundle-internal **reference** (schemas, templates, boot-sweep mechanics) the agent never executes by hand — the agent runs the bundle (`afk.mjs`); the SKILL.md is the operating contract + reference. So the reference can move out behind links (progressive disclosure, per the CLAUDE.md `<what-to-do>`/`<supporting-info>` convention).

## What moved (verbatim → `afk/docs/`)
| doc | content |
|---|---|
| `BOOT-SWEEPS.md` | orphan cleanup, attempt cap, snapshot-branch grace, `/afk reap` (#257/#258/#275) |
| `LIVENESS.md` | heartbeat + solo-run stall protection (#400/#363) |
| `ENVELOPE.md` | terminal-event envelope schema, stage detection, live header, `afk.state.json` |
| `HANDOFF.md` | the `handoff.md` template |
| `CONFIG.md` | configuration knobs + lifecycle hooks |

SKILL.md keeps a 1–2 line summary + link for each, plus the **whole operating contract**: invocation, runner detection, hard preconditions, issue selection, the per-issue loop, runner fallback, termination bounds, fleet/monitor + the **binding** task-mirror tick, stop/reporting/safety. All in-doc cross-references repointed to the docs.

## Conservative on purpose
Kept Fleet Mode / Monitor and the core per-issue loop **in** SKILL.md — they carry binding directives, higher risk to move. This was the safe extraction (templates/schemas/reference only).

## Verification
- **1051 → 631 lines (~21k → ~13.4k tokens, −36%)**
- frontmatter intact; `scripts/validate-agent-metadata.sh` → `agent metadata ok`
- every agent-facing binding rule still in SKILL.md (`RED_AFK_RUNNER`, "do not read its code", `SAFETY.md`, hard preconditions, the "must do it on every tick" task mirror)
- no dangling `*Section*` refs; all `docs/*.md` links resolve
- moved blocks are byte-verbatim (no content rewritten)

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/679"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783743324&installation_id=129708444&pr_number=679&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F679&signature=2c61a03196487f64fdb46e9ded3a9c7e226911426c2926dcfd412a95960d673b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(afk): progressive disclosure — extract pure-reference blocks out…

## Files changed

- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/docs/BOOT-SWEEPS.md`
- `plugins/dev/skills/engineering/afk/docs/CONFIG.md`
- `plugins/dev/skills/engineering/afk/docs/ENVELOPE.md`
- `plugins/dev/skills/engineering/afk/docs/HANDOFF.md`
- `plugins/dev/skills/engineering/afk/docs/LIVENESS.md`

