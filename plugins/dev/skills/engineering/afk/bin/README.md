# `bin/` — AFK launcher entrypoint

`afk.mjs` is a small, **dependency-free launcher** — NOT the AFK implementation and
NOT the runtime bundle. Do not read it to understand `/afk`; the behavioural
contract is `../SKILL.md`.

The dev runtime itself is a single esbuild bundle (`dev.bundle.min.mjs`) that ships
as a **GitHub Release asset** (ADR 0038), fetched into a version-keyed cache by the
SessionStart hook — it is **not committed to git**. This launcher resolves that
bundle and delegates (`node bin/afk.mjs <cmd>` → `node <resolved bundle> <cmd>`):

1. version-keyed cache — `~/.cache/red-skills/bundles/dev-<version>.bundle.min.mjs`
2. repo-root `dist/dev.bundle.min.mjs` (local development)
3. cold cache → fetches the Release asset once, then re-checks

`afk.mjs` is **generated**, not hand-edited: it is built from the shared
`src/packages/shared/entrypoint-cli.ts` with the `run:dev` role — the same source the
fetcher `plugins/dev/hooks/red-fetch.mjs` is built from with the `fetch` role
(ADR 0039). Both are tiny (~6 KB), versionless, and deterministic.

Build the runtime bundle locally (the launcher needs no separate build):

```bash
pnpm -C src/apps/dev install
pnpm -C src/apps/dev run bundle   # writes ../../../dist/dev.bundle.min.mjs
```

See ADR 0039 (one entrypoint source, two roles), ADR 0038 (fetched asset, supersedes
the committed-bundle decision in ADR 0032), and ADR 0034.
