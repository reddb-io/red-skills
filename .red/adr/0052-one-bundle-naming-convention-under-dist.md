# ADR 0052 — One bundle-naming convention, all release assets under `./dist/`

## Status

accepted. Supersedes the transitional dual-output state described in ADR 0029 (legacy `dist-bundle/*-cli.mjs`) for memory and brain. Aligns memory/brain with the ADR 0034/0038 single-bundle model the dev and code-nav apps already use.

## Context

The release shipped two parallel, inconsistent artifact shapes:

- **dev, code-nav, benchmark-\*** → a single minified bundle in `./dist/`: `<app>.bundle.min.mjs` + `<app>.manifest.json`.
- **memory, brain** → a non-minified pair under `src/apps/<app>/dist-bundle/`: `<app>-cli.mjs` + `<app>-mcp.mjs`, plus `<app>-runtime-manifest.json` written next to the package.

The memory/brain build *already* produced the clean `dist/<app>.bundle.min.mjs` + `dist/<app>-mcp.bundle.min.mjs` via `pnpm bundle` — but the release ran `pnpm bundle:legacy` and shipped the `dist-bundle/*-cli.mjs` artifacts instead, leaving the clean bundles built and discarded. The result was incoherent: a `dist-bundle/` directory that shouldn't exist, non-minified 1.8 MB CLIs named `*-cli.mjs` (no `.bundle.min`), manifests outside `dist/`, and two naming schemes for the same concept.

This was a half-finished migration (ADR 0029 → 0034): nobody removed the legacy half after adding the canonical one.

## Decision

One convention. Every release asset lives under `./dist/` and follows `<app>[-<role>].bundle.min.mjs`:

- Single-entrypoint apps (dev, code-nav, benchmark-\*): `dist/<app>.bundle.min.mjs`.
- Multi-entrypoint apps (memory, brain): `dist/<app>.bundle.min.mjs` (the CLI, the primary role) + `dist/<app>-mcp.bundle.min.mjs` (the MCP server).
- The runtime manifest (which also pins the per-platform native `red` binary) stays a distinct, richer file — `dist/<app>-runtime-manifest.json` — because its schema differs from the single-checksum `<app>.manifest.json`. It now also lives under `./dist/`.

Concretely: drop the `bundle:legacy*` scripts from memory and brain; the release runs `pnpm bundle` and reads/uploads the `dist/` bundles; the runtime manifest's `cli.asset` / `mcp.asset` fields name the `dist/` bundles.

The plugin bootstraps are unaffected at the fetch layer: they read the asset names **from the version-pinned manifest**, so the rename follows automatically and every released version stays internally self-consistent (an old launcher + old tag resolves old names; a new launcher + new tag resolves new names — no cross-version break). Only the dev-checkout *local fallback* path is repointed from `src/apps/<app>/dist-bundle/` to `./dist/`. The version-keyed runtime cache filenames (`<runtimeRoot>/<version>/memory-cli.mjs`) are internal and unchanged, so `memory-bridge.sh` keeps resolving them.

## Consequences

- The `dist-bundle/` directory disappears; one place (`./dist/`), one pattern.
- No coordinated-release hazard: the manifest is self-describing and version-pinned, so launchers and assets never have to ship in lockstep.
- **Verification gap:** a wrong asset name or path here is NOT caught by CI — it only surfaces on a real `/plugin` install of memory/brain (the bootstrap fetch). This change MUST be install-smoke-tested before it is relied upon.
- For **memory** this is interim: ADR 0041 migrates the memory plugin out to `red-memory`, at which point red-skills deletes the memory app entirely. Normalizing now keeps the shipping release coherent until that lands; it does not conflict (red-memory is a separate repo consumed via its own release).

Memory-NoIngest: ADR + build/release plumbing; no canonical domain claim.
