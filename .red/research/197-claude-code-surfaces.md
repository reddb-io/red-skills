# Research: Claude Code agents/workflows and JS workflow support

Discovery slice for PRD #196 → issue #197.

Scope: confirm the Claude Code plugin surfaces RedSkills can depend on
before implementation, distinguish documented behaviour from third-party
patterns, and recommend whether to lean on markdown agents only, JS
workflow files, hooks, or a hybrid.

Sources consulted: official Claude Code documentation at
`https://code.claude.com/docs/en/` — pages for `plugins`,
`plugins-reference`, `sub-agents`, `skills`, `hooks-guide`,
`agent-teams`, `agent-view`, `routines`, `common-workflows`,
`plugin-marketplaces` (fetched 2026-05-27). Repo-local evidence:
`plugins/dev/.claude-plugin/plugin.json`,
`plugins/memory/hooks/claude.hooks.json`,
`plugins/dev/hooks/codex.hooks.json`.

## 1. Confirmed Claude Code plugin surfaces

All of the following are documented in the official plugin guide and
plugin reference, and all are exercised by at least one shipped plugin
in this repo unless flagged otherwise.

| Surface | Location in a plugin | Format | Used by RedSkills today |
| --- | --- | --- | --- |
| Plugin manifest | `.claude-plugin/plugin.json` | JSON | yes (`dev`, `memory`) |
| Skills | `skills/<name>/SKILL.md` | Markdown + YAML frontmatter (`description`, `disable-model-invocation`, `$ARGUMENTS`) | yes |
| Legacy commands | `commands/<name>.md` | Flat markdown | no — docs steer new plugins to `skills/` |
| Subagents | `agents/<name>.md` | Markdown + YAML frontmatter (`description`, `tools`, `model`, …); invoked via the Task tool with `subagent_type` | no |
| Hooks | `hooks/hooks.json` | JSON, identical schema to `.claude/settings.json` `hooks` block | yes (`memory/hooks/claude.hooks.json`) |
| MCP servers | `.mcp.json` | JSON | yes (`plugins/dev/.mcp.json`) |
| LSP servers | `.lsp.json` | JSON | no |
| Background monitors | `monitors/monitors.json` | JSON; each line of `command` stdout is delivered as a notification | no |
| Bin shims | `bin/<exe>` | Native executables added to `PATH` while the plugin is enabled | no |
| Default settings | `settings.json` | JSON; only `agent` and `subagentStatusLine` keys honoured | no |

Cross-session surfaces also documented but not part of the plugin
directory layout:

- **Agent teams** (`agent-teams`) — orchestrates multiple Claude Code
  sessions with shared tasks and inter-agent messaging. Not a plugin
  component; it's a runtime feature you opt into from a session.
- **Agent view** (`agent-view`) — dashboard for many parallel sessions.
- **Routines** (`routines`) — schedule Claude Code on a cron-like
  cadence. Useful for periodic AFK drains; not a plugin component.

## 2. Where "workflows" actually live in Claude Code

The word *workflow* shows up in three distinct, non-interchangeable
ways in the official docs. None of them is a JS file.

1. **Prose how-to** (`common-workflows.md`) — copy-paste recipes for
   humans. Not executable.
2. **Hooks** (`hooks-guide.md`) — event-driven shell commands fired by
   the runtime on `SessionStart`, `UserPromptSubmit`, `PreToolUse`,
   `PostToolUse`, `Stop`, `PreCompact`, etc. JSON config, shell command
   payload. This is the closest thing to "workflow automation" the
   plugin system exposes.
3. **Routines** (`routines.md`) — schedule a Claude Code session on a
   cron expression. Useful for unattended periodic work; not a phase
   engine.

The community pattern in `shinpr/claude-code-workflows` builds an
executor / quality-fixer / reviewer / verifier / planner "workflow" by
**composing markdown subagents** through prompt orchestration — it is
not a separate Claude Code primitive. The PRD's reference to that repo
should be read as "we want similar phase decomposition", not "they
unlocked a hidden API".

## 3. JavaScript workflow files

**Confirmed: no documented JavaScript workflow-file mechanism exists in
Claude Code as of 2026-05-27.** The plugin reference enumerates the
component types above and the docs index has no page for JS workflows,
recipes, or workflow scripts.

The places JavaScript can legitimately enter a plugin today:

- **MCP servers** — usually shipped as a Node binary (the repo already
  does this in `plugins/dev/mcp/code-nav/dist/index.js`). MCP exposes
  tools/resources to Claude; it is the right place for stateful or
  algorithmic logic.
- **Hook command targets** — `hooks.json` runs a shell command; that
  command can be `node …/script.js`. The Memory plugin already does
  this (`node "$cli" hook PostToolUse --runner claude`).
- **`bin/` executables** — Node scripts can be exposed on PATH while a
  plugin is active.

That covers the practical surface for "I want to run code, not just
prompt text". There is no first-class JS workflow file declared in
`plugin.json`. If the user heard otherwise, they were almost certainly
referring to one of the three vehicles above — most likely an MCP
server packaged as JS.

**Confidence: high** that no such surface exists in documented Claude
Code. The risk in being wrong is bounded: we are recommending against
betting on a JS-workflow primitive that doesn't have a stable API, not
against shipping JS at all.

## 4. Confirmed vs assumed

Confirmed (documented and reproducible from this repo):

- Plugin manifest schema and the directory layout in §1.
- Subagents are markdown files with YAML frontmatter under `agents/`,
  invoked through the Task tool. Each runs in its own context window.
- Hooks are JSON, fired by named events, payload is a shell command;
  the same schema is shared between `.claude/settings.json` and a
  plugin's `hooks/hooks.json`.
- Plugin marketplace flow: `marketplace.json` lists plugins; each
  plugin self-describes through `plugin.json`. RedSkills already uses
  this.
- Codex CLI uses a parallel `.codex-plugin/plugin.json` and
  `hooks/codex.hooks.json`; the Codex surface for subagents is **not
  documented** here — this slice does not certify it (issue #204 is the
  Codex-side discovery).

Assumed / community-pattern, not confirmed Claude Code primitives:

- "Recipe-style workflows" as a packaged primitive — they are an
  emergent pattern built from markdown subagents + prompt orchestration.
- Agent-team coordination guarantees beyond what `agent-teams` /
  `agent-view` documents. Useful for human-driven multi-session work;
  unproven as an AFK execution substrate without a spike.
- That every hook event RedSkills uses today on Claude has a Codex
  equivalent (it doesn't — memory already absorbed the `PreCompact` gap
  in [[reference_codex_hooks]]).

## 5. Recommendation

**Hybrid: markdown subagents for phase logic, hooks for lifecycle
glue, MCP for code, no JS workflow file.**

Concretely for the cross-runner AFK task engine in PRD #196:

1. **Encode each AFK phase as a markdown subagent under
   `plugins/dev/agents/`**: `issue-analyzer`, `task-executor`,
   `quality-gate`, `blocker-reporter`. Frontmatter restricts tools,
   pins model where it matters (`haiku` for cheap phases, `sonnet`/
   `opus` for execute). The orchestrator dispatches them through the
   Task tool. This matches the `shinpr` pattern while staying on a
   documented primitive.

2. **Keep `/afk` and its CLI as the runner-neutral spine.** On Claude
   Code, the inner agent dispatches the four subagents above. On Codex
   and Hermes, the same phase contract is fulfilled by `codex exec` /
   delegated tasks with the same JSON I/O. The phase contract — not the
   subagent file — is the load-bearing artefact.

3. **Use hooks for lifecycle / safety, not phase logic.** Branch lock,
   memory write-back on `Stop`/`PreCompact`, telemetry on `PostToolUse`.
   The hook surface is parity-broken between Claude and Codex; keep
   anything safety-critical replicated on both sides where the runner
   supports it, and degrade gracefully where it doesn't.

4. **Push genuinely algorithmic logic into MCP servers**, never into
   a hypothetical JS workflow. The memory plugin's `dist/cli.js` and
   `code-nav` MCP server are the right precedent.

5. **Do not declare native Codex subagents in any public copy** until
   issue #204 confirms support. Public docs should keep saying
   "phased task execution" for Codex.

### Compatibility implications

- **Claude Code (full mode)**: native subagents under `agents/` load
  automatically once published in `plugin.json`. No marketplace
  migration needed — the existing `dev` plugin gains an `agents/`
  sibling to `skills/`.
- **Claude Code (basic / `claude -p`)**: subagent definitions still
  load, but a non-interactive `-p` run can dispatch them through the
  Task tool only if the harness supports it. Treat basic mode as the
  fallback path where the orchestrator inlines phase prompts instead
  of calling subagents.
- **Codex**: ignores `agents/` (no documented support today). The
  AFK orchestrator must emit the same phase contract via `codex exec`
  prompts. Codex parity is delivered by the *contract*, not by mirror-
  ing the file layout.
- **Hermes / fallback**: same — contract-level parity. Existing
  fallback runner prompts can be retrofitted to the JSON I/O shape.
- **Manual skill install** (drop into `~/.claude/`): unaffected.
  Subagents shipped in the plugin appear under `agents/` after
  install; the existing `setup-red-skills` flow doesn't need to do
  more than today.

The path is additive: nothing in the current `skills/` tree changes,
no consumer breaks, and the only new visible surface is `agents/`
under `plugins/dev/`.

## 6. Implementation plan for the next slice

Following issues in PRD #196 should land in this order; this slice
recommends no scope changes to the existing breakdown:

1. **#198** — Validate marketplace metadata for packaged Claude Code
   agents end-to-end (install plugin from the marketplace, confirm
   subagents appear in `/agents`, confirm `--plugin-dir` workflow). Do
   this *before* writing any phase logic.
2. **#199** — Add a minimal `issue-analyzer` subagent under
   `plugins/dev/agents/`. Output contract: structured JSON consumed by
   `/afk`. Cross-runner contract first, Claude implementation second.
3. **#200** — `task-executor` subagent over existing handoff files.
   Re-use the current AFK handoff XML shape; do not invent a new one.
4. **#201** — `quality-gate` subagent and a parser contract for
   `completed | blocked | escalation_needed`. Includes hollow-success
   detectors mentioned in the PRD.
5. **#202** — `/afk` capability detection and dispatch: native agents
   on Claude, phased prompts on Codex, fallback on Hermes.
6. **#203 / #206** — docs (compatibility matrix) and adherence prompts.
   Issue #204 (Codex discovery) gates the Codex-side wording.

JS workflow files are explicitly **out of scope** for the PRD on
current evidence; revisit only if Anthropic ships such a surface.

## 7. Outstanding items for human review (HITL)

- Is the markdown-subagent-only path acceptable, or does the team want
  to spike the `agent-teams` runtime as the execution substrate
  instead? Recommendation: subagents now, `agent-teams` later as an
  optional optimisation once it stabilises.
- Should the new `agents/` directory live in `plugins/dev/` or in a
  separate experimental plugin? Recommendation: `dev`, behind a
  capability check so AFK degrades cleanly on older Claude Code
  installs. ADR-worthy decision.
- Confirm the precedence between subagent `tools` frontmatter and the
  plugin-wide branch-lock hook; the hook should still fire regardless
  of subagent tool restrictions. Test in #198.
