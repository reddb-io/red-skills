# Memory runtime ships as an esbuild bundle + `red` binary, fetched post-install by a dependency-free bootstrap

## Context

The Memory plugin's Claude lifecycle hooks (`SessionStart`, `PostToolUse` on
`Edit|Write`, `Stop`, `PreCompact` — see ADR 0027) invoke
`node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js hook <event>` with a best-effort
fallback to `printf "{}"`. `CLAUDE_PLUGIN_ROOT` resolves to the **installed
plugin cache** (`~/.claude/plugins/cache/red-skills/memory/<ver>/`), which the
marketplace populates by a plain `git checkout` of the repo at the release SHA.
Claude Code never runs a build or an install on plugin install or `autoUpdate`.

This breaks the hooks in every installed copy, for three stacked reasons:

1. **No `dist/`.** `plugins/memory/dist/` is gitignored, so no published version
   carries the compiled JS — the hook hits a missing file and no-ops.
2. **No JS dependencies.** The CLI is ESM (`"type": "module"`) and unbundled, so
   even with `dist/` present it imports `@reddb-io/sdk`, `zod`, `gray-matter`,
   `fast-glob`, and `@modelcontextprotocol/sdk` from `node_modules` (≈137 MB,
   gitignored, never shipped). Proven empirically: running the full `dist/` with
   no reachable `node_modules` crashes `ERR_MODULE_NOT_FOUND: zod`, which the
   hook's `|| printf "{}"` swallows into a silent no-op.
3. **No engine binary.** Memory connects with a `file://…/graph.rdb` URI, which
   puts the SDK in **embedded mode**: `connect()` resolves and spawns the native
   `red` binary (≈25 MB at `@reddb-io/sdk/bin/red`, fetched per-platform by the
   SDK's `postinstall.js` from GitHub Releases) over stdio JSON-RPC.

The graph (`.red/memory/graph.rdb`, 36 MB) only ever grew via manual
`/memory:ingest` runs or when the ancient 1.48.1 cache — the only one that
shipped `node_modules` — was active. The PRD #217 closed loop is
architecturally complete but operationally dead in installed copies.

Two delivery shapes were considered and rejected (see below): committing
`dist/` (PR #228) and running a package-manager install into the cache. Neither
can satisfy requirement 2 portably, and an install cannot be assumed (no
npm/pnpm on the hook's PATH; `autoUpdate` wipes anything installed into the
cache dir). A spike confirmed the viable shape:

- `esbuild src/cli.ts --bundle --platform=node --format=esm` produces a single
  **1.9 MB, platform-independent** `cli.mjs` with all JS dependencies inlined,
  in ~100 ms.
- The bundle runs **standalone with no `node_modules`** (help, parsing, all
  bundled deps resolve internally).
- An engine-touching command fails at exactly the right boundary —
  `reddb: binary "red" not found … override: set REDDB_BIN=/path/to/red` — not
  at module resolution. The SDK's binary lookup order is `REDDB_BIN` env →
  `<pkg>/bin/red`, so `import.meta.resolve("@reddb-io/sdk")` never fires when
  `REDDB_BIN` is set. **No source refactor is required.**

## Decision

The Memory runtime is delivered as **two fetched artifacts**, never as committed
build output and never via an install on the user's machine:

1. **`cli.mjs`** — a single esbuild bundle (all JS deps inlined), produced in
   `red-release.yml` and uploaded as a **GitHub Release asset**. Platform-
   independent.
2. **`red-<platform>-<arch>`** — the native engine binary, published as a
   per-platform Release asset (or referenced from `reddb-io/reddb` releases).

A **dependency-free `bootstrap.js`** (only `node:` builtins — `fetch`, `node:fs`,
`node:crypto`) is committed in the plugin and is what the hooks invoke. On each
hook it ensures the runtime for the plugin's version exists, then delegates:

- Target a **version-keyed cache outside the volatile plugin dir** —
  `~/.cache/reddb-memory/<version>/{cli.mjs,red}` — so it survives `autoUpdate`
  and is only re-fetched when the version actually changes.
- If an artifact is missing or its **checksum** (published in the Release /
  pinned in the bootstrap) does not match, download it; otherwise skip.
- Export `REDDB_BIN=~/.cache/reddb-memory/<version>/red` and invoke
  `node ~/.cache/reddb-memory/<version>/cli.mjs hook <event> …`.
- On any bootstrap failure (offline, 404, checksum mismatch), **write an
  actionable line to `~/.cache/reddb-memory/bootstrap.log`** and degrade to the
  existing no-op. Failure must be diagnosable, never silent.

`red-release.yml` must **upload the assets within the same job, before the
Release is published**, so a peer's `autoUpdate` can never observe a new plugin
version whose assets are still in flight.

`plugins/memory/dist/` stays gitignored and uncommitted; the build step is a
release-time concern only. The runtime that actually executes is always the
bundle, never `dist/` or `node_modules`.

## Why

- **A bundle is the only portable way to satisfy "no install."** `node` is
  assumed on the hook PATH; a package manager is not. esbuild inlining removes
  the entire `node_modules` requirement for the JS half, proven at 1.9 MB.
- **The `red` binary is irreducibly per-platform**, so it cannot be a single
  committed artifact and must be fetched — the same mechanism the SDK's
  postinstall already implements. Folding it into the bootstrap means one
  fetch step owns both artifacts.
- **A version-keyed cache outside `${CLAUDE_PLUGIN_ROOT}` is what makes this
  survive `autoUpdate`.** Anything written into the cache dir is wiped on the
  next refresh; `~/.cache/reddb-memory/<ver>/` is not, and the version key makes
  re-download happen exactly once per version bump.
- **Checksum + a bootstrap log** close the two failure modes that the current
  design hides: tampered/corrupt payloads, and silent no-ops that look like
  "memory is working" when it is not.

## Rejected alternatives

- **Commit `dist/` (PR #228).** Necessary-looking but insufficient: it ships the
  JS files but not the 137 MB of deps they import, so the hooks still crash at
  `ERR_MODULE_NOT_FOUND`. Superseded by this ADR; PR #228 is closed without
  merge.
- **Package-manager install into the cache (`pnpm install --prod`).** Assumes a
  package manager on PATH, needs network + possible native builds, and lands in
  the cache dir that `autoUpdate` wipes — so it must re-run every update. The
  bundle needs none of that for the JS half.
- **Commit the bundle instead of downloading it.** Viable (it is only 1.9 MB)
  and gives offline JS, but the hooks all need the `red` binary anyway — which
  needs network on first run regardless — so committing buys little offline
  benefit while adding build-artifact churn to git. The `red` fetch path already
  exists, so the JS bundle rides it.
- **Node SEA / native single-executable.** Still requires a bundler to produce
  the JS blob first, the output is a per-platform binary (reintroducing the
  problem this ADR removes), and it is experimental. Node's native TypeScript
  support removes only the `tsc` step, not the dependency-inlining need — it is
  not a bundler.
- **Rewrite Memory in Rust embedding the `red` crate.** A ~54 k-LOC, 39-subcommand
  + MCP-server port whose payoff is packaging and in-process embedding, not
  function. It does not eliminate the per-platform binary fetch (a Rust binary is
  still per-platform). Out of scope as a fix; revisit only as a separate
  strategic bet, gated on whether `reddb` exposes a usable library crate.

## Consequences

- The hook command in `hooks/claude.hooks.json` (and the Codex equivalent)
  changes from `node ${CLAUDE_PLUGIN_ROOT}/dist/cli.js …` to invoking the
  committed `bootstrap.js`, which resolves/fetches the versioned runtime and
  delegates.
- `red-release.yml` gains an esbuild bundle step, asset upload (bundle +
  per-platform `red`), and published checksums; assets upload before the Release
  is marked published.
- First session after an install or version bump pays a one-time download
  (~1.9 MB bundle + ~25 MB binary); subsequent sessions resolve from
  `~/.cache/reddb-memory/<ver>/` with no network.
- Offline first-run degrades to the documented no-op with a `bootstrap.log`
  entry — strictly better than today's silent failure.
- `vcs-commit.ts::resolveRedBinary()` **did** require a one-line fix (caught by
  an end-to-end bootstrap run, not the spike): it fell back to
  `import.meta.resolve("@reddb-io/sdk")`, which throws in the bundle (no
  node_modules). It now honours `REDDB_BIN` first — the path the bootstrap sets
  and the SDK's canonical override (SDK ADR 0006) — so the resolve never fires
  in the shipped path. Lesson: validate the bundle by actually running a hook
  end-to-end against the published release, not just `--help`.
- This is the operational-delivery half of ADR 0027 / PRD #217: with it, hooks
  fire the CLI in installed copies for the first time.
