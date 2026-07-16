# Red-castle is vendored source, not a git submodule

## Status

accepted.

## Context

ADR 0061 moved AFK execution from the public `@ai-hero/sandcastle` package to
reddb.io's fork, `@reddb-io/red-castle`, consumed as TypeScript source from
`packages/red-castle`. The first topology used a git submodule pinned at an
exact red-castle commit.

That submodule shape became daily operational drag: fresh worktrees needed
submodule initialization before package installation, GitHub Actions checkouts
carried submodule-specific options, and red-castle changes required a two-repo
commit + pointer-bump flow even though RedSkills is the only consumer.

## Decision

Replace the `packages/red-castle` git submodule with the full red-castle file
tree in this monorepo. The squash import records the final standalone commit:
`977af58444ff18810ffa25fd698035ab5e548746` from
`https://github.com/reddb-io/red-castle`.

`packages/red-castle/.upstream` remains as the upstream sandcastle marker.
Standalone changesets are not imported, and the standalone `reddb-io/red-castle`
repository is archived after this import lands.

## Consequences

- Red-castle remains a source-consumed workspace package. Its `package.json`
  `main`, `types`, and root export continue to point at `src/index.ts`.
- RedSkills no longer needs `.gitmodules`, gitlinks, submodule checkout options,
  or submodule initialization hooks for red-castle.
- The root workspace gate still excludes `@reddb-io/red-castle` by default so the
  existing CI memory budget is unchanged; package-local `test` and `typecheck`
  remain available through normal package scripts.
- Changes to the AFK substrate now land in one PR against this monorepo.

## Amends

- ADR 0061 — preserves the source-consumed package decision, replaces the
  submodule topology with an in-repo vendored source tree.
