---
title: feat(afk): publish red-afk-attempt reusable workflow — 3 triggers + trust gate (Refs #631)
type: source
tags: [pr, merged]
created: 2026-06-11
updated: 2026-06-11
sources: [pr-665]
pr: 665
merge_sha: 79b599d68df78c909259542c70f864ced4f3cb1b
---

# feat(afk): publish red-afk-attempt reusable workflow — 3 triggers + trust gate (Refs #631)

- **PR:** [#665](https://github.com/reddb-io/red-skills/pull/665)
- **Author:** @filipeforattini
- **Merge SHA:** `79b599d68df78c909259542c70f864ced4f3cb1b`
- **Format:** merged pull request

## Summary

## ⚠️ DRAFT — needs validation before merge

This PR publishes a new GHA reusable workflow in `.github/workflows/`
of `reddb-io/red-skills`. The file adds an `issues: types: [labeled]`
trigger, which means **on merge to main, the workflow will start firing
automatically** when anyone applies the `ready-for-agent` label to any
issue in the reddb-io/red-skills repo. The trust gate has a hard-coded
`filipeforattini` fallback for the auto-trigger path until #621 lands.

**Do not merge** until:
1. The workflow is syntax-validated (this PR's CI run will do that)
2. The trust gate auto-trigger has been manually tested in a sandbox
   issue (e.g. apply ready-for-agent, confirm workflow fires, confirm
   it either claims or fails the trust gate as expected)
3. The hard-coded maintainer fallback is acceptable for reddb-io (or
   #621 lands to remove it)

## What

### New file: `.github/workflows/red-afk-attempt.yml`
The published reusable workflow — single entry point for any adopting
repository. Three triggers in one file:

- `workflow_call` — direct invocation by a thin caller
- `workflow_dispatch` — manual run from the Actions UI
- `issues: types: [labeled]` — auto-fires when `ready-for-agent` is
  applied (the `if:` filter restricts to exactly that label)

The `actions/github-script@v7` step resolves the issue number from any
of the three sources, evaluates the trust gate (author +
label-applier in caller-supplied allowlist CSV), and on pass invokes
`node plugins/dev/skills/engineering/afk/bin/afk.mjs run --issues <N>
--runner opencode --once` — the same command the local lane uses.

`permissions: contents: write, issues: write, pull-requests: write` —
minimal. No `id-token`, no `actions: write`.

### New file: `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-caller.yml`
Thin caller template (~50 lines) for adopters who want explicit
control over the trigger and allowlist in their own repo. Copies
verbatim, edits 2 allowlist values.

### Docs updated
- `SKILL.md`: new *Running `/afk` in an execution environment*
  subsection documents the three triggers, the env-var injection
  surface, the runtime/caller split, the permissions block, the
  trust-gate-by-default contract.
- `.red/contexts/dev/CONTEXT.md`: refined *Execution environment* +
  *Actions lane* glossary terms to reflect the three triggers and
  the published-vs-deferred surface split.
- `CHANGES.md`: release-notes entry.

## Hard deps (mapped in #631)

- **#621** (runtime trust-gate predicate) — REQUIRED to remove the
  hard-coded `filipeforattini` fallback in the auto-trigger path.
- **#622** (atomic claim CAS) — REQUIRED to replace the
  `--issues <N>` direct invocation with a server-side CAS that
  prevents race with a concurrent local fleet.

## Validation

- `pnpm -C src/apps/dev test --run tests/execution.test.ts tests/opencode-env.test.ts` — 141/141 pass.
- Workflow syntax: validates against the GHA schema in the PR's CI run.

## Out of scope (this slice)

- Container + k8s job manifest (still in #631).
- E2E test repo (#632).
- Removing the hard-coded maintainer fallback (#621).
- Atomic claim CAS integration (#622).

Refs #631

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/665"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1783700394&installation_id=129708444&pr_number=665&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F665&signature=a59a334e64911dac03fc44ed07851cfe0ea4f1a748270c98f2fdac59b815df9b"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>/codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->
## Summary by CodeRabbit

* **New Features**
  * Added a reusable AFK attempt workflow to run a single attempt against an issue (manual, callable, or auto-triggered on issues labeled ready-for-agent) with configurable runner, model, and a trust-gate that can enforce or bypass execution.

* **Documentation**
  * Expanded docs and examples describing the execution environment, trigger surfaces, the workflow caller template, allowlist/trust-gate behavior, and usage guidance.
<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(afk): publish red-afk-attempt reusable workflow with 3 triggers …

## Files changed

- `.github/workflows/red-afk-attempt.yml`
- `.red/contexts/dev/CONTEXT.md`
- `CHANGES.md`
- `plugins/dev/skills/engineering/afk/SKILL.md`
- `plugins/dev/skills/engineering/afk/examples/red-afk-attempt-caller.yml`

