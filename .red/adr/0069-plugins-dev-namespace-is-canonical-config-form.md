# `plugins.dev.*` is the canonical written config form; the doctor enforces it and migrates legacy top-level keys

## Status

accepted.

Relates: [ADR 0042](0042-one-red-config-yaml-with-plugins-namespace.md) (the `plugins.<plugin>.*` config namespace),
[ADR 0067](0067-per-directory-plugin-activation-gate.md) (`plugins.<name>.enabled` gate, also namespaced),
PR #697 (`fix(config): fold plugins.dev.<key> onto the dev.* accessor — so dev settings can stay namespaced`).

## Context

ADR 0042 established that plugin settings nest under `plugins.<plugin>.*`, and PR
#697 made the config loader fold the **whole** `plugins.dev.*` block onto the
`dev.*` accessors (e.g. `plugins.dev.lock.primary-branch` →
`dev.lock.primary-branch`), with the namespaced form winning over any legacy
top-level one. So both forms *resolve* correctly.

But two surfaces never finished adopting the namespace:

- **`/setup-red-skills`** (`activatePrimaryBranchLockConfig`) still **wrote** the
  guard flag at top-level `dev.lock.primary-branch`, producing the mixed layout
  `plugins.dev.enabled` + top-level `dev.lock` in every fresh config.
- **`/doctor`** treated top-level and namespaced as **equally adopted**, so it
  never nudged a repo toward the namespace and could not heal the drift.

The result read as a bug to maintainers ("why is the lock outside `plugins.dev`
when everything else is inside?") even though it functioned. With the fold in
place, the only thing missing was a single canonical *written* form and a doctor
that enforces it.

## Decision

1. **`plugins.dev.*` is the canonical written form.** Top-level `dev.*` and
   `afk:` blocks (and the flat `lock-primary-branch`) remain **legacy-but-read**
   via the #697 fold; they are not errors, but they are drift.

2. **`/setup-red-skills` writes the namespaced form.**
   `activatePrimaryBranchLockConfig` now ensures
   `plugins.dev.lock.primary-branch: true` (creating the `plugins:` → `dev:` →
   `lock:` nesting as needed) and never writes the top-level form. It leaves a
   pre-existing top-level `dev.lock.*` untouched — migrating that is the doctor's
   gated job, not setup's.

3. **`/doctor` gains a namespacing-conformance check** (check 6, the strict
   structural one). Read-only Pass 1 flags any legacy top-level dev-plugin
   placement as a migration finding (`→ /setup-red-skills`); `--fix` Pass 2
   migrates the key(s) into `plugins.dev.*` and deletes the top-level orphan,
   gated **confirm-each** (it is a config-key migration). The guard-flag adoption
   sub-check still reports `true` as adopted regardless of placement, because the
   fold reads both.

## Why

- Finishes the job #697 started: the fold made namespacing *possible*; this makes
  it the *default and enforced* form, so the layout stops looking half-migrated.
- Splitting "write canonical" (setup) from "migrate legacy" (doctor `--fix`,
  gated) keeps setup non-destructive and routes the irreversible bit through the
  doctor's existing confirm-each gate.
- Doing both together avoids a ping-pong: a stricter doctor without a namespaced
  setup writer would flag exactly what setup just produced.

## Consequences

- A future change must **not** revert `activatePrimaryBranchLockConfig` to the
  top-level form, nor relax the doctor check, without superseding this ADR — that
  would reintroduce the mixed layout.
- Existing repos keep working untouched (the fold reads their top-level keys);
  they converge to the namespace only when `/doctor --fix` runs and the
  maintainer confirms the migration.
- The guard's *default-off* semantics and the loader fold are unchanged; this ADR
  only moves the canonical *written* location and teaches the doctor to enforce
  it.
