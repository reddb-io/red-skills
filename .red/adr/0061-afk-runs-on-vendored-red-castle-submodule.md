# AFK execution runs on the vendored `@reddb-io/red-castle` submodule, consumed as source

## Context

ADR 0033 put AFK's execution substrate on the npm package `@ai-hero/sandcastle` —
it owns the agent spawn, the git worktree, the sandbox, and landing commits via
`run()`. `apps/dev/src/core/execution.ts` is the single seam coupled to it
(`defaultSandcastleDeps()` dynamically imports the package root plus the
`./sandboxes/{no-sandbox,docker,podman}` subpaths; the pure mapping is typed
against `RunOptions`/`RunResult`/`AgentStreamEvent`).

We want to own and evolve that substrate. `git@github.com:reddb-io/red-castle.git`
is reddb.io's fork of sandcastle, with the same public API. Depending on the
public npm package leaves us unable to ship substrate fixes on our cadence.

## Decision

**Vendor red-castle as a git submodule at `packages/red-castle` and consume its
TypeScript source directly, under the name `@reddb-io/red-castle`, replacing the
`@ai-hero/sandcastle` npm dependency.**

- **Submodule**, tracking `main` (`.gitmodules` `branch = main`). The committed
  gitlink pins an exact commit for reproducible builds/CI; updating is an explicit
  `git submodule update --remote` + commit.
- **Renamed** in the red-castle repo to `@reddb-io/red-castle` (avoids any
  resolution clash with the published `@ai-hero/sandcastle`).
- **Source-direct, no build of red-castle.** Its `package.json` `exports` point at
  `./src/*.ts`. esbuild (the dev bundle) and tsx (the dev runtime) compile the
  source inline — the same way the dev bundle already inlined sandcastle's `dist`.
  red-castle's `effect`/`@effect/*`/`zod`/`@clack/prompts`/`@standard-schema/spec`
  imports become real `dependencies` (tsup no longer inlines them for source
  consumers). `@vercel/sandbox`/`@daytona/sdk` stay optional/external (their
  sandbox backends are never imported by AFK).
- **Workspace member, but not a red-skills gate.** `packages/*` makes it the
  `@reddb-io/red-castle` workspace package consumed via `workspace:*`. red-skills'
  own `turbo run build|test|typecheck` exclude it (`--filter=!@reddb-io/red-castle`)
  — it is a vendored dependency, not ours to build or gate; its upstream suite runs
  in the red-castle repo.
- **The single seam is unchanged.** Only `execution.ts` (and its test) swap the
  import specifier `@ai-hero/sandcastle` → `@reddb-io/red-castle`. The AFK
  issue-policy layer, sentinels, feedback gate, and landing are untouched.

### Consuming raw `.ts` across toolchains

Because dev's `tsc` compiles red-castle's source (exports resolve to `.ts`, not a
`.d.ts` skipped by `skipLibCheck`), red-castle's source must type-clean under dev's
toolchain (`typescript@5.6`, `@types/node@22`), not only its own (`typescript@6`,
`@types/node@25`). That required two upstream fixes in red-castle: add
`@standard-schema/spec` to `dependencies`, and widen three sandbox `stdio` casts to
`as unknown as StdioOptions` (no runtime change). New red-castle features that don't
type-clean under dev's toolchain will surface in dev's typecheck — the accepted cost
of source-direct consumption (vs. a declaration build or a hand-maintained shim).

## Consequences

- We control the substrate; substrate fixes ship by bumping the submodule pointer.
- CI must check out submodules: every workflow that runs `pnpm install`
  (`red-release`, `red-memory-drift-guard`, `red-memory-bench`) sets
  `actions/checkout` `submodules: recursive`, else the `workspace:*` dep can't resolve.
- A fresh clone needs `git submodule update --init`. `pnpm install` pulls
  red-castle's `effect`/effect-platform tree (install weight; bundle weight is
  comparable to the old inlined `dist`). `protobufjs` (via the unused `@daytona/sdk`)
  is marked no-build in `pnpm-workspace.yaml`.
- red-castle's own test/typecheck suites do **not** gate red-skills CI.

## Status

accepted.

## Related

- ADR 0033 — AFK execution substrate (this refines it: same seam, our fork as source).
- ADR 0060 — root `apps/`+`packages/` layout (the submodule lands under `packages/`).
- ADR 0038/0039 — the dev runtime/entrypoints ship as fetched/bundled assets; the
  red-castle source is inlined into `dev.bundle.min.mjs` at build time, unchanged by this.
