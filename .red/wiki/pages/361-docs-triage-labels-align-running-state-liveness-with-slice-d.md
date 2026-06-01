---
title: docs(triage-labels): align running-state liveness with Slice D (timeline-only)
type: source
tags: [pr, merged]
created: 2026-06-01
updated: 2026-06-01
sources: [pr-361]
pr: 361
merge_sha: 17568c892132c094a4c987a6525974d0db88612e
---

# docs(triage-labels): align running-state liveness with Slice D (timeline-only)

- **PR:** [#361](https://github.com/reddb-io/red-skills/pull/361)
- **Author:** @filipeforattini
- **Merge SHA:** `17568c892132c094a4c987a6525974d0db88612e`
- **Format:** merged pull request

## Summary

The `triage-labels.md` lifecycle doc still described the retired issue-thread heartbeat (`:one:` → `:four:` cycling every 10 min). **Slice D removed that** — the issue thread is now timeline-only (boot stamp, attempt envelopes, human guidance, closing envelope).

Patches:
- lifecycle diagram `running` box: `heartbeats post` → `timeline-only`
- `running` state definition: replaced the heartbeat-sub-shell sentence with the local-liveness signals (stream / agent-lane JSONL / state-file mtime)
- `## Heartbeat Comments` section → `## Liveness While running (timeline-only)`, pointing at the AFK `SKILL.md` *Heartbeat (local-only, post-Slice-D)* section as the authoritative source.

Doc-only; no behaviour change.

<!-- codesmith:footer -->
---
<a href="https://app.blacksmith.sh/reddb-io/codesmith/red-skills/pr/361"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-light-v2.svg"><img alt="View with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/view-with-codesmith-dark-v2.svg"></picture></a> <a href="https://backend.blacksmith.sh/track/enable-autofix?expires=1782875138&installation_id=129708444&pr_number=361&repository=reddb-io%2Fred-skills&return_to=https%3A%2F%2Fgithub.com%2Freddb-io%2Fred-skills%2Fpull%2F361&signature=22bea41bbbbab8cebbdc93253759fe6632617b6601df0e1ae47932fba974b034"><picture><source media="(prefers-color-scheme: dark)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"><source media="(prefers-color-scheme: light)" srcset="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-light.svg"><img alt="Autofix with Codesmith" src="https://pr-comments-assets.blacksmith.sh/codesmith/autofix-with-codesmith-dark.svg"></picture></a>
<sup>Need help on this PR? Tag <code>@codesmith</code> with what you need. Autofix is disabled.</sup>

<!-- codesmith:autofix:disabled -->
<!-- /codesmith:footer -->

## Commits

- docs(triage-labels): align running-state liveness with Slice D (timel…

## Files changed

- `.red/agents/triage-labels.md`

