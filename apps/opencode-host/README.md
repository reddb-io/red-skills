# @reddb-io/red-skills

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
  Claude/Codex event class). Supported lifecycle mappings are:
  `SessionStart → config` plus `experimental.chat.system.transform`,
  `PreToolUse → tool.execute.before`, `PostToolUse → tool.execute.after`,
  `Stop → session.idle`, `PreCompact → experimental.session.compacting`,
  and `UserPromptSubmit → chat.message`. Events without an OpenCode plugin
  equivalent are warned and skipped.
- **Slice 3 (ADR 0079)** — MCP passthrough. The per-plugin `.mcp.json`
  is rewritten into opencode's `mcp: { <name>: { type: "local",
  command, environment, cwd? } }` shape and merged into the Slice 1
  `opencode.json`. The plugin root is resolved at build time and
  baked into the emitted `command` array.
- **Slice 4 (ADR 0080)** — statusline + toasts. The dev plugin ships
  a `session-status.ts` opencode plugin module that emits a toast
  with the AFK statusline on every `session.idle`, injects the
  worker state into `experimental.session.compacting`, and
  suggests `/afk monitor` on `session.created`. The install
  script also writes a `tui.json` with `attention.enabled: true`
  so the built-in sound + notification events fire by default.
- **Slice 5 (planned)** — remote install via release asset.

## CLI

```bash
# Slice 1 only (default)
pnpm --filter @reddb-io/red-skills generate
pnpm --filter @reddb-io/red-skills generate -- --config ./redskills.yaml --out ./opencode.json
pnpm --filter @reddb-io/red-skills generate -- --print          # stdout, no file

# Slice 1 + Slice 2 — emit the dist tree
pnpm --filter @reddb-io/red-skills generate -- --with-slice-2
# default out-dir is ./dist/opencode; override with --out-dir

# Emit a single plugin
pnpm --filter @reddb-io/red-skills generate -- --with-slice-2 --plugin dev

# Copy SKILL.md instead of symlinking (cross-filesystem safety)
pnpm --filter @reddb-io/red-skills generate -- --with-slice-2 --copy

# Bundled form (release asset)
pnpm --filter @reddb-io/red-skills bundle
node ./dist/opencode-host.bundle.min.mjs --with-slice-2 --plugins-root ./plugins

# Which build is answering?
node ./dist/opencode-host.bundle.min.mjs --version         # opencode-host <version> <sha>
node ./dist/opencode-host.bundle.min.mjs --version --json  # the structured build info
node ./dist/opencode-host.bundle.min.mjs --help
```

Commands and flags are routed by the shared arg contract
(`@reddb-io/shared/args`, ADR 0114): `generate` is the default command, `-v` is
version (never verbose), and a flag the schema does not declare fails with exit
2 and a message naming it. The accepted surface is declared in
`src/cli-args.ts`.

## Universal install (recommended)

For normal user installs, use the root universal installer. It resolves the
latest RedSkills release, detects `opencode` and `redcode` alongside Claude Code
and Codex, and invokes the adapter for every host present:

```bash
curl -fsSL https://raw.githubusercontent.com/reddb-io/red-skills/v3/scripts/install.sh | bash
```

That path installs OpenCode under `~/.config/opencode/`, RedCode under
`~/.config/redcode/`, and also keeps
Claude/Codex marketplace installs in sync when those CLIs are present. It uses
the published `opencode-host.bundle.min.mjs` release asset when available, so
normal installs need `node` but do not need a local workspace build.

## Adapter install script

The `scripts/install-opencode.sh` wrapper in the repo root bundles the
above into one command that handles generation, install, and uninstall. Use it
directly when developing the adapter or when installing/removing a checkout in a
specific project:

```bash
# global — recommended user-scoped install into ~/.config/opencode/
git clone git@github.com:reddb-io/red-skills.git ~/code/red-skills
cd ~/code/red-skills
scripts/install-opencode.sh --global

# global RedCode — isolated from an existing OpenCode install
scripts/install-opencode.sh --global --host redcode

# global — remove RedSkills from ~/.config/opencode/
scripts/install-opencode.sh --uninstall --global

# remove only the RedCode surface
scripts/install-opencode.sh --uninstall --global --host redcode

# local — install into the current directory's .opencode/
scripts/install-opencode.sh

# local — remove RedSkills from the current directory's .opencode/
scripts/install-opencode.sh --uninstall

# local — install into a specific project
scripts/install-opencode.sh /path/to/your-project

# --copy forces SKILL.md copy instead of symlink
scripts/install-opencode.sh /path/to/your-project --copy

# --dry-run prints the steps without writing
scripts/install-opencode.sh /path/to/your-project --dry-run
```

Then open OpenCode in a project:

```bash
cd /path/to/your-project
opencode .
```

The global install writes the selected host's `plugins/`, `skills/`,
`opencode.json(c)`, and `tui.json(c)` beneath `~/.config/opencode/` or
`~/.config/redcode/`. The local
install writes the same OpenCode surface under the target repo's `.opencode/`
plus project-local `opencode.json` and `tui.json`. Existing global config files
are timestamp-backed-up before replacement. Uninstall removes manifest-recorded
files and RedSkills-generated config files, but keeps unrelated or edited user
config.

Use `/connect` inside OpenCode, or export one of `OPENAI_API_KEY`,
`MINIMAX_API_KEY`, or `OPENROUTER_API_KEY`. The generated files carry provider
and model config only; they never store auth secrets.

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
│       │   ├── pre-tool-use.ts    ← PreToolUse → tool.execute.before
│       │   ├── post-tool-use.ts   ← PostToolUse → tool.execute.after
│       │   ├── stop.ts            ← Stop → session.idle
│       │   ├── pre-compact.ts     ← PreCompact → experimental.session.compacting
│       │   └── user-prompt-submit.ts ← UserPromptSubmit → chat.message
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

## Semantic navigation is the host's when the host has an LSP

RedCode runs a language-server stack natively. Projecting the `navigator` MCP
onto it would birth a **second** stack over the same tree — double the memory,
double the indexing wall-clock, and two answers that can disagree while both
look authoritative. So `--host redcode` omits `navigator` from the emitted
`mcp:` block entirely (the entry is dropped, not emitted `enabled: false`: an
entry carrying the launcher command is one flag away from the duplicate it
exists to prevent), and the generator says on stdout what it deferred and why.

The deferral is conditional on the native authority actually being available.
`--host opencode`, Claude Code, and Codex have no LSP of their own and keep
`navigator`; `--host redcode --no-native-lsp` puts it back for a RedCode install
whose native LSP is switched off. Every other MCP the plugins ship is untouched
— RedCode still receives `redskilled` and `rsp`.

The rule lives in `src/semantic-authority.ts` as a host table plus the operator
override, so the standalone Slice 1 file and the Slice 2 dist tree defer the
same way instead of each emit path re-deciding.

## Hook coverage notes

OpenCode does not expose a Claude-style `SubagentStop` event in the plugin
surface, so the adapter reports a warning and emits no module for that hook.
`Stop` uses `session.idle`, which is OpenCode's turn-finished signal; when
available, the generated module reads session messages through the OpenCode SDK
and passes them to hooks as `transcript_text`. `PreCompact` uses
`experimental.session.compacting`, the pre-compaction hook that can add context
to the compaction prompt. Session-start hook output such as rsp ambient
instructions is parsed from `systemMessage` or
`hookSpecificOutput.additionalContext` and forwarded through
`experimental.chat.system.transform`.

## Testing

```bash
pnpm --filter @reddb-io/red-skills test       # 60 tests, ~13s
pnpm --filter @reddb-io/red-skills typecheck  # tsc strict
pnpm --filter @reddb-io/red-skills bundle    # emits dist/opencode-host.bundle.min.mjs
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
