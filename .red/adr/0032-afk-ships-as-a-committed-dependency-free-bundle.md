# AFK ships as a committed, dependency-free bundle built outside the plugin tree

## Context

The AFK skill is being ported from ~9k lines of shell (`scripts/*.sh`) to a
typed TypeScript runtime. Two questions had to be answered before the port could
ship anything to clients:

1. **How does the built runtime reach the client?** The marketplace populates the
   installed plugin cache (`~/.claude/plugins/cache/red-skills/dev/<ver>/`) by a
   plain `git checkout` of the repo at the release SHA. Claude Code never runs a
   build or `npm install` on plugin install or `autoUpdate`.
2. **Where does the TypeScript source live?** While the source sat inside the
   skill directory (`skills/engineering/afk/{src,tests,…}`), an operating agent
   browsing the skill was tempted to *read the implementation* (TS and shell)
   instead of *running the skill* — the SKILL.md is the contract, the code is not
   meant to be read to operate `/afk`.

ADR 0029 already faced (1) for the Memory plugin and chose **release assets +
a client-side bootstrap**: esbuild bundles the CLI, the bundle is attached to the
GitHub Release, and a post-install bootstrap fetches it. That model exists because
Memory's runtime is heavy — it inlines the `@reddb-io/sdk` and needs a per-platform
native `red` binary that cannot sanely be committed. The same ADR documents the
**dist-noop trap**: because `plugins/memory/dist/` is gitignored, any installed copy
where the bootstrap has not run has no runtime, and the hooks silently no-op.

AFK is different in kind: its only runtime dependency is `zod`, it has **no native
binary**, and its bundle is tiny (single-digit KB to low tens of KB). It does not
need the release-asset/bootstrap machinery, and paying the dist-noop trap for it
would be self-inflicted.

## Decision

**AFK ships as a single, committed, dependency-free bundle, built from source that
lives outside the plugin tree.**

1. **Source outside the plugin.** The TypeScript package lives at the repo root in
   `packages/afk/` — a sibling of `plugins/`, not under `plugins/dev/`. Because the
   marketplace copies `plugins/dev/` to the client cache, source kept outside that
   tree never ships and never appears in the skill directory an agent browses.

2. **One committed bundle as the shipping artifact.** `pnpm --filter @reddb/afk
   bundle` runs esbuild (`--bundle --platform=node --format=esm --target=node22`,
   `zod` inlined) and writes a **single file** to
   `plugins/dev/skills/engineering/afk/bin/afk.mjs`. That file **is committed to
   git**, so it ships verbatim in the plugin cache and runs on the client with a
   bare `node bin/afk.mjs <cmd>` — no `node_modules`, no install, no bootstrap, no
   network. This deliberately diverges from ADR 0029: AFK trades a slightly larger
   git footprint (one small text artifact, rebuilt per release) for the complete
   elimination of the dist-noop trap.

3. **The bundle is the entrypoint; shell is delegated mechanism during migration.**
   `bin/afk.mjs` runs natively where a typed implementation exists and otherwise
   delegates to the legacy `scripts/*.sh` orchestrator (`runLegacy`). The bundle
   resolves its sibling `scripts/` directory by walking up from its own module path,
   so the committed location is self-locating. As each shell module is ported, its
   `.sh` file is deleted and the dir shrinks toward the end state: SKILL.md +
   reference `*.md` + `bin/afk.mjs`, with no readable implementation left in the
   skill directory.

4. **Release rebuilds and commits the bundle.** `red-release.yml` rebuilds
   `bin/afk.mjs` from `packages/afk/` and includes it in the version-bump commit, so
   the shipped bundle is always byte-for-byte the build of the released source. The
   bundle is never hand-edited; `bin/` carries a README saying so.

## Consequences

- **No client bootstrap, no dist-noop trap.** The runtime is present in every
  installed copy the moment the cache is populated. This is the property Memory
  lacks and the reason AFK does not copy its model.
- **`node` is assumed on the client.** Same assumption Memory already makes; the
  marketplace audience runs Node-based agents. AFK adds no native binary, so this
  is the only new runtime requirement versus the shell implementation (which needed
  `bash`/`jq`/`gh`/`git`).
- **Committed build output churns git.** One small bundle changes on each release.
  Accepted: it is a single bundled file, diffable, and regenerated deterministically
  by CI — not the multi-file `dist/` tree that the accidental snapshot once
  committed.
- **Agent behaviour.** With source out of the skill dir and a "run, don't read"
  banner at the top of SKILL.md, the operating agent is steered to invoke the
  bundle rather than read implementation. The payoff grows as shell modules are
  ported away.
- **Two runtimes during migration.** Until the port completes, both `bin/afk.mjs`
  and `scripts/*.sh` exist. The bundle is the single public entrypoint; the shell is
  private mechanism it calls. Ported modules must have a single source of truth — a
  module ported to TS has its shell counterpart removed, not left to drift.

## Status

**Superseded by ADR 0038.** This ADR's load-bearing premise — that the dev bundle
is "tiny (single-digit KB to low tens of KB)" — stopped holding once the shell→TS
port completed: the committed `bin/afk.mjs` grew to ~2.6 MB and, rebuilt per
release, became the dominant source of git-history bloat. ADR 0038 flips the dev
runtime to the ADR 0034 fetched-asset model (the fetch path and SessionStart
pre-warm that did not exist when this ADR was written now do), replacing the
committed bundle with a small hand-written launcher.

## Related

- ADR 0038 — dev runtime ships as a fetched Release asset, not a committed bundle
  (supersedes this ADR).
- ADR 0029 — Memory runtime ships as a bundled asset fetched by a bootstrap (the
  model AFK deliberately diverged from here, and the source of the dist-noop trap
  this ADR avoided).
- ADR 0003 — runner adapters are explicitly per-runner (the `runner-*.md` split the
  TS `runner-detection` module mirrors).
