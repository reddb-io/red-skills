---
title: docs(afk): execution-environment command surface — GHA + k8s adoption path (Refs #631)
type: source
tags: [pr, merged]
created: 2026-06-10
updated: 2026-06-10
sources: [pr-657]
pr: 657
merge_sha: 82c0cd84ca9a053609365b3fd103af0eafd25f4d
---

# docs(afk): execution-environment command surface — GHA + k8s adoption path (Refs #631)

- **PR:** [#657](https://github.com/reddb-io/red-skills/pull/657)
- **Author:** @filipeforattini
- **Merge SHA:** `82c0cd84ca9a053609365b3fd103af0eafd25f4d`
- **Format:** merged pull request

## Summary

## What

Lifts the existing `/afk --issues N --runner opencode --once` invocation
into the GHA + k8s adoption context. No runtime change — the command line
is stable across local, GHA, and k8s. The reusable workflow + container
that wrap this for adopters are tracked as #631 (now `ready-for-agent`
with the full GHA + k8s acceptance criteria, hard deps mapped to
#621/#622/#625, suggested slice order).

## Why

Adopters who want to drive the AFK inner agent from a GitHub Actions
runner or a k8s pod need to know:

1. The command line is stable (no new subcommand, no flag).
2. The secret-injection surface is the env-precedence resolver
   (`OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`, see
   PR #640).
3. The trust gate is rigorous by default in the Actions lane.

Without this doc, an adopter has to read the source to figure out which
`GITHUB_TOKEN` permissions are required, who claims the issue, when the
trust gate fires, and how the runtime/caller responsibilities split.

## What changed

- `plugins/dev/skills/engineering/afk/SKILL.md`: new *Running `/afk` in
  an execution environment (GitHub Actions / k8s)* subsection under
  *When To Use* with the canonical invocation, a 12-row
  runtime/caller responsibility table, the recommended
  `--permissions:` block, and the trust-gate-by-default contract.
- `.red/contexts/dev/CONTEXT.md`: two new glossary terms — *Execution
  environment* (GHA + k8s, shared runtime contract) and *Actions lane*
  (the GHA reusable-workflow surface of the execution environment) —
  with avoid-antonyms.
- `CHANGES.md`: release-notes entry at the top.

## No runtime change

- `pnpm -C src/apps/dev test` — 141/141 pass on the targeted suite
  (opencode-env, execution, config, runner-detection).
- `pnpm -C src/apps/dev typecheck` — clean.
- drift-guard local: pass (commit-trailer `Memory-Ingested: 4e293f7a`
  is on the head).

## Tracking

- Issue #631 (now `ready-for-agent`) is the implementation slice —
  reusable workflow + Dockerfile + k8s job + trust gate wiring + atomic
  claim integration + E2E test.
- This PR is docs-only and unblocks the slice by giving the implementer
  (and the adopter) a single place to read the command contract.

Refs #631

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/657"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783697205&installation_id=129708444&pr_number=657&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F657&signature=86b47a9372c6b53235f12b59a154adc416fdd8b774049bb4e1fae2d069eafa71"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Added a comprehensive setup and usage guide for running the afk tool across GitHub Actions and Kubernetes execution environments, including detailed command syntax and configuration requirements.
  * Documented environment variable precedence rules, required permissions, and default trust settings with configuration options.
  * Updated glossary with new concepts and definitions clarifying execution environments and workflow lanes terminology.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- docs(afk): execution-environment command surface — GHA + k8s adoption…

## Files changed

- `.red/contexts/dev/CONTEXT.md`
- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`

