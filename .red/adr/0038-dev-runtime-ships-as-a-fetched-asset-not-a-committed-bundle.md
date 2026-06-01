# The dev runtime ships as a fetched Release asset, not a committed bundle

## Context

ADR 0032 decided that AFK (the dev runtime) ships as a **single committed,
dependency-free esbuild bundle** at `plugins/dev/skills/engineering/afk/bin/afk.mjs`,
deliberately diverging from the Memory bootstrap model (ADR 0029) to avoid the
"dist-noop trap". Its load-bearing premise was explicit (ADR 0032 §Context):

> AFK is different in kind: its only runtime dependency is `zod` … and its bundle
> is **tiny (single-digit KB to low tens of KB)**.

That premise is now false. The committed `bin/afk.mjs` has grown to **~2.6 MB** as
the shell→TS port completed and `@ai-hero/sandcastle` plus the full state-machine
runtime were inlined. Because the release workflow rebuilds and re-commits it on
**every** version bump, the repository now carries dozens of ~2.6 MB blobs in
history — `.git` reached 67 MB, with this bundle the dominant contributor. The
"slightly larger git footprint" ADR 0032 accepted became the single largest source
of repo bloat.

Meanwhile the infrastructure ADR 0032 lacked now exists and is proven in
production by a sibling domain:

- **ADR 0034** generalised the Memory bootstrap into a per-plugin dynamic-fetch
  mechanism: every domain builds to `<plugin>.bundle.min.mjs`, attached to the
  GitHub Release as an asset with a `<plugin>.manifest.json` sha256.
- `src/packages/shared/bundle-fetch.ts` (pure, unit-tested) + the committed,
  dependency-free `red-fetch.mjs` launcher resolve and verify a bundle into a
  version-keyed cache (`~/.cache/red-skills/bundles/<plugin>-<version>.bundle.min.mjs`).
- The dev plugin's **SessionStart hook already runs `red-fetch dev <version>`**,
  pre-warming that cache every session.
- The release **already builds and uploads `dist/dev.bundle.min.mjs` +
  `dist/dev.manifest.json`** as assets.
- **code-nav already completed this exact migration** — it ships no committed
  bundle; its `.mcp.json` resolves the cached/dist bundle and `exec node`s it.

The committed `bin/afk.mjs` was, in the release workflow's own words, the
**"transition"** artifact: everything needed to fetch the dev bundle was in place
except the entrypoint, which still *was* the 2.6 MB bundle instead of resolving it.

> **Refined by ADR 0039.** This ADR introduced `bin/afk.mjs` as a *hand-written*
> launcher. ADR 0039 then unified it with `red-fetch.mjs` into one source
> (`entrypoint-cli.ts`) selected by a build role, so `bin/afk.mjs` is again a
> deterministic build output (~6 KB, versionless) that the release stages — the
> "hand-written, build never touches it" wording below is superseded. The
> fetched-asset decision itself stands unchanged.

## Decision

**The dev runtime ships as a fetched Release asset; the committed entrypoint is a
small launcher, not the bundle.** This completes the ADR 0034 migration for the dev
domain and supersedes ADR 0032.

1. **`bin/afk.mjs` becomes a ~3 KB hand-written launcher** (node built-ins only).
   It resolves the dev runtime bundle and delegates (`node bin/afk.mjs <cmd>` →
   `node <resolved bundle> <cmd>`), in order:
   1. version-keyed cache — `<cacheRoot>/dev-<version>.bundle.min.mjs` (the fast
      path; no network when the SessionStart hook already warmed it);
   2. repo-root `dist/dev.bundle.min.mjs` (local development);
   3. cold cache → run `red-fetch dev <version>` once (best-effort), then re-check.
   It reads `<version>` from the plugin's `.claude-plugin/plugin.json` and mirrors
   the cache path/name from `bundle-fetch.ts` and `fetch-cli.ts`. If nothing
   resolves it fails loudly with an actionable message (AFK is interactive — unlike
   Memory's hooks, it must not silently no-op).

2. **The launcher is committed; the 2.6 MB bundle is not.** `dev.bundle.min.mjs`
   lives only as a Release asset (ADR 0034) and in the per-version cache. All
   existing call sites (`SKILL.md`, statusline hooks) invoke `node bin/afk.mjs`
   unchanged — only the file's *content* shrinks from 2.6 MB to a launcher.

3. **`build` no longer emits a committed bundle.** `src/apps/dev` drops the
   `bundle:bin` script; `build` = `bundle` (→ `dist/dev.bundle.min.mjs`) +
   `bundle:red-fetch` (→ committed `red-fetch.mjs`). The release workflow stops
   staging/committing `bin/afk.mjs`; it still rebuilds+stages `red-fetch.mjs` (the
   one fetcher that cannot fetch itself) and uploads the bundle + manifest assets.

## Why

- **The premise that justified committing the bundle (tininess) no longer holds.**
  At 2.6 MB × every release it is the dominant git-history cost, exactly the
  footprint ADR 0032 judged acceptable only because it expected tens of KB.
- **The fetch path it deliberately avoided now exists, is tested, and is already
  warmed for dev on SessionStart** — the dist-noop trap that motivated ADR 0032 is
  mitigated by (a) the SessionStart pre-warm, (b) the launcher's own cold-cache
  fetch, and (c) a loud, actionable failure instead of a silent no-op.
- **code-nav is the working precedent** in the same repo and release pipeline.
- **Blast radius is minimal.** No invocation site changes; the launcher keeps the
  `node bin/afk.mjs <cmd>` contract byte-for-byte.

## Consequences

- New repo growth from dev-runtime releases stops: the per-release artifact is a
  manifest + an uploaded asset, not a committed 2.6 MB blob. (Purging the **existing**
  history bloat is a separate, coordinated `git filter-repo` task — out of scope here.)
- First `/afk` invocation after an install/upgrade with a cold cache and no
  SessionStart pre-warm pays a one-time fetch (~one network round-trip for a ~700 KB
  minified asset + manifest). Subsequent invocations resolve from cache with no
  network. Offline-without-cache fails loudly with build/network guidance.
- `node` is assumed on the client — unchanged from ADR 0032.
- The e2e smoke (`scripts/afk-e2e-smoke.sh`) and any direct `node bin/afk.mjs` use
  now require a resolvable bundle (cache or a local `pnpm -C src/apps/dev bundle`).

## Status

Accepted. Supersedes ADR 0032.

## Related

- ADR 0032 — AFK ships as a committed dependency-free bundle (superseded).
- ADR 0034 — monorepo src domains with per-plugin bundles + dynamic dist fetch.
- ADR 0029 — Memory runtime ships as a bundled asset fetched by a bootstrap.
