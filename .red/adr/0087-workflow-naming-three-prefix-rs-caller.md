# Workflow naming: three role-based prefixes — `reusable-*` / `rs-*` / `red-*`

## Context

`.github/workflows/` mixes three kinds of file with different lifecycles, and
the prefixes had drifted. An earlier pass (the `727-…three-prefix-naming` wiki
record) introduced three prefixes but used **`red-skills-*`** for "anything
RedSkills installs into an adopter repo" — lumping the reusable **caller**
together with verbatim copy-installables (e.g. the needs-triage labeler), and
renaming copy-installables to `red-skills-<name>.yml` on install. That conflated
two distinct roles and made the long `red-skills-` prefix collide visually with
the repo name `reddb-io/red-skills`.

We want a prefix that is **decidable from a file's role** (so it can be audited
mechanically) and that cleanly separates a *caller of a reusable* from a
*standalone workflow*.

## Decision

Every workflow filename carries one of three prefixes, chosen by **role**:

- **`reusable-*`** — a `workflow_call` reusable workflow. Lives in
  `reddb-io/red-skills`; adopters **reference it** via
  `uses: reddb-io/red-skills/.github/workflows/reusable-<name>.yml@v1`. Never
  copied; filename never changes.
- **`rs-*`** — a **caller** (an *instantiation* of a reusable): a thin workflow
  whose job is to `uses:` a `reusable-*` with concrete triggers + inputs. This
  is what an adopter installs to wire up a reusable lane — **one `rs-*` per
  reusable adopted**. `rs-` = "red-skills caller", the namespace marker for a
  red-skills-provided caller in a foreign repo.
- **`red-*`** — a **standalone** workflow authored by red-skills (no
  `workflow_call`, does not `uses:` a reusable). Most run only in
  `reddb-io/red-skills` (release, upstream-watch, workspace CI). A few are also
  offered as **verbatim copy-installables** (e.g. `red-issues-needs-triage.yml`)
  — those keep their `red-*` name when copied into an adopter (no rename).

Classification rule (used by `/doctor`): has `workflow_call:` → `reusable-*`;
`uses:` a `reusable-*` → `rs-*`; otherwise → `red-*`.

Enforcement is **advisory** via `/doctor` (a read-only naming-convention audit
that flags role/prefix mismatches), plus the rule documented in
`setup-red-skills/WORKFLOWS.md`. No CI hard-gate.

## Supersedes

This **revises** the prior three-prefix convention (the `727` wiki record):

- The reusable **caller** prefix changes `red-skills-*` → **`rs-*`**
  (`red-skills-afk-attempt.yml` → `rs-afk-attempt.yml`, in both
  `.github/workflows/` and the AFK skill's `examples/`).
- `rs-*` now means **caller of a reusable only** — not "anything installed".
- Copy-installables (needs-triage) are **no longer renamed** on install: they
  keep their `red-*` name in the adopter (the `red-skills-<name>.yml` install
  rename is retired).

## Consequences

- An adopter accumulates one `rs-*` file per reusable lane it wires up
  (today just `rs-afk-attempt.yml`); a `red-*` file can also appear in an
  adopter when a standalone is copy-installed verbatim.
- `red-*` is no longer strictly "never leaves red-skills" — it is "standalone,
  authored by red-skills", which may be copied verbatim into an adopter.
- `/doctor` gains a role-based naming check; `/setup-red-skills` install mapping
  drops the `red-skills-` rename.
