# RedSkills GitHub Actions workflows

## Naming convention — three prefixes by role

RedSkills workflows carry one of three filename prefixes, chosen by the file's
**role**:

- **`reusable-*` — reusable workflow (called by ref).** A `workflow_call`
  workflow that lives in `reddb-io/red-skills` and adopters *invoke by reference*
  (e.g. `uses: reddb-io/red-skills/.github/workflows/reusable-afk-attempt.yml@v1`).
  It is **referenced, never copied** — its filename never changes.
- **`rs-*` — caller of a reusable (an *instantiation*).** A thin workflow whose
  job is to `uses:` a `reusable-*` with concrete triggers + inputs. This is what
  an adopter installs to wire up a reusable lane — **one `rs-*` per reusable they
  adopt** (today just `rs-afk-attempt.yml`; more as we extract more reusables).
  `rs-` reads as "red-skills caller" — the namespace marker for a
  red-skills-provided caller in a foreign repo.
- **`red-*` — a standalone workflow authored by red-skills** (no `workflow_call`,
  does not `uses:` a reusable). Most run only in `reddb-io/red-skills` (release,
  upstream-watch, workspace CI). A few are *also* offered as verbatim
  copy-installables (e.g. `red-issues-needs-triage.yml`) — those keep their
  `red-*` name when copied into an adopter (filename unchanged, body verbatim).

Classification is by **role**, decidable from a file's content: has
`workflow_call:` → `reusable-*`; `uses:` a `reusable-*` → `rs-*`; otherwise →
`red-*`. (`/red-doctor` audits this — see its naming-convention check.)

Install mapping (body copied verbatim, including any
`uses: …/reusable-afk-attempt.yml@v1` ref):

| Role / source | Installed into adopter as |
|---|---|
| `reusable-afk-attempt.yml` (reusable — called by ref) | not copied; the **caller** is installed as `rs-afk-attempt.yml` |
| `red-issues-needs-triage.yml` (standalone `red-*` copy-installable) | `red-issues-needs-triage.yml` (verbatim — name unchanged) |

So `red-skills` itself, as an adopter of its own lane, carries a
`rs-afk-attempt.yml` caller next to the `reusable-afk-attempt.yml`
reusable.

## Adopter-installable (offered by `/red-setup`)

Section D is a **menu** — the user picks which workflows + configs. A reusable's
**caller** installs as `rs-*`; a standalone copy-installable keeps its `red-*`
name.

| Source | Installed as | Default | Trigger | What it does |
|---|---|---|---|---|
| `red-issues-needs-triage.yml` | `red-issues-needs-triage.yml` (verbatim) | **install (yes)** | `issues: opened`/`reopened` | Auto-applies `needs-triage` to any fresh label-less issue, so reports never slip past `/triage` and never sit invisible to `/afk` (which only drains `ready-for-agent`). |
| `reusable-afk-attempt.yml` (reusable, called by ref) | `rs-afk-attempt.yml` (the caller) | **opt-in (no)** | `issues: labeled`/`opened` (on `ready-for-agent`), `workflow_dispatch`, `workflow_call` | The **AFK Actions lane** — runs one `/afk` attempt per issue headless from Actions and opens a PR (no fleet, no admin-merge; human merges). Needs an OpenCode auth secret + a trust-gate allowlist. Full guide: [`../afk/actions-lane.md`](../afk/actions-lane.md). |

The AFK lane has two shapes (both in `../afk/examples/`): the **turnkey caller**
(`rs-afk-attempt.yml`, what `/red-setup` installs) and the
**composable action** (`red-afk-attempt-action.yml`, for your own
triggers/gate). It depends only on GitHub-official actions plus reddb-io's own
composite action.

## red-skills' own CI (`red-*`, NOT installed into adopter repos)

These run in `reddb-io/red-skills` only. Listed so the catalogue is complete.

| Workflow | Trigger | What it does |
|---|---|---|
| `red-release.yml` | push / merged Version-PR to `main` | Generated Release-standard workflow: maintains the **Version-PR**, then publishes its merged revision as a tag, human notes, and JSON + TOON manifests (ADR 0139). |
| `red-memory-drift-guard.yml` | `pull_request` | Fails a PR that changes a watched memory surface (`.red/adr/**`, the glossary) without a `Memory-Ingested:`/`Memory-NoIngest:` audit marker. |
| `red-memory-bench.yml` | `pull_request`, push to `main` | Memory deterministic-core regression gate. |
| `red-memory-wiki-extract.yml` | PR merge | Extracts LLM-Wiki pages from the merged PR. |
| `red-upstream-watch.yml` | schedule | Opens a tracking issue when `mattpocock/skills` advances past the recorded `.upstream` SHA. |

## Conventions

- **`reusable-*`** — reusable (`workflow_call`) workflows, referenced by `uses:`, never copied into an adopter.
- **`rs-*`** — a caller that `uses:` a `reusable-*`. What an adopter installs to wire up a reusable lane (one `rs-*` per reusable). Body copied verbatim, including the `uses: …/reusable-afk-attempt.yml@v1` ref.
- **`red-*`** — a standalone workflow authored by red-skills (no `workflow_call`, no `uses:` a reusable). Internal CI plus verbatim copy-installables (e.g. needs-triage) that keep the `red-*` name in the adopter.
- red-skills self-hosts its own lane, so it carries a `rs-afk-attempt.yml` caller — the same `rs-*` an adopter installs.
