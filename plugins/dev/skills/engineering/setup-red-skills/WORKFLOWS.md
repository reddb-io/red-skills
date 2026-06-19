# RedSkills GitHub Actions workflows

## Naming convention — three prefixes by role

RedSkills workflows carry one of three filename prefixes, chosen by the file's
**role**:

- **`reusable-*` — reusable workflow (called by ref).** A `workflow_call`
  workflow that lives in `reddb-io/red-skills` and adopters *invoke by reference*
  (e.g. `uses: reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v1`).
  It is **referenced, never copied** — its filename never changes.
- **`red-skills-*` — installed into an adopter repo.** Any workflow `/setup-red-skills`
  *copies* into a consumer repo's `.github/workflows/`. The `red-skills-` prefix
  lets the adopter tell at a glance which of its workflows came from RedSkills vs.
  its own CI. This covers both the thin **caller** for the reusable lane and the
  plain wholesale-copied workflows (e.g. needs-triage).
- **`red-*` — red-skills' own, never installed elsewhere.** Workflows that only
  ever run in `reddb-io/red-skills`: our internal CI (release, memory bench /
  drift-guard / wiki-extract, upstream-watch) **and** the *source* of the plain
  installables (e.g. `red-issues-needs-triage.yml`, which installs as
  `red-skills-issues-needs-triage.yml`).

Install mapping is mechanical — the destination filename gets the `red-skills-`
prefix, only the **filename** changes, and the body (including any
`uses: …/reusable-afk-attempt.yml@v1` ref) is copied verbatim:

| Role / source | Installed into adopter as |
|---|---|
| `reusable-afk-attempt.yml` (reusable — called by ref) | not copied; the **caller** is installed as `red-skills-afk-attempt.yml` |
| `red-issues-needs-triage.yml` (plain, source `red-*`) | `red-skills-issues-needs-triage.yml` |

So `red-skills` itself, as an adopter of its own lane, carries a
`red-skills-afk-attempt.yml` caller next to the `reusable-afk-attempt.yml`
reusable.

## Adopter-installable (offered by `/setup-red-skills`)

Installed under the `red-skills-*` prefix. Section D is a **menu** — the user
picks which workflows + configs.

| Source | Installed as | Default | Trigger | What it does |
|---|---|---|---|---|
| `red-issues-needs-triage.yml` | `red-skills-issues-needs-triage.yml` | **install (yes)** | `issues: opened`/`reopened` | Auto-applies `needs-triage` to any fresh label-less issue, so reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). |
| `reusable-afk-attempt.yml` (reusable, called by ref) | `red-skills-afk-attempt.yml` (the caller) | **opt-in (no)** | `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`, `workflow_call` | The **AFK Actions lane** — runs one `/afk` attempt per issue headless from Actions and opens a PR (no fleet, no admin-merge; human merges). Needs an OpenCode auth secret + a trust-gate allowlist. Full guide: [`../afk/actions-lane.md`](../afk/actions-lane.md). |

The AFK lane has two shapes (both in `../afk/examples/`): the **turnkey caller**
(`red-skills-afk-attempt.yml`, what `/setup-red-skills` installs) and the
**composable action** (`red-afk-attempt-action.yml`, for your own
triggers/gate). It depends only on GitHub-official actions plus reddb-io's own
composite action.

## red-skills' own CI (`red-*`, NOT installed into adopter repos)

These run in `reddb-io/red-skills` only. Listed so the catalogue is complete.

| Workflow | Trigger | What it does |
|---|---|---|
| `red-release.yml` | push to `main` | Auto-release: conventional-commit version bump, build the per-plugin bundles, publish a GitHub Release with the assets. Defers while a `running` issue (an active fleet) exists. |
| `red-memory-drift-guard.yml` | `pull_request` | Fails a PR that changes a watched memory surface (`.red/adr/**`, the glossary) without a `Memory-Ingested:`/`Memory-NoIngest:` audit marker. |
| `red-memory-bench.yml` | `pull_request`, push to `main` | Memory deterministic-core regression gate. |
| `red-memory-wiki-extract.yml` | PR merge | Extracts LLM-Wiki pages from the merged PR. |
| `red-upstream-watch.yml` | schedule | Opens a tracking issue when `mattpocock/skills` advances past the recorded `.upstream` SHA. |

## Conventions

- **`reusable-*`** — reusable (`workflow_call`) workflows, referenced by `uses:`, never copied into an adopter.
- **`red-skills-*`** — the installed name in an adopter repo. `/setup-red-skills` Section D copies each adopter-installable workflow into `.github/workflows/` and renames the destination `red-skills-<name>.yml` (filename only; body verbatim, including any `uses: …/reusable-afk-attempt.yml@v1` ref).
- **`red-*`** — red-skills' own workflows that never leave this repo: internal CI plus the *source* of plain installables (the source keeps `red-`; only the installed copy becomes `red-skills-`).
- red-skills self-hosts its own lane, so it carries a `red-skills-afk-attempt.yml` caller — the same `red-skills-*` an adopter installs.
