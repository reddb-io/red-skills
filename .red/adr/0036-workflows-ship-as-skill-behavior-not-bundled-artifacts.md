---
status: accepted
---

# Dynamic workflows ship as skill behavior, not as bundled plugin artifacts

Claude Code dynamic workflows (research preview, as of 2026-05-31) **cannot be bundled in a plugin**. The `plugin.json` manifest has no `workflows` key and no `workflows/` component directory — the documented component set is skills, agents, hooks, MCP servers, LSP servers, and monitors, and `claude plugin validate` silently ignores any unrecognized top-level field. Saved workflows are only discovered from `.claude/workflows/` (project) or `~/.claude/workflows/` (personal); the built-in ones (e.g. `/deep-research`) ship inside Claude Code itself. Therefore **no path inside our published plugin delivers a runnable workflow to a consumer repo** — not `plugins/dev/workflows/`, not anywhere.

**Decision.** When a RedSkills skill benefits from a workflow, the durable value ships in the **skill markdown** as the universal baseline (parallel `subagent_type=Explore` fan-out + adversarial verification via the Agent tool), which travels in the plugin and runs in any repo — and on Codex, which has no workflows at all. A workflow is only an **optional accelerator** (parallelism + background) for sessions where the feature is on; a skill must never gate on it. Reference workflow scripts live at `.claude/workflows/*.js` in *this* repo (carved out of the `.claude/` gitignore via `.claude/*` + `!.claude/workflows/`) as committed dogfood + live `/command` for contributors only. The first instance is `improve-codebase-architecture` + `.claude/workflows/improve-arch-explore.js`.

This is the same root cause as the memory plugin's gitignored-`dist/` no-op: an artifact that does not travel with the plugin cannot be relied on at the consumer.

## Considered alternatives

- **Bundle the `.js` under `plugins/dev/workflows/`** — rejected: Claude Code never reads that path, so it would be a dead file masquerading as a shipped component.
- **Installer copy step (Option B)** — `/setup-red-skills` copies a bundled `.js` resource into the consumer's `.claude/workflows/`. Rejected for now: Claude-only (Codex skip), benefits only the subset of consumers on Claude with workflows enabled (off-by-default on Pro), and adds a silent-vanish-prone copy path to maintain — all while the skill baseline already delivers the behavior to everyone.

## Migration trigger

Revisit if a `workflows` key (or `workflows/` component directory) lands in the `plugin.json` schema. At that point Option B collapses: move the reference script to `plugins/dev/workflows/`, declare it in the manifest, and the workflow ships to consumers as a real bundled component. Verify on a live CLI (`claude plugin validate`) before assuming the key exists.
