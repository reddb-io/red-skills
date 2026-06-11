# Workspaces move to root `apps/` + `packages/` with a pnpm `catalog:`

## Context

ADR 0034 split plugin *definitions* from *implementation* and consolidated all
runtime code under a top-level `src/` — `src/apps/<plugin>/` for the per-plugin
runtimes and `src/packages/shared/` (later `+ build-info`) for the shared layer.
The repo was already a Turborepo (`turbo.json`, a root `pnpm-workspace.yaml`
globbing `src/apps/*` + `src/packages/*`, a root `package.json` driving
`turbo run …`), but the workspaces lived one directory deeper than the
conventional `apps/` + `packages/` root layout that Turborepo tooling, examples,
and contributors expect.

Two frictions followed from the extra `src/` nesting:

1. **Non-conventional layout.** New contributors and tooling look for `apps/` and
   `packages/` at the repo root; `src/apps`/`src/packages` is an unusual shape
   that every onboarding doc had to explain.
2. **Duplicated dependency versions.** Each workspace pinned its own
   `typescript`, `tsx`, `vitest`, `esbuild`, `@types/node`, `zod`, and
   `@modelcontextprotocol/sdk`. Bumping a shared version meant editing 6–8
   `package.json` files in lockstep.

## Decision

**Relocate the workspaces to the conventional root layout and consolidate shared
dependency versions into a pnpm `catalog:`.**

- `src/apps/*` → `apps/*`, `src/packages/*` → `packages/*` (history-preserving
  `git mv`). The definitions/implementation split from ADR 0034 is unchanged —
  only the physical paths move.
- `pnpm-workspace.yaml` globs become `apps/*` + `packages/*`, and a `catalog:`
  block becomes the single source of truth for versions shared by two or more
  workspaces. Each workspace references them as `"<dep>": "catalog:"`.
- The app↔root relative paths shorten by one level (`../../../` → `../../`) in
  every workspace `package.json` script, `turbo.json` output glob, and the few
  runtime sites that walk to the repo root. The app↔packages relative paths are
  invariant (both trees shift up together), so e.g. dev's
  `../../packages/shared/entrypoint-cli.ts` entry is unchanged.

### `@reddb-io/sdk` is deliberately NOT cataloged

`scripts/bundle-app.mjs --reddb-from-package` reads the **raw** `@reddb-io/sdk`
version string out of each consuming `package.json` to stamp the embedded SDK
version and the `red` binary tag into the bundle. pnpm leaves the literal
`"catalog:"` token in `package.json` (it resolves the catalog only at install
time, never rewriting the manifest), so cataloging the SDK would feed
`"catalog:"` into those defines and poison the bundle. `@reddb-io/sdk` therefore
stays pinned explicitly (`1.7.0`) in `apps/memory`, `apps/brain`, and
`apps/benchmark-memory`. `pnpm-workspace.yaml`'s
`minimumReleaseAgeExclude: ["@reddb-io/sdk@1.7.0"]` continues to track that pin.

`code-nav` keeps its higher `@types/node` (`^25.9.1`) and `esbuild` (`^0.28.0`)
pins explicitly rather than cataloging them, because they intentionally diverge
from the rest of the workspace.

## Consequences

- Conventional Turborepo layout: `apps/` and `packages/` at the repo root.
- One place (`catalog:`) to bump a shared toolchain or library version.
- Identical build/release behaviour: `turbo run build|bundle|typecheck|test`,
  the per-app bundle outputs under `dist/`, and the committed entrypoints
  (`plugins/dev/hooks/red-fetch.mjs`, `…/afk/bin/afk.mjs`) are byte-identical
  after a rebuild — only path strings inside them change.
- A broad, mechanical touch: every workspace `package.json`/`tsconfig`,
  `turbo.json`, the three release/bench/drift-guard CI workflows, the live docs
  (CLAUDE.md, READMEs, the affected `dev` SKILLs, the `brain` glossary), and a
  handful of runtime path-resolution + test-fixture sites.
- **Historical records are not rewritten.** Prior ADR bodies and `.red/wiki/`
  pages that mention `src/apps`/`src/packages` describe the tree as it was when
  written; per the `/dev:review-adrs` convention they keep their text and gain
  supersession/relocation notes rather than edits. ADR 0034 carries the relocation
  note; this ADR is its pointer.

## Status

accepted.

## Related

- ADR 0034 — definitions/implementation split under `src/apps`+`src/packages`
  (this ADR relocates that layout to the repo root; the split itself stands).
- ADR 0039 — plugin entrypoints share one source (the `entrypoint-cli.ts` build;
  its app↔packages entry path is invariant under this move).
- ADR 0041 — memory leaves red-skills for `red-memory`; this move does not change
  that trajectory (`apps/memory` is still the in-repo home until 0041 completes).
- ADR 0052 — one bundle-naming convention under `./dist/` (unchanged; only the
  relative `../../../dist` → `../../dist` prefixes shifted).
