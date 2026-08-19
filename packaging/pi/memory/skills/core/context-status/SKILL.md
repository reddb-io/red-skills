---
name: context-status
working-mode: interactive
description: Report the project context stack posture without mutating anything. Use when checking whether agent rules, domain docs, ADRs, Memory graph/telemetry, and LLM Wiki are ready before a large task or self-improvement loop.
---

# memory context-status

Read-only healthcheck for the agent context stack. It reports committed context, Memory mode, graph store presence, graph freshness, Skill telemetry, Wiki readiness, a simple score, and concrete recommendations.

<what-to-do>

**Run the context-status report, read every section together, and surface `recommendations` as concrete next steps — never trigger initialization or mutations from this diagnostic.**

## 1. Run the status report

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" status context
```

Use JSON for automation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" status context --json
```

## 2. Interpret the posture

Read these sections together:

- `committedContext` — whether `CLAUDE.md`/`AGENTS.md`, `.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, and `.red/adr/*.md` are present.
- `memory` — init-chain state (see [Memory preconditions](../../references/PRECONDITIONS.md#init-chain-state-taxonomy)), plus graph store, freshness, hooks, and Skill telemetry availability.
- `wiki` — whether `.red/agents/wiki.md` and `.red/wiki/` are both present.
- `score` — count of ready checks; this is a grounding signal, not a quality guarantee.
- `recommendations` — setup actions that would improve context readiness.

## 3. Keep it read-only

This command must not initialize Memory, ingest a graph, create Wiki files, update skills, or mutate project docs. If setup is needed, report the exact recommendation and let the user or calling workflow decide.

## DOs / DON'Ts

- ✅ Run before large changes, `/afk` waves, onboarding, or Skill curation.
- ✅ Treat a low score as a reason to gather context, not as a failure.
- ✅ Pair with `/context` from the `dev` plugin for the full context stack loop.
- ❌ Do not auto-ingest when graph freshness is stale; recommend `memory ingest . --root .` instead.
- ❌ Do not auto-enable hooks, MCP, graph mode, telemetry, or Wiki state from this diagnostic.

</what-to-do>
