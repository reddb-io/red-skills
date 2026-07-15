# AFK Docs Sweep enforces origin-visible docs before worker dispatch

## Status

Accepted. Successor of ADR 0092.

## Context

ADR 0092 made `/start` land glossary and ADR edits before cascade, because
downstream automation must read docs from origin rather than from one local
checkout. That still left a consumer gap: `/afk` could boot while `.red/` docs
were modified, untracked, ignored by an adopter repo, or committed locally but
not reachable from `origin/<base>`.

If workers dispatch against that state, each worker sees origin-visible docs that
are stale relative to the maintainer's local source of truth. Injecting those
docs into every handoff would make each worker carry private truth and would be
hard to audit.

## Decision

`/afk` owns a boot-time **Docs Sweep** before any worker dispatch. The sweep
detects unlanded `.red/` glossary docs (`.red/CONTEXT.md`,
`.red/CONTEXT-MAP.md`, `.red/contexts/**`) and ADR docs (`.red/adr/**`) from
working-tree status, untracked and ignored status, and commits not reachable from
fresh `origin/<base>`.

When all stranded docs are publishable, `/afk` lands them through the ADR 0092
lane: create an isolated worktree from `origin/<base>` under `.red/tmp/`, copy
only the stranded doc files, commit once with a `docs:` subject, push, open one
PR, merge it, and rely on the normal post-landing fast-forward/fetch path.

When reachability cannot be verified, push/PR/merge fails, or an ignored doc
class has no tracked precedent on origin, the sweep halts boot with the explicit
relative file list. It never commits in the primary checkout, switches the
primary branch, stashes, or resets.

Gitignored operational surfaces stay out of scope: `.red/tmp/`, `.red/wiki/`,
`.red/memory/`, `.red/brain/`, and `.red/state/`.

## Consequences

AFK becomes an enforcement-at-consumer gate for docs truth. `/start` still tries
to land docs at the producer edge, but `/afk` now refuses to drain a fleet
against stranded docs if the producer edge was skipped or failed.

Adopter repos that ignore `.red/` wholesale can still publish known doc classes,
because the sweep force-adds ignored glossary or ADR files only when that path
class already has tracked precedent on `origin/<base>`. A zero-precedent class
is reported for a maintainer decision instead of silently publishing a new
repository policy surface.
