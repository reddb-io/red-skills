# @redskills/opencode-host

The **adapter layer** that emits `opencode.json` from a project's
`.red/config.yaml` and the ADR 0059 env-precedence rule. Slice 1 of the
opencode-as-host plan (ADR 0075): provider block only. Skills, hooks, MCP,
and agents land in slices 2-5.

## Why this exists

ADR 0059 already lets AFK pick a model for the opencode runner from
`plugins.dev.afk.models.opencode.*` in `.red/config.yaml` and the
`OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY` env-precedence
rule. This app materialises the same config for the **developer-facing
opencode TUI** — a user running `opencode .` on a reddb.io repo now sees
the same model AFK would have picked, registered against the same auth
env-var. No second configuration step.

ADR 0075 documents the contract. ADR 0059 Amendment 3 is the cross-link.

## What it does today (Slice 1)

- Reads `.red/config.yaml` and applies the ADR 0067 strict opt-in gate
  (`plugins.dev.enabled: true`); refuses to emit when the gate is closed.
- Picks the active provider by env precedence
  (`OPENAI_API_KEY` → `MINIMAX_API_KEY` → `OPENROUTER_API_KEY`), matching
  ADR 0059 Amendment 1 byte-for-byte.
- Reads the per-tier model table (`plugins.dev.afk.models.opencode.<tier>.
  model`, default tier `think`); falls back to the OpenRouter-shaped
  default for back-compat with the AFK-only era.
- Emits `opencode.json` with the three provider entries registered and
  the active one ordered first, and **does not** embed the API key (auth
  stays in `~/.local/share/opencode/auth.json` + env).

## CLI

```bash
# Local-dev path (no install)
pnpm --filter @redskills/opencode-host generate
pnpm --filter @redskills/opencode-host generate -- --config ./redskills.yaml --out ./opencode.json
pnpm --filter @redskills/opencode-host generate -- --print   # stdout, no file

# Bundled form (release-asset, GHA lane)
node ./dist/opencode-host.bundle.min.mjs --config .red/config.yaml --out ./opencode.json
```

Exit codes: `0` wrote/printed; `1` read/write failure or opt-in gate
closed; `2` usage error.

## What it does not do (Slices 2-5)

- Skills → custom tools (`apps/opencode-host/src/skills-to-tools.ts`,
  Slice 2). Each `SKILL.md` becomes a `tool({ description, args, execute })`
  registered in a `.opencode/plugins/*.ts` module.
- Hooks → plugin events (`apps/opencode-host/src/hooks-to-events.ts`,
  Slice 2). `SessionStart`/`PreToolUse` from `claude.hooks.json` map to
  `tool.execute.before` / `config` events; `${CODEX_PLUGIN_ROOT}` env
  vars are rewritten to `OPENCODE_PLUGIN_DIR`.
- MCP passthrough (`apps/opencode-host/src/mcp-passthrough.ts`, Slice 3).
  `.mcp.json` flows into the `mcp>` block of `opencode.json`.
- Agents → subagents (`apps/opencode-host/src/agents-to-subagents.ts`,
  Slice 3). `plugins/dev/agents/*.md` become entries in the `agent>`
  block.
- Marketplace install (`Slice 5`). A standalone `link-skills.ts opencode`
  command + a downloadable release-asset form so `opencode --plugin
  <url>` works without a git clone.

## Testing

```bash
pnpm --filter @redskills/opencode-host test       # 27 tests, ~8s
pnpm --filter @redskills/opencode-host typecheck  # tsc strict
pnpm --filter @redskills/opencode-host bundle    # emits dist/opencode-host.bundle.min.mjs
```

The pure module (`provider-block.ts`) is unit-tested in isolation; the
CLI smoke (`generate-cli.test.ts`) spawns the real entrypoint through
`tsx` and exercises the file-IO contract, the opt-in gate, the precedence
pick, and the auth-leak guard.

## Related

- **ADR 0075** — the decision; introduces this app.
- **ADR 0059 Amendment 3** — cross-link; env-precedence + `<provider>/<model>` slug now also drive the host-side `provider>` block.
- **ADR 0067** — strict opt-in gate; the generator checks `plugins.dev.enabled: true` before writing.
- **ADR 0034** — `apps/<plugin>/` layout; this app is `apps/opencode-host/`.
- **ADR 0060** — root-level `apps/` + `packages/` with pnpm `catalog:`; followed here.
- **ADR 0038** — runtime ships as a fetched Release asset; the bundled form follows that shape.
