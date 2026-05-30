# `bin/` — generated AFK runtime bundle

`afk.mjs` is a **generated artifact** — a single dependency-free esbuild bundle of
the TypeScript source at the repo root `packages/afk/`. Do not edit it by hand and
do not read it to understand `/afk`; the behavioural contract is `../SKILL.md`.

Rebuild it from the source package:

```bash
pnpm --filter @reddb/afk install
pnpm --filter @reddb/afk bundle   # writes this directory's afk.mjs
```

It is committed (not gitignored) on purpose: it must ship verbatim in the plugin
cache so the client runs `node bin/afk.mjs <cmd>` with no install or bootstrap.
See ADR 0032.
