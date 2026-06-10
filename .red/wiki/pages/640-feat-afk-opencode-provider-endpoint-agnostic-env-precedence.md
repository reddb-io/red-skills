---
title: feat(afk): opencode provider — endpoint-agnostic, env-precedence auth (Refs #638)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-640]
pr: 640
merge_sha: bfdfcba2e9fc9ea17e6001b69535240ac0ffb8bf
---

# feat(afk): opencode provider — endpoint-agnostic, env-precedence auth (Refs #638)

- **PR:** [#640](https://github.com/reddb-io/red-skills/pull/640)
- **Author:** @filipeforattini
- **Merge SHA:** `bfdfcba2e9fc9ea17e6001b69535240ac0ffb8bf`
- **Format:** merged pull request

## Summary

Resolves #638 (follows #626 + ADR 0059)

## What

Makes the OpenCode runner **endpoint-agnostic** by leaning on OpenCode's own
dispatcher: AFK only propagates the auth key, OpenCode routes the
`<provider>/<model>` slug to the matching OpenAI-compatible endpoint.

- New pure module `src/core/opencode-env.ts` — `resolveOpenCodeAuth(env)`
  returns the first-set auth env-var (precedence: `OPENAI_API_KEY` >
  `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`) and `openCodeAuthEnv(auth)`
  builds the `{ [envVar]: value }` payload for `OpenCodeOptions.env`.
- `buildAgent` opencode branch updated to call the resolver; when no
  precedence entry is set, the agent is spawned without an auth `env` block
  (fail-closed, OpenCode surfaces its own auth error → normal failure path).
- Config tier defaults stay `openrouter/anthropic/...` (back-compat with
  #626); the surrounding comment now explains the `<provider>/<model>` shape.
- 13 new tests cover: precedence order, empty-string-as-unset, single-env
  resolutions for all three, multi-set precedence, no-env fail-closed,
  unrelated-env-var immunity, and `<provider>/<model>` slug passthrough for
  openai/minimax/openrouter prefixes.

## Why

The original #626 hardcoded OpenRouter + `OPENROUTER_API_KEY`, blocking two
real needs: MiniMax subscription users (no OpenRouter account) and OpenAI-direct
users. Endpoint resolution belongs in OpenCode, not in AFK.

## Back-compat

When only `OPENROUTER_API_KEY` is set, behaviour is byte-for-byte identical
to the pre-amendment runner — same slug flow, same env payload name, same
config defaults. No existing test, config, or contract is changed.

## Verification

- `pnpm -C src/apps/dev test` — 1239/1239 pass (was 1147; +92 new tests)
- `pnpm -C src/apps/dev typecheck` — clean
- All 6 commits carry `Refs #638`

## Docs

- `plugins/dev/skills/engineering/afk/runner-opencode.md` — new
  *Auth env precedence* section + endpoint-agnostic framing
- `.red/adr/0059-...md` — Amendment 1 added (preserves supersession chain);
  status line now reads `accepted, amended`
- `.red/adr/INDEX.md` — entry updated to mention the amendment
- `plugins/dev/skills/engineering/afk/SKILL.md` — runner-fallback note points
  at the new precedence

Refs #638

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/640"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783681652&installation_id=129708444&pr_number=640&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F640&signature=b53a43e914f987ec22202137f7b831bf4a98ddfe1af207e50f5cb718f8d64b4b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * OpenCode runner now accepts endpoint-agnostic provider/model slugs and forwards them unchanged so tiers can target any OpenAI-compatible endpoint.

* **Documentation**
  * Updated docs and ADR to describe endpoint-agnostic routing, auth-env precedence (OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY) and back-compat notes.

* **Behavior**
  * Auth selection uses first-set precedence; runner fails closed when no key is available.

* **Tests**
  * Added coverage for auth-precedence, precedence tie-cases, and runner auth/routing behavior.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): opencode provider — env-precedence auth resolver (pure mod…
- feat(afk): buildAgent reads any precedence-set auth env-var for opencode
- docs(afk): opencode tier defaults — explain the <provider>/<model> sh…
- docs(afk): runner-opencode.md — endpoint-agnostic contract with auth …
- docs(afk): SKILL.md runner-fallback note — point at the new auth env …
- docs(adr): amend ADR 0059 — endpoint-agnostic opencode, env-precedenc…
- docs(afk): ADR 0059 Amendment 2 + dev CONTEXT — anchor MiniMax case, …
- docs(afk): ADR 0059 Amendment 2 + dev CONTEXT — anchor MiniMax case, …

## Files changed

- `.red/adr/0059-opencode-is-the-third-afk-runner-over-openrouter.md`
- `.red/adr/INDEX.md`
- `.red/contexts/dev/CONTEXT.md`
- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/runner-opencode.md`
- `src/apps/dev/src/core/config.ts`
- `src/apps/dev/src/core/execution.ts`
- `src/apps/dev/src/core/opencode-env.ts`
- `src/apps/dev/tests/execution.test.ts`
- `src/apps/dev/tests/opencode-env.test.ts`

