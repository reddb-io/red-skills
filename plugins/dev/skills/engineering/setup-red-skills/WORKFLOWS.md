# RedSkills GitHub Actions workflows

Every RedSkills workflow is filename-prefixed `red-`. They split into two
groups: **adopter-installable** (offered by `/setup-red-skills` Section D) and
**red-skills' own CI** (live in `reddb-io/red-skills`, not copied into adopter
repos).

## Adopter-installable (offered by `/setup-red-skills`)

| Workflow | Default | Trigger | What it does |
|---|---|---|---|
| `red-issues-needs-triage.yml` | **install (yes)** | `issues: opened`/`reopened` | Auto-applies `needs-triage` to any fresh label-less issue, so reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). |
| `red-afk-attempt.yml` | **opt-in (no)** | `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`, `workflow_call` | The **AFK Actions lane** — runs one `/afk` attempt per issue headless from Actions and opens a PR (no fleet, no admin-merge; human merges). Needs an OpenCode auth secret + a trust-gate allowlist. Full guide: [`../afk/actions-lane.md`](../afk/actions-lane.md). |

The AFK lane has two shapes (both in `../afk/examples/`): the **turnkey caller**
(`red-afk-attempt-caller.yml`, what `/setup-red-skills` installs) and the
**composable action** (`red-afk-attempt-action.yml`, for your own triggers/gate).
It depends only on GitHub-official actions plus reddb-io's own composite action.

## red-skills' own CI (NOT installed into adopter repos)

These run in `reddb-io/red-skills` only. Listed so the catalogue is complete.

| Workflow | Trigger | What it does |
|---|---|---|
| `red-release.yml` | push to `main` | Auto-release: conventional-commit version bump, build the per-plugin bundles, publish a GitHub Release with the assets. Defers while a `running` issue (an active fleet) exists. |
| `red-memory-drift-guard.yml` | `pull_request` | Fails a PR that changes a watched memory surface (`.red/adr/**`, the glossary) without a `Memory-Ingested:`/`Memory-NoIngest:` audit marker. |
| `red-memory-bench.yml` | `pull_request`, push to `main` | Memory deterministic-core regression gate. |
| `red-memory-wiki-extract.yml` | PR merge | Extracts LLM-Wiki pages from the merged PR. |
| `red-upstream-watch.yml` | schedule | Opens a tracking issue when `mattpocock/skills` advances past the recorded `.upstream` SHA. |

## Conventions

- **Prefix `red-`** is mandatory for every RedSkills workflow (easy to spot alongside the host repo's own CI).
- Adopter-installable workflows are copied by `/setup-red-skills` Section D from this skill folder (`workflows/`) or, for the AFK lane, from `../afk/examples/`.
