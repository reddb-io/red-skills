# @redskills/opencode-host

The **adapter layer** that emits `opencode.json` + the opencode-native
dist tree (`opencode.json`, `.opencode/skills/<name>/SKILL.md`,
`.opencode/plugin/<event>.ts`) from a project's `.red/config.yaml` and
the ADR 0059 env-precedence rule. The same `plugins/<name>/` source tree
serves Claude Code, Codex, and OpenCode through this single generator.

## Slices

- **Slice 1 (ADR 0075)** — `opencode.json` `provider>` block. Active
  provider picked by env precedence
  `OPENAI_API_KEY > MINIMAX_API_KEY > OPENROUTER_API_KEY`; per-tier
  model table read from `plugins.dev.afk.models.opencode.<tier>.model`
  with the OpenRouter-shaped default as a back-compat fallback.
- **Slice 2 (ADR 0076 + 0077)** — `.opencode/skills/<name>/SKILL.md`
  (flat-symlinked) and `.opencode/plugin/<event>.ts` (one TS module per
  Claude/Codex event class).
- **Slice 3-5 (planned)** — MCP passthrough, agents → subagents, remote
  install.

## CLI

```bash
# Slice 1 only (default)
pnpm --filter @redskills/opencode-host generate
pnpm --filter @redskills/opencode-host generate -- --config ./redskills.yaml --out ./opencode.json
pnpm --filter @redskills/opencode-host generate -- --print          # stdout, no file

# Slice 1 + Slice 2 — emit the dist tree
pnpm --filter @redskills/opencode-host generate -- --with-slice-2
# default out-dir is ./dist/opencode; override with --out-dir

# Emit a single plugin
pnpm --filter @redskills/opencode-host generate -- --with-slice-2 --plugin dev

# Copy SKILL.md instead of symlinking (cross-filesystem safety)
pnpm --filter @redskills/opencode-host generate -- --with-slice-2 --copy

# Bundled form (release asset)
pnpm --filter @redskills/opencode-host bundle
node ./dist/opencode-host.bundle.min.mjs --with-slice-2 --plugins-root ./plugins
```

Exit codes: `0` wrote/printed; `1` read/write failure or opt-in gate
closed; `2` usage error.

## Output shape (Slice 1 + 2)

```
dist/opencode/
├── dev/
│   ├── opencode.json
│   └── .opencode/
│       ├── plugin/
│       │   ├── session-start.ts   ← SessionStart → config
│       │   └── pre-tool-use.ts    ← PreToolUse → tool.execute.before
│       └── skills/
│           ├── afk/SKILL.md       ← symlink → plugins/dev/.../afk/SKILL.md
│           ├── ship/SKILL.md
│           └── …
├── memory/
└── brain/
```

## Why

ADR 0059 already lets AFK pick a model for the opencode runner from
`plugins.dev.afk.models.opencode.*`. ADR 0075 materialises the same
config for the **developer-facing opencode TUI**. ADR 0076 + 0077
extend the same source-of-truth to skills and hooks, so a user running
`opencode .` on a reddb.io repo sees the same model, the same 56
skills, and the same lifecycle hooks Claude Code and Codex see.

## Testing

```bash
pnpm --filter @redskills/opencode-host test       # 60 tests, ~13s
pnpm --filter @redskills/opencode-host typecheck  # tsc strict
pnpm --filter @redskills/opencode-host bundle    # emits dist/opencode-host.bundle.min.mjs
```

The pure modules (`provider-block.ts`, `skills-to-opencode.ts`,
`hooks-to-events.ts`, `emit.ts`) are unit-tested in isolation. The CLI
smoke (`generate-cli.test.ts`) spawns the real entrypoint through
`tsx` and exercises the file-IO contract, the opt-in gate, the
precedence pick, and the auth-leak guard. The Slice 2 e2e
(`slice-2-e2e.test.ts`) exercises the planner against the real
`plugins/dev/`, `plugins/memory/`, `plugins/brain/` source trees.

## Related

- **ADR 0075** — Slice 1 (provider block).
- **ADR 0076** — Slice 2 (skills → flat symlinks, name validation).
- **ADR 0077** — Slice 2 (hooks → plugin events, env-var rewrite).
- **ADR 0059 Amendment 3** — env precedence + slug reused for the host.
- **ADR 0067** — strict opt-in gate (`plugins.dev.enabled: true`).
- **ADR 0034** — `apps/<plugin>/` layout; this app follows.
- **ADR 0038 / 0052** — release-asset + dist naming, bundled form follows.
