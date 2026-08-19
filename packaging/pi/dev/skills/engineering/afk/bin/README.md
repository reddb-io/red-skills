# `bin/` — AFK launcher entrypoint

`afk.mjs` is a small, **dependency-free launcher** — NOT the AFK implementation and
NOT the runtime bundle. Do not read it to understand `/afk`; the behavioural
contract is `../SKILL.md`.

**Nothing instructs this launcher any more.** ADR 0147 rule 1 makes `redskilled`
the only shipped binary of the execution chain, so no skill, README or hook doc
gives a line that runs `afk.mjs`; a workflow verb is an `rs_dev` tool. The file
stays because the packaged host hooks still resolve through it, and this README
describes what it is rather than how to call it.

The dev runtime itself is a single esbuild bundle that ships as a **GitHub Release
asset** (ADR 0038), fetched into a version-keyed cache by the SessionStart hook —
it is **not committed to git**. The launcher resolves that bundle and forwards its
whole argv to it, in this order:

1. version-keyed cache — `~/.cache/red-skills/bundles/dev-<version>.bundle.min.mjs`
2. repo-root `dist/dev.bundle.min.mjs` (local development)
3. cold cache → fetches the Release asset once, then re-checks

`afk.mjs` is **generated**, not hand-edited: it is built from the shared
`packages/shared/entrypoint-cli.ts` with the `run:dev` role — the same source the
fetcher `plugins/dev/hooks/red-fetch.mjs` is built from with the `fetch` role
(ADR 0039). Both are tiny (~6 KB), versionless, and deterministic.

Build the runtime bundle locally (the launcher needs no separate build):

```bash
pnpm -C apps/dev install
pnpm -C apps/dev run bundle   # writes ../../dist/dev.bundle.min.mjs
```

See ADR 0039 (one entrypoint source, two roles), ADR 0038 (fetched asset, supersedes
the committed-bundle decision in ADR 0032), and ADR 0034.
