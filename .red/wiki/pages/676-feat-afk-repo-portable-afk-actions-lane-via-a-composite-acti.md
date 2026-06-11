---
title: feat(afk): repo-portable AFK Actions lane via a composite action (ADR 0062)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-676]
pr: 676
merge_sha: 937713d28f67c75034f467b512fc30ce734c89a9
---

# feat(afk): repo-portable AFK Actions lane via a composite action (ADR 0062)

- **PR:** [#676](https://github.com/reddb-io/red-skills/pull/676)
- **Author:** @filipeforattini
- **Merge SHA:** `937713d28f67c75034f467b512fc30ce734c89a9`
- **Format:** merged pull request

## Summary

Makes the AFK Actions lane **run in any repo**, not just red-skills, by extracting execution into a composite action — the architecture worked out in discussion.

## The problem
The reusable `red-afk-attempt.yml` ran the launcher as a **workspace path** (`node plugins/dev/.../afk.mjs`). That only resolves when the checked-out repo *is* red-skills. An adopter calling the reusable gets `actions/checkout` of **their** repo → the launcher path doesn't exist → broken for adopters (the lane's stated audience).

## The architecture (3 layers)
| Layer | What | Where |
|---|---|---|
| trigger + policy | when + trust gate | reusable workflow |
| **execution** | run one attempt | **composite action (new)** |
| runtime distribution | fetch the versioned bundle | launcher + Release (ADR 0038/0039) |

- **`.github/actions/afk-attempt`** — composite action: setup-node, install the runner CLI (`opencode-ai`/`@anthropic-ai/claude-code`/`@openai/codex`), run the launcher against the caller's checkout. The portability trick: `uses: reddb-io/red-skills/.github/actions/afk-attempt@<ref>` makes GitHub fetch the red-skills tree, so the committed `afk.mjs` + `plugin.json` ride along under `github.action_path` → the launcher resolves its version and fetches the matching `dev` bundle (red-castle inlined) **in any repo**. CI invariants baked in: `RED_AFK_SANDBOX=none`, `GH_TOKEN`, committer identity, `--once`.
- **`red-afk-attempt.yml`** — now thin: triggers (`issues: labeled`/`opened`, dispatch, call) + trust gate, delegating execution to the action. red-skills **dogfoods** it.
- **Two adoption surfaces, one primitive**: turnkey reusable (`examples/red-afk-attempt-caller.yml`) or composable direct-action (`examples/red-afk-attempt-action.yml`).

## Notes
- Secrets are action **inputs** (composite actions can't read `secrets.*`); `github.token` is used directly. Minimal perms.
- Reproducibility by pinning `afk-attempt@v1` (fixes both the action and the bundle version). A `v1` tag will be cut after merge.
- ADR 0062 (refines 0059) + INDEX.
- Open follow-ups unchanged: #621 (allowlist from config), #622 (atomic claim CAS vs. local fleet).

## Validation
`actionlint` clean on the workflow + action; all example YAML parses. End-to-end still needs a real issue event (+ API-key secrets configured) — recommend a live smoke after merge + tag.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/676"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783740047&installation_id=129708444&pr_number=676&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F676&signature=60684311989ea93cf423f057aad14fe2c3224edffd75c13d24b4a91c89d1c776"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **New Features**
  * Introduced a reusable GitHub Action for running automated fix attempts on repository issues, enabling integration across different repositories.

* **Documentation**
  * Added architecture decision record documenting the composite action design, integration patterns, and its role within the automated issue-fixing workflow.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): extract the Actions lane into a repo-portable composite ac…

## Files changed

- `.github/actions/afk-attempt/action.yml`
- `.github/workflows/red-afk-attempt.yml`
- `.red/adr/0062-afk-actions-lane-is-a-composite-action.md`
- `.red/adr/INDEX.md`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-action.yml`

