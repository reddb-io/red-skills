---
name: setup-statusline
description: Install or inspect the RedSkills statusline for the active host. RedSkills has one shared `statusline` producer in the dev bundle; Claude Code wires it through `.claude/settings.json` as a command-backed statusLine, while Codex configures the built-in `tui.status_line` footer and the dev plugin's SessionStart self-heal hook. Preserves existing config unless replacement is explicitly requested.
disable-model-invocation: true
---

# Statusline

**Wire the RedSkills statusline surface for the host the agent is running under — stop immediately if a gate condition is met.** RedSkills is client/CLI/coder/runner agnostic: the dev bundle owns one `statusline` producer, and each host gets the richest integration it actually supports. Claude Code can render the shared producer directly as a command-backed statusLine. Codex currently exposes only native footer widgets, so the skill configures those widgets and relies on the dev plugin's SessionStart hook to keep the footer present across Codex config rewrites.

Install or inspect the RedSkills statusline for this repository. The shared producer renders the project name, branch, model/context data when the host provides it, repo counters, and live AFK state. **The two hosts get two shapes (per-runner split, ADR 0003):**

- **Claude Code — multi-line.** Claude Code's `statusLine` renders multiple rows, so the themed producer emits a repo-global **header line** — always shown, even with no live workers: project (branch) + version, model·effort + context, open PRs + open issues, local diff vs `origin/main`, and (Pro/Max only, when the payload exposes them) the 5-hour and weekly usage windows `5h=…% 7d=…%` — **then one line per live AFK worker**. Each worker line is the SAME compact row `/afk monitor --once` prints (single source of truth — worker id, stage, issue, elapsed, `+A -R`, tokens), so the two surfaces never drift. Zero live workers → only the header line.
- **Codex — single line.** The `tui.status_line` footer is single-line only, so the plain producer stays ONE aggregate line (project · model · context · usage · repo counts · the AFK block). The multi-line layout is Claude-Code-only.

The AFK rows are quiet when no worker is active. Hosts that cannot run a command-backed statusline still get a useful native footer plus `/afk monitor` for live AFK visibility.

**Host capabilities differ; the product architecture should not.** Treat the RedSkills statusline as:

1. A shared producer: the dev bundle's `statusline` subcommand.
2. Host adapters: Claude Code's command-backed `statusLine`; Codex's global `tui.status_line` list and plugin `SessionStart` hook.
3. Fallback visibility: `/afk monitor`, which works when a host has no command-backed footer.

This mirrors how Codex itself organizes customization: skills define reusable workflows, plugins distribute skills plus hooks/MCP/apps, `config.toml` stores host settings, and hooks attach lifecycle behavior next to the active plugin/config layer. Keep RedSkills logic in the bundle and keep host-specific wiring in the host sections below.

## Claude Code

1. Inspect the repo: `.red/config.yaml`, `.claude/settings.json`, and whether `jq` is available.

2. **Early exit — opt-out:** if `.red/config.yaml` has top-level `statusline: false` or nested `afk.statusline: false`, stop and tell the user it is disabled. Do not proceed.

3. **Early exit — already configured:** if `.claude/settings.json` already has `statusLine`, do not overwrite it unless the user explicitly asked to replace it (then replace only `statusLine`, preserving all other keys).

4. Write the RedSkills statusline:

```json
{
  "statusLine": {
    "type": "command",
    "command": "sh -c 'b=$(ls -1 \"$HOME\"/.cache/red-skills/bundles/dev-*.bundle.min.mjs 2>/dev/null | sort -V | tail -1); [ -z \"$b\" ] && b=$(ls -1 \"$HOME\"/.claude/plugins/cache/red-skills/dev/*/skills/engineering/afk/bin/afk.mjs 2>/dev/null | sort -V | tail -1); [ -n \"$b\" ] && exec node \"$b\" statusline'",
    "refreshInterval": 5
  }
}
```

**Why this shape (cached-bundle-first, not `$CLAUDE_PLUGIN_ROOT`, not `afk.mjs` directly):** read [`HOST-NOTES.md`](HOST-NOTES.md) → *Claude Code*. The command above is cached-bundle-first by design (ADR 0084) — never alter it to fetch synchronously in the render path.

Use `jq` to merge when `.claude/settings.json` already exists; create `.claude/`
and a fresh file when it is missing. Keep unrelated settings intact.

5. Verify: confirm `.claude/settings.json` is valid JSON and has `.statusLine.command`. Unlike the old `$CLAUDE_PLUGIN_ROOT` form, you **can** prove this one renders by piping a minimal session JSON into the **same `sh -c '…'` command from step 4** (no need to re-type it):

```bash
printf '{"workspace":{"project_dir":"%s"},"model":{"display_name":"Opus"}}' "$PWD" \
  | <the step-4 statusLine command>
```

It should print the themed **header line** (e.g. `» red-skills (main) v… Opus·high …`); when AFK workers are live it prints one additional row per worker below it. Under `NO_COLOR` the same command collapses to the single-line plain form `red-skills (main) · Opus·high · …`.

## Codex

Codex configures its footer through the `tui.status_line` key in `config.toml`
— an ordered list of **built-in** item identifiers (`project`, `git-branch`,
`model-with-reasoning`, `context-remaining`, `task-progress`, `current-dir`,
…). When unset, Codex currently uses `["model-with-reasoning",
"context-remaining", "current-dir"]`; set it to `[]` to hide the footer.
This skill offers the **global** `~/.codex/config.toml` path because the footer
is a personal host preference, not repo state. There is no command hook, so the
shared RedSkills `statusline` producer cannot be injected into the footer yet.

Codex has a native `/statusline` command for picking and reordering these
footer items and persisting them to `config.toml`. The dev bundle also exposes
an explicit inspector/fixer:

```bash
red-skills-dev codex-statusline
red-skills-dev codex-statusline --fix
```

The inspector reports the active `tui.status_line`, flags a missing
`task-progress` widget, prints the recommended order, and reminds the operator
that rich AFK worker state still lives in `/afk monitor`. `--fix` is explicit:
it appends `task-progress` to an existing visible footer or installs the
recommended footer when `status_line` is absent. If the user already has a
custom `tui.status_line`, preserve it unless they explicitly ask for `--fix`;
that custom value is the operator's host preference, not repo state.

Offer to set a useful footer (note: this is **global** Codex config, not
per-repo like the Claude path):

```toml
[tui]
status_line = ["project", "git-branch", "model-with-reasoning", "context-remaining", "task-progress"]
```

**Surviving Codex config resets.** A global `tui.status_line` gets dropped when Codex rewrites `~/.codex/config.toml`, but the dev plugin's Codex `SessionStart` hook re-asserts it so a reset self-heals on the next session start — why and how (the additive, atomic, absent-only re-write) is in [`HOST-NOTES.md`](HOST-NOTES.md) → *Codex*.

This is intentionally host-global and plugin-gated. Codex stores footer
preferences in `~/.codex/config.toml`, while RedSkills gates global hook side
effects on the repo's `.red/config.yaml` `plugins.dev.enabled: true` flag. That
keeps the installed plugin available everywhere but inert outside opted-in
repos, matching the rest of the RedSkills hook model.

For live AFK visibility under Codex, `/afk monitor` remains the canonical
dashboard. Normal `/afk run` launches and `/afk fleet` launches also try to
attach one read-only Codex monitor agent when the host exposes a sub-agent
primitive; the prompt comes from `afk codex-monitor-agent --mode run|fleet`.
When the primitive is unavailable, Codex falls back to the monitor dashboard.
When Codex ships a command-backed statusline (openai/codex#17827 / #20244), this
skill can add a `{ type = "command", command = … }` entry pointing at the same
AFK bundle so the line matches Claude Code's.

## OpenCode

Nothing to install: OpenCode is an AFK API-auth runner lane (`--runner opencode`), not an interactive host UI, so it has no footer/statusline adapter — observe it through `/afk monitor`, `/afk dashboard`, and Actions output like any other runner.

## Notes

- Invoke as `/setup-statusline` (Claude Code) or `$setup-statusline` (Codex). Wire the host you are running under; do not imply the statusline feature belongs to only one client.
- `/setup-red-skills` may offer the Claude Code command-backed adapter during project bootstrap. Under Codex, use this skill to inspect or configure the native footer path.
