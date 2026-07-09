---
name: setup-statusline
description: Install or inspect the RedSkills statusline for the active host. RedSkills has one shared `statusline` producer in the dev bundle; Claude Code wires it through `.claude/settings.json` as a command-backed statusLine, while Codex configures the built-in `tui.status_line` footer and the dev plugin's SessionStart self-heal hook. Preserves existing config unless replacement is explicitly requested.
disable-model-invocation: true
---

# Statusline

**Wire the RedSkills statusline surface for the current host — stop as soon as a gate condition is met.** Keep the host branch hot here; read [HOST-NOTES.md](HOST-NOTES.md) only for the exact adapter recipe, shared line shape, or rationale needed by the selected host.

<what-to-do>

## 1. Identify The Host

**Pick one branch.** Use Claude Code when `.claude/` or Claude plugin state is the active surface, Codex when the active client is Codex CLI, and OpenCode only when the user asks about the OpenCode runner lane.

**Respect explicit intent.** Install only when the user asks to install, fix, replace, or configure. Otherwise inspect and report the current state.

## 2. Claude Code

1. Inspect `.red/config.yaml`, `.claude/settings.json`, and whether `jq` is available.
2. **Opt-out gate** — if `.red/config.yaml` has top-level `statusline: false` or nested `afk.statusline: false`, stop and tell the user it is disabled.
3. **Existing-config gate** — if `.claude/settings.json` already has `statusLine`, preserve it unless the user explicitly asked to replace it. Replacement touches only `statusLine`; keep every other key.
4. **Apply the adapter recipe** — read [HOST-NOTES.md](HOST-NOTES.md#claude-code-adapter-recipe), then write or merge the cached-bundle-first `statusLine` block exactly as documented there.
5. **Verify the write** — confirm `.claude/settings.json` is valid JSON, contains `.statusLine.command`, and renders by piping minimal session JSON into the same command from the recipe.

## 3. Codex

1. Inspect the active `~/.codex/config.toml` footer preference with `red-skills-dev codex-statusline`.
2. **Preserve host preference** — if `tui.status_line` is already custom, leave it alone unless the user explicitly asks to fix or replace it.
3. **Apply the adapter recipe only on request** — read [HOST-NOTES.md](HOST-NOTES.md#codex-adapter-recipe), then run the explicit fixer or write the recommended global footer. Treat this as host-global config, not repo state.
4. **Report AFK visibility honestly** — Codex gets native footer widgets plus `/afk monitor`; it cannot inject the shared command-backed producer into the footer yet.

## 4. OpenCode

**Install nothing.** OpenCode is a runner lane, not an interactive host UI with a footer adapter. Point the user to `/afk monitor`, `/afk dashboard`, and Actions output. The full note is in [HOST-NOTES.md](HOST-NOTES.md#opencode-adapter).

## 5. Finish

Tell the user which host branch you used, what changed or why nothing changed, and how to observe live AFK state.

</what-to-do>

<supporting-info>

## Reference Map

- **Shared architecture and line shapes:** [HOST-NOTES.md](HOST-NOTES.md#shared-architecture-and-line-shapes).
- **Claude Code command-backed adapter:** [HOST-NOTES.md](HOST-NOTES.md#claude-code-adapter-recipe).
- **Codex native footer adapter:** [HOST-NOTES.md](HOST-NOTES.md#codex-adapter-recipe).
- **OpenCode no-install note:** [HOST-NOTES.md](HOST-NOTES.md#opencode-adapter).

## Invocation Notes

- Invoke as `/setup-statusline` (Claude Code) or `$setup-statusline` (Codex). Wire the host you are running under; do not imply the statusline feature belongs to only one client.
- `/setup-red-skills` may offer the Claude Code command-backed adapter during project bootstrap. Under Codex, use this skill to inspect or configure the native footer path.

</supporting-info>
