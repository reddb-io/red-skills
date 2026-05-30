# Repo splits plugin DEFINITIONS from IMPLEMENTATION: `src/domains/{dev,memory}` + shared `src/`, one built bundle per plugin

## Context

The repo had grown two parallel, differently-organised implementations:

- **dev** — the AFK TypeScript runtime at `packages/afk/src/` (34 core modules,
  built to a committed `bin/afk.mjs`, ADR 0032).
- **memory** — `plugins/memory/src/` (151 TS files, `cli.ts` ~250 KB), built to a
  release-asset bundle `memory-cli.mjs` fetched by a bootstrap (ADR 0029).

Two problems:

1. **Implementation is tangled with definition.** Each plugin directory mixes the
   *definition* an agent consumes (`.claude-plugin/plugin.json`, `skills/*.md`,
   `agents/`, hooks) with the *implementation* (TS source, build config, tests). An
   operating agent browsing a skill is tempted to read the code instead of running
   it, and the two concerns version and ship together when they shouldn't.
2. **No shared layer.** dev and memory independently re-implement the same plumbing
   (CLI arg parsing, config loading, the esbuild bundle recipe + `createRequire`
   banner, a `handoff` notion, exec wrappers). There is nowhere for common code to
   live, and no consistent build/ship story across plugins.

## Decision

**Separate plugin *definition* from *implementation*, consolidate all implementation
under a top-level `src/`, and ship one built bundle per plugin.**

```
red-skills/
├── src/
│   ├── domains/
│   │   ├── dev/         ← the dev plugin's implementation (was packages/afk/src)
│   │   └── memory/      ← the memory plugin's implementation (was plugins/memory/src)
│   ├── shared/          ← code common to ≥2 domains (config, handoff, exec, bundle
│   │                       recipe, cli-arg parsing) — local extractions and/or the
│   │                       author's published packages (e.g. `cli-args-parser`)
│   ├── dev.ts           ← entrypoint for the dev plugin → dev.bundle.min.mjs
│   └── memory.ts        ← entrypoint for the memory plugin → memory.bundle.min.mjs
├── plugins/
│   ├── dev/             ← DEFINITION ONLY: .claude-plugin/plugin.json, skills/*.md,
│   │                       agents/, hooks/ — no TS source, no build config
│   └── memory/          ← DEFINITION ONLY
└── dist/                ← built bundles, shipped as GitHub Release assets and
                           fetched dynamically (see below)
```

1. **`src/domains/<plugin>/`** holds each plugin's implementation. The dev domain is
   the former `packages/afk/src` (superseding ADR 0032's `packages/afk` location);
   the memory domain is the former `plugins/memory/src`.

2. **`src/shared/`** holds anything used by two or more domains. Extraction is
   demand-driven (extract when the second domain needs it, not speculatively). Where
   the author already ships a published package that fits (`cli-args-parser`, a TUI
   lib, env/secrets), prefer adopting it over a bespoke local copy.

3. **One entrypoint + one bundle per plugin.** `src/dev.ts` and `src/memory.ts` are
   the CLI entrypoints; each esbuild-bundles to a single minified
   `dev.bundle.min.mjs` / `memory.bundle.min.mjs`. The plugin's skills invoke *their*
   bundle (`node <bundle> <command>`), never the source.

4. **Definition vs implementation.** `plugins/<plugin>/` carries only what an agent
   consumes — the marketplace/plugin manifests, `skills/*.md`, `agents/`, hooks. No
   TS source lives under `plugins/`, so browsing a skill never surfaces
   implementation. The skill's `SKILL.md` documents the bundle command; the runtime
   is resolved (committed or fetched) separately.

5. **Dynamic dist fetch.** Both bundles ship as **GitHub Release assets**
   (`dev.bundle.min.mjs`, `memory.bundle.min.mjs`, each with a checksum manifest).
   A skill or a `SessionStart` hook resolves the bundle for the installed plugin
   version, fetching it from the release into a local cache when absent — the model
   ADR 0029 established for memory, now generalised to every plugin. This keeps the
   git tree free of large built artifacts while guaranteeing the runtime is present
   at first use.

## Consequences

- **Cleaner mental model + agent behaviour.** `plugins/` is the contract surface;
  `src/` is the build. An agent runs the bundle; it has no source in the skill dir to
  read.
- **A real shared layer.** Common plumbing lives once in `src/shared/`; adopting the
  author's published packages removes bespoke re-implementations.
- **Uniform build/ship.** Every plugin builds the same way (entrypoint → minified
  bundle) and ships the same way (release asset + dynamic fetch). Adding a third
  plugin is a new `src/domains/<x>` + `src/<x>.ts` + a `plugins/<x>/` definition.
- **Supersedes ADR 0032's location** (`packages/afk` → `src/domains/dev`) and the
  committed-`bin/afk.mjs` shipping detail (now a release asset like memory). The
  *bundle-is-the-runtime* and *source-outside-the-skill-dir* principles of 0032 are
  retained and generalised.
- **Migration cost is real.** Moving memory's 151 files + rewiring two builds, the
  release workflow, and every skill/hook invocation path is a multi-step migration;
  it proceeds domain-by-domain with each domain's tests kept green.
- **One transition risk: dynamic fetch availability.** A hook/skill that fetches from
  a release needs network + the release to exist. The fetch is best-effort with a
  clear error, and a committed fallback may be retained per plugin during transition.

## Status

Accepted; migrating incrementally (dev domain first — it has full test coverage).

## Related

- ADR 0032 — committed dependency-free bundle for AFK (location + shipping detail
  superseded; principles retained).
- ADR 0029 — memory runtime ships as a release-asset bundle fetched by a bootstrap
  (the dynamic-fetch model, now generalised to all plugins).
- ADR 0033 — AFK execution on sandcastle (unaffected; lives in `src/domains/dev`).
