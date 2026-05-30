# `bin/` — generated AFK runtime bundle

`afk.mjs` is a **generated artifact** — a single dependency-free esbuild bundle of
the dev plugin's TypeScript implementation, which lives at `src/domains/dev/` in
the repo root (the `@reddb/dev` domain, ADR 0034). Do not edit it by hand and do
not read it to understand `/afk`; the behavioural contract is `../SKILL.md`.

Rebuild it from the dev domain:

```bash
pnpm -C src/domains/dev install
pnpm -C src/domains/dev run bundle:bin   # writes this directory's afk.mjs
```

It is committed (not gitignored) on purpose: it must ship verbatim in the plugin
cache so the client runs `node bin/afk.mjs <cmd>` with no install or bootstrap.
See ADR 0032 and ADR 0034.
