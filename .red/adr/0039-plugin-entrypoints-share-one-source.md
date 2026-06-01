# Plugin entrypoints share one source, selected by a build role

## Context

ADR 0038 flipped the dev runtime to a fetched Release asset and replaced the
committed 2.6 MB `bin/afk.mjs` bundle with a small hand-written launcher. That left
the dev plugin with **two** committed, dependency-free `node:`-only programs that do
nearly the same job over the same core (`bundle-fetch.ts`):

- `plugins/dev/hooks/red-fetch.mjs` — built from `fetch-cli.ts`; **populates** the
  version-keyed bundle cache, best-effort, exits 0 (the SessionStart pre-warmer).
- `plugins/dev/skills/engineering/afk/bin/afk.mjs` — hand-written; **resolves**
  the bundle (cache → dist → fetch) and **execs** it, failing loud (the skill
  launcher).

Two implementations of "find this plugin's bundle and maybe run it" drift apart: the
hand-written launcher duplicated the cache-path and dist-resolution logic that
`fetch-cli.ts` and `bundle-fetch.ts` already owned. Worse, the pattern is repeated
across plugins — `code-nav` resolves its bundle with a bespoke shell snippet in
`.mcp.json`, `memory` has its own `bootstrap.mjs`. Three bespoke launchers, one job.

The launcher is also irreducible: the plugin cache is a bare `git checkout` (no
install, no build), so **something** committed must exist at the invoked path to
bootstrap the fetched runtime — it cannot itself be fetched. The question is not
*whether* to commit an entrypoint, but how many distinct ones to maintain.

## Decision

**One source — `src/packages/shared/entrypoint-cli.ts` — is the single entrypoint
for every per-plugin bundle. The build emits it to each committed path with a
`__ENTRYPOINT_ROLE__` esbuild define that selects behaviour.**

The entrypoint has two modes, reachable explicitly as subcommands and as a role
default:

- **`fetch <plugin> <version>`** — populate the cache, best-effort, exit 0. Built to
  `plugins/dev/hooks/red-fetch.mjs` with role `fetch`; the no-subcommand form keeps
  the legacy `red-fetch.mjs <plugin> <version>` SessionStart invocation working.
- **`run <plugin> [args…]`** — resolve `<plugin>`'s bundle (version-keyed cache →
  repo-root `dist/` → in-process fetch), then exec it forwarding args and exit code;
  fail loud if nothing resolves (interactive — no silent no-op). Built to
  `plugins/dev/skills/engineering/afk/bin/afk.mjs` with role `run:dev`; the
  no-subcommand form makes `node afk.mjs <cmd>` mean `run dev <cmd>`, so every
  existing SKILL.md / statusline call site is byte-for-byte unchanged.

Both committed outputs are tiny (~6 KB), carry **no version**, and are deterministic
esbuild output, so they only change in git when the source changes. `build` emits
the `dev.bundle.min.mjs` asset plus both entrypoints; the release stages both.

## Why

- **One implementation, not three.** Cache path, dist fallback, checksum, and exec
  semantics live once (in `entrypoint-cli.ts` over `bundle-fetch.ts`), not copied
  into a hand-written launcher and a shell snippet that drift.
- **A committed entrypoint is irreducible** (bare-checkout cache, no install), so the
  goal is to make it *generic and shared*, not to eliminate it.
- **Zero call-site churn.** Role defaults preserve the exact `red-fetch.mjs dev <v>`
  and `afk.mjs <cmd>` invocations external configs (settings.json statuslines,
  the SessionStart hook) already pin — so installed clients keep working.
- **Path coupling is why outputs stay separate files.** Installed statuslines and
  hooks reference fixed paths; collapsing to a single physical file would break them.
  Unifying the *source* captures the real win (one truth) without that breakage.

## Consequences

- `fetch-cli.ts` → renamed `entrypoint-cli.ts`; gains a `run` mode and the pure,
  unit-tested `parseEntrypoint(argv, role)` router. `bin/afk.mjs` is no longer
  hand-written — it is a build output again (deterministic, ~6 KB, versionless), so
  ADR 0038's "build never touches it" no longer holds; the release stages it.
- New plugins (and eventually `code-nav` / `memory`) should adopt the same
  entrypoint with their own role define instead of a bespoke launcher — folding the
  remaining bespoke launchers in is follow-up work, not done here.
- The committed-file count is unchanged (two), but they are now the same program in
  two hats rather than two separate implementations.

## Status

Accepted. Refines ADR 0038 (which superseded ADR 0032).

## Related

- ADR 0038 — dev runtime ships as a fetched Release asset, not a committed bundle.
- ADR 0034 — monorepo src domains with per-plugin bundles + dynamic dist fetch.
- ADR 0029 — Memory runtime ships as a bundled asset fetched by a bootstrap.
