# `bin/` — AFK launcher bootstrap

`afk.mjs` is a small, **hand-written, dependency-free launcher** — NOT the AFK
implementation and NOT a generated bundle. Do not read it to understand `/afk`;
the behavioural contract is `../SKILL.md`.

The dev runtime itself is a single esbuild bundle (`dev.bundle.min.mjs`) that ships
as a **GitHub Release asset** (ADR 0034), fetched into a version-keyed cache by
`red-fetch` on SessionStart — it is **not committed to git**. This launcher resolves
that bundle and delegates to it (`node bin/afk.mjs <cmd>` → `node <resolved bundle> <cmd>`):

1. version-keyed cache — `~/.cache/red-skills/bundles/dev-<version>.bundle.min.mjs`
2. repo-root `dist/dev.bundle.min.mjs` (local development)
3. cold cache → triggers `red-fetch dev <version>` once, then re-checks

Build the runtime bundle locally (the launcher itself needs no build):

```bash
pnpm -C src/apps/dev install
pnpm -C src/apps/dev run bundle   # writes ../../../dist/dev.bundle.min.mjs
```

The launcher is committed (it must ship verbatim in the plugin cache so the client
runs it with no install); the 2.6 MB runtime bundle is not. See ADR 0038 (which
supersedes the committed-bundle decision in ADR 0032) and ADR 0034.
