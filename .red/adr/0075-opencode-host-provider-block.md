# OpenCode provider block is the canonical shape that hosts the AFK opencode runner on a developer machine

## Status

accepted. Refines ADR 0059 (Amendment 3); introduces the `opencode-host` app as
the **adapter layer** between RedSkills' canonical model config and opencode's
native `opencode.json` `provider>` block.

## Context

ADR 0059 already established that:

- AFK ships an `opencode` runner that reaches any OpenAI-compatible endpoint
  through OpenCode's own `<provider>/<model>` slug (Amendment 1, endpoint-
  agnostic).
- The auth env-var is selected by first-set precedence:
  `OPENAI_API_KEY` → `MINIMAX_API_KEY` → `OPENROUTER_API_KEY` (Amendment 1).
- A user with no key set is fail-closed: the agent is spawned without an auth
  `env` block and OpenCode surfaces its own auth error.

ADR 0059 covers **AFK** running an inner agent headless. The companion surface
— a developer who *types* into opencode interactively while the same project
is open — is unwritten. Today, a user running `opencode .` on a reddb.io repo
sees opencode's default model picker. The `<provider>/<model>` slug the user
chose for the AFK inner agent (and the env precedence that decides which key
is read) is **not** translated into the `opencode.json` the opencode TUI reads
on startup. The same `.red/config.yaml` writes are interpreted by one process
(AFK) and ignored by the other (opencode host), so the two surfaces drift
when the user pins a different model per project.

The fix is a thin adapter that:

1. reads `.red/config.yaml` (`plugins.dev.afk.models.opencode.*` per tier, the
   AFK model table),
2. applies the ADR 0059 env-precedence rule to **also** pick the auth block
   written into opencode's `auth.json` and the `provider.<id>.env` entries in
   `opencode.json`,
3. emits a single, version-pinned `opencode.json` that the opencode TUI loads
   on startup.

This is the Slice 1 deliverable: **provider block only**, no skills, no hooks,
no MCP, no agents. Slices 2-5 (per the `to-issues` plan) layer the rest of
the adapter.

## Decision

### 1. The `opencode-host` app is the adapter

A new app, `apps/opencode-host/`, emits `opencode.json` (and a `package.json`
+ `.opencode/plugins/*.ts` family in later slices). It is the **only**
producer of the opencode-native config files for any project that has opted
into the `dev` plugin under `.red/config.yaml`. Hand-authoring an
`opencode.json` that overlaps is **out of scope**: the file is generated, the
generator is the source of truth.

### 2. The `provider>` block is the Slice 1 surface

The generator emits, at minimum:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "openrouter": { "npm": "@openrouter/ai-sdk-provider", "name": "OpenRouter" },
    "minimax":    { "npm": "@ai-sdk/openai-compatible",
                    "name": "MiniMax",
                    "options": { "baseURL": "https://api.minimax.chat/v1" } },
    "openai":     { "npm": "@ai-sdk/openai", "name": "OpenAI" }
  },
  "model": "openrouter/anthropic/claude-3.5-sonnet"
}
```

- **`provider` entries** — the three endpoints AFK supports today (OpenRouter,
  MiniMax, OpenAI). The npm package is the one opencode itself uses for each
  (verified against the opencode Providers doc, June 2026). Adding a new
  endpoint is a single entry in `provider-block.ts` plus, if needed, a
  precedence slot in the env table.
- **`model`** — the slug AFK uses for the `think` tier by default, in the
  `<provider>/<model>` shape opencode dispatches on. Operators override per
  project via `plugins.dev.afk.models.opencode.think.model` in
  `.red/config.yaml`; the generator reads that key first, falling back to the
  OpenRouter-shaped default for back-compat with the AFK-only era.

### 3. Auth is **not** written into `opencode.json`

The generator does **not** write the API key into `opencode.json` — the file
must be safe to commit in public repos. Auth stays in two places, both
sourced from environment:

- `opencode auth.json` (`~/.local/share/opencode/auth.json`), populated by
  the opencode `/connect` command at first use. OpenCode loads it before
  reading the `provider>` block.
- The shell env at startup, which opencode also reads (`OPENAI_API_KEY`,
  `MINIMAX_API_KEY`, `OPENROUTER_API_KEY`). The user already sets these for
  AFK; the host reads the same env, no second export.

The env-precedence rule from ADR 0059 is re-applied by the generator at
**build time** to decide which provider entry gets the `enabled` hint (the
provider whose key is set in the env is the one opencode should present as
the default; the others stay registered so the user can switch from the
`/models` picker).

### 4. Defaults stay OpenRouter-shaped

Back-compat with the #626 AFK contract: a project with only
`OPENROUTER_API_KEY` set and no per-tier override gets the same
`openrouter/anthropic/claude-3.5-sonnet` model the AFK runner would have
picked. The generator does not introduce a new default that diverges from
the AFK default for the same config.

### 5. Generator entrypoint is `tsx`-runnable, not bundled

`apps/opencode-host/src/generate.ts` is the user-facing CLI:
`pnpm --filter @redskills/opencode-host generate`. It reads
`./.red/config.yaml` (or `--config <path>`), the process env, and writes
`./opencode.json` (or `--out <path>`). No bundling step is required: the
generator is a build-time tool, not a runtime artifact, and lives at the
repo root of any consumer.

A bundled `dist/opencode-host.bundle.min.mjs` is still emitted so the
generator can run inside the GHA lane the same way other RedSkills bundles
do (release-asset, dynamically fetched, version-pinned per ADR 0038/0040).
The tsx path is for local development; the bundle is the ship path.

### 6. The `provider-block.ts` module is the only file that knows the shape

Skills-to-tools, hooks-to-events, MCP-passthrough, and agents-to-subagents
are slices 2+; the provider block is intentionally isolated. Anything opencode-
shape-specific lives in `apps/opencode-host/src/provider-block.ts` and
nothing else. The downstream slices import its `ProviderEntry` type and
nothing more.

## Considered options

- **Hand-author `opencode.json` per project** — rejected: a second source of
  truth for the same model/auth config that already lives in
  `.red/config.yaml` and the process env (ADR 0042 unified config). Drift
  would be silent: changing `plugins.dev.afk.models.opencode.think.model` in
  YAML would not update the user's opencode TUI, and the two surfaces would
  disagree on the next `/models` invocation.
- **Write the API key into `opencode.json`** — rejected: `opencode.json` is
  committed to public repos in the wild; embedding a key is a credential leak
  in waiting. Auth stays in `auth.json` + env, as opencode designed.
- **A new RedSkills-owned `provider.<id>.env` block** — rejected: redundant
  with opencode's own `auth.json`/env reading; adds a new config key for the
  same fact (ADR 0042 unified config: one place, not two).
- **Bundle the generator as a RedSkills release asset from day one** —
  rejected for Slice 1: the tsx path is enough for the local-dev story, and
  adding the GHA `bundled-asset fetched` lane is the same shape as AFK's
  fetch model (ADR 0038), but deferring it keeps the first slice shippable
  with the existing release pipeline untouched. The `bundle` script is
  present from Slice 1 so the second slice can flip the default without a
  build-system change.
- **Generate `opencode.json` from the AFK build instead of as a standalone
  app** — rejected: the AFK build is a **runtime** bundle (`dist/dev.bundle.
  min.mjs`) that runs inside sandcastle. A build-time config generator does
  not belong inside the runtime it configures; cross-cutting the two apps
  would entangle them. Keeping `opencode-host` as a separate app follows
  ADR 0034 (one bundle per app, one source per entrypoint).

## Consequences

- A user with `OPENROUTER_API_KEY` set and no per-project model override
  runs `opencode .` and sees Claude 3.5 Sonnet via OpenRouter — the same
  model the AFK inner agent would pick. The two surfaces agree.
- A user with `MINIMAX_API_KEY` set and
  `plugins.dev.afk.models.opencode.think.model: minimax/MiniMax-M3` in
  `.red/config.yaml` gets MiniMax M3 in both surfaces. No second
  configuration step.
- The `opencode-host` app carries no AFK runtime code; it is the
  configuration adapter only. The AFK inner agent continues to live in
  `apps/dev/` and is independent of the opencode host.
- Slices 2-5 (skills, hooks, MCP, agents) extend `opencode-host` but do not
  change Slice 1's `provider-block.ts` contract. A user who only wants the
  provider block can install the Slice 1 build and ignore the rest.
- A new endpoint (e.g. `groq`, `cerebras`) is a single entry in
  `provider-block.ts` plus, if env precedence is to honor it, a new
  precedence slot. No ADR amendment is required for an additive endpoint.
- Adding a new env-precedence slot — or re-ordering the existing one — is
  an **ADR amendment** to 0059 (it changes the documented auth surface),
  not a code-only change. The current order (`OPENAI > MINIMAX > OPENROUTER`)
  is locked.
- The generator is fail-closed: missing `.red/config.yaml`, missing `dev`
  plugin block, or malformed YAML → exit non-zero with a clear error
  (matches the AFK launcher's "fail loud" pattern, ADR 0038).

## Status

Accepted. Implements the Slice 1 deliverable of the broader opencode-host
plan (skill-to-tool, hook-to-event, MCP-passthrough, agent-to-subagent,
marketplace). Refines ADR 0059 with Amendment 3 (provider block surface).
Does not modify ADR 0059's runner-level semantics — the AFK inner agent
behaviour is unchanged.

## Related

- **0059** — opencode is the third AFK runner (Amendment 1: endpoint-agnostic
  provider; Amendment 3 — *this ADR* — adds the host-side provider block).
- **0034** — monorepo `apps/<plugin>` + per-plugin bundles; this ADR adds
  `apps/opencode-host` as the **config-adapter** plugin (not a runtime; its
  bundle is a build-time tool, not a shipped skill).
- **0038** — runtime ships as a fetched Release asset; the `opencode-host`
  bundle will follow the same shape in a future slice.
- **0039** — plugin entrypoints share one source; the opencode-host generator
  will adopt the same entrypoint with a new `__ENTRYPOINT_ROLE__` define
  (`generate`) when its bundled-asset form lands.
- **0040** — version is a single source; `opencode-host` reads from
  `@reddb-io/build-info` and the generator embeds the version in the
  emitted file's `// generated by @redskills/opencode-host <version>` comment.
- **0042** — plugin config is unified under `.red/config.yaml`; this ADR
  extends (does not fork) that contract by adding a new consumer
  (`opencode-host`) of the same `plugins.dev.afk.models.opencode.*` block.
- **0060** — root-level `apps/` + `packages/` layout with pnpm `catalog:`;
  `opencode-host` follows the same layout from day one.
- **0067** — per-directory plugin activation gate; the `opencode-host`
  generator is gated by the same `plugins.dev.enabled: true` check before
  writing anything.
