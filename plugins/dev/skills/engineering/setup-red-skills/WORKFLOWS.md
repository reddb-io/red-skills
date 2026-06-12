# RedSkills GitHub Actions workflows

## Naming convention — `red-*` (source) vs `rs-*` (installed)

RedSkills workflows live under two prefixes, and which one applies depends on
**whose repo the file is in**:

- **`red-*` — source / reusable.** Every workflow that lives in
  `reddb-io/red-skills` is filename-prefixed `red-`. These are our own CI plus
  the reusable workflow + composite action that adopters *call by ref* (e.g.
  `uses: reddb-io/red-skills/.github/workflows/red-afk-attempt.yml@v1`). The
  `red-` file in our repo never changes name — it is referenced, not copied.
- **`rs-*` — installed into an adopter repo.** When `/setup-red-skills` *copies*
  a workflow into a consumer repo's `.github/workflows/`, it renames it `rs-*`
  (RedSkills) so the adopter can tell at a glance which of its workflows came
  from us vs. its own CI. The rename is purely the **filename**; the contents
  (and any `uses: …/red-afk-attempt.yml@v1` ref inside) keep the `red-` source
  name. Mapping is mechanical: `red-<name>.yml` → `rs-<name>.yml` (e.g.
  `red-issues-needs-triage.yml` → `rs-issues-needs-triage.yml`, the AFK caller
  → `rs-afk-attempt.yml`).

So `red-skills` itself, as an adopter of its own lane, carries an
`rs-afk-attempt.yml` caller next to the `red-afk-attempt.yml` reusable.

They split into two groups: **adopter-installable** (offered by
`/setup-red-skills` Section D, installed as `rs-*`) and **red-skills' own CI**
(live in `reddb-io/red-skills` as `red-*`, never copied into adopter repos).

## Adopter-installable (offered by `/setup-red-skills`)

| Source (`red-*`) | Installed as (`rs-*`) | Default | Trigger | What it does |
|---|---|---|---|---|
| `red-issues-needs-triage.yml` | `rs-issues-needs-triage.yml` | **install (yes)** | `issues: opened`/`reopened` | Auto-applies `needs-triage` to any fresh label-less issue, so reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). |
| `red-afk-attempt.yml` (reusable, called by ref) | `rs-afk-attempt.yml` (the caller) | **opt-in (no)** | `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`, `workflow_call` | The **AFK Actions lane** — runs one `/afk` attempt per issue headless from Actions and opens a PR (no fleet, no admin-merge; human merges). Needs an OpenCode auth secret + a trust-gate allowlist. Full guide: [`../afk/actions-lane.md`](../afk/actions-lane.md). |

The AFK lane has two shapes (both in `../afk/examples/`): the **turnkey caller**
(`red-afk-attempt-caller.yml`, what `/setup-red-skills` installs as
`rs-afk-attempt.yml`) and the **composable action**
(`red-afk-attempt-action.yml`, for your own triggers/gate). It depends only on
GitHub-official actions plus reddb-io's own composite action.

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

- **Prefix `red-`** is mandatory for every RedSkills workflow that lives in `reddb-io/red-skills` (source + reusable + our own CI), easy to spot alongside the host repo's own CI.
- **Prefix `rs-`** is the installed name in an adopter repo. `/setup-red-skills` Section D copies each adopter-installable `red-<name>.yml` from this skill folder (`workflows/`) — or, for the AFK lane, the caller from `../afk/examples/` — and renames the destination file `rs-<name>.yml`. Only the filename changes; the body (including any `uses: …/red-afk-attempt.yml@v1` ref) is copied verbatim.
- The reusable `red-afk-attempt.yml` is **never copied** into an adopter — it is referenced by `uses:` from the installed `rs-afk-attempt.yml` caller.
