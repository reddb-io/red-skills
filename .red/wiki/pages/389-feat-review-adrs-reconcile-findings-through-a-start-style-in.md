---
title: feat(review-adrs): reconcile findings through a /start-style interview
type: source
tags: [pr, merged]
created: 2026-06-02
updated: 2026-06-02
sources: [pr-389]
pr: 389
merge_sha: b28a1f0090d133c2a43faf9782d3e3975f7e273b
---

# feat(review-adrs): reconcile findings through a /start-style interview

- **PR:** [#389](https://github.com/reddb-io/red-skills/pull/389)
- **Author:** @filipeforattini
- **Merge SHA:** `b28a1f0090d133c2a43faf9782d3e3975f7e273b`
- **Format:** merged pull request

## Summary

## What

`/dev:review-adrs` becomes an **interview**, like `/start`, so reconciliation decisions are reached as **shared agreements** instead of emitted as a flat approval list.

- **Pass 1 — Lint (read-only):** unchanged in spirit; now explicitly lints against `origin/HEAD` (not a dirty local copy, the false-positive that bit the first run) and the findings **seed a decision tree**.
- **Pass 2 — Reconcile (new, the core):** walks the findings `/start`-style — one `Q##` per turn, branches + a recommended resolution, wait, re-evaluate on cascade, **apply the agreed write inline**. `(c) defer → file a tracking issue` is a first-class branch.
- **Pass 3 — Group → INDEX** and **Pass 4 — Propagate (wiki/memory)** become further branches of the same interview, one agreement per write.

The agreement **is** the approval gate: no write without a prior agreement; no batch-emit-and-walk-away.

## Why

ADR reconciliation (which colliding ADR renumbers? full or partial supersession? supersede which graph nodes?) is exactly the hard-to-reverse, trade-off-laden decision space `/start` exists for. A flat list forces them all at once and invites a rubber-stamp; one-question-at-a-time reaches real agreement and lets one answer reshape the tree.

## Scope

Docs/skill only — `SKILL.md` body + description, root README + engineering bucket README descriptions. Original skill (not mattpocock-derived) → no CHANGES.md entry. No version bump (release computes it).

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/389"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782999823&installation_id=129708444&pr_number=389&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F389&signature=e98a6e253288f7ac4f948f392b5f213e5ccac247b6da58bcb839b235c12ea367"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

<!-- This is an auto-generated comment: release notes by coderabbit.ai -->

## Summary by CodeRabbit

* **Documentation**
  * Updated ADR review skill documentation to reflect an enhanced interview-driven reconciliation workflow. The updated process now guides users through one-question-at-a-time decision-making for ADR conflicts, automating renumbering, supersession tracking, index updates, and knowledge system propagation with stricter safeguards.

<!-- end of auto-generated comment: release notes by coderabbit.ai -->

## Commits

- feat(review-adrs): reconcile findings through a /start-style interview

## Files changed

- `README.md`
- `plugins/dev/skills/engineering/README.md`
- `plugins/dev/skills/engineering/review-adrs/SKILL.md`

