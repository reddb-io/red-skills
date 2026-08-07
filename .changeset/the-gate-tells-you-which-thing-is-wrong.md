---
"@reddb-io/dev": minor
---

The gate says which thing is wrong.

A span of fixes that share one shape: a check reported the symptom it could see
rather than the fault that caused it, so the reader was sent to repair something
that was already correct.

- **A missing toolchain is not manifest drift.** The manifest contract ran in a
  job carrying only a checkout, so every `pnpm` was `command not found` and each
  one was reported as "manifests drift — run pnpm generate-manifests". It runs
  where the workspace is installed now, and refuses by name when the toolchain
  is absent.
- **A `tq` newer than the catalog is not drift either.** The version check
  demanded equality in three places, so an operator running the current release
  went red and the remediation told them to DOWNGRADE — to match a catalog a
  broken watcher had failed to advance. The catalog is a floor now; only BEHIND
  is a failure. The watcher can advance it again: `pnpm install --lockfile-only`
  ran with pnpm's CI-implicit frozen lockfile, so the one command whose job is to
  write the lockfile was forbidden from writing it.
- **Durable state is not a live artifact, and a setting is not a moment.** Two
  `/red-doctor` checks judged by hand-kept lists and reported findings that were
  not defects — one calling the castle residents' own durable state "live
  supervisor artifacts", the other telling an operator to delete four live
  configuration keys, including the regeneration declaration that had just
  stopped a mirror going stale in CI four times over. Both now judge by what the
  thing is, declared beside the code that owns it.
- **Colour is not width, and escapes are not content.** Dashboard assertions
  measured the escaped string: a line that fits in 96 columns read as 433, and
  fields that were present read as missing. They measure what a terminal shows.
- **A read that moved pools did not vanish.** `issue list` routes to REST now —
  an unchanged poll can come back free there — so a GraphQL-only spend assertion
  read as a lost ledger record rather than a record in another pool.

## Also in this span

- **Worktrees come from git's inventory.** Host CLIs mint their own now
  (`--worktree`), before any tool call exists, so a Bash pre-exec guard cannot
  see them; this repo was already carrying 440MB of one. The audit asks git,
  which answers for hosts that do not exist yet, and `red-skills-dev worktree`
  gives the same ergonomics landing in a registered lane — for every runner,
  including the ones with no such flag.
- **A god file cannot grow back unnoticed.** A shrink-only file-size ratchet:
  a file absent from the baseline may not exceed the threshold, a file in it may
  only shrink, and one that passes under must leave the baseline. `mcp-adapter`'s
  2070-line body is six domain modules; the daemon's option and interval surfaces
  left its lifecycle.
- **`.red/` carries its own ignore rules**, and boot stops writing a second copy
  of them into the repo root.
- **The release reaches the registry**: the artifact publisher the version-train
  cutover removed is back, on the tag the engine produces.
