---
name: doctor
working-mode: interactive
description: Inspect and maintain the memory graph — list stale nodes (long-unaccessed and never recalled) and, only after explicit confirmation, prune them. Use when the user says "memory doctor", "clean up memory", "what's stale in memory", "prune old memory", or wants a health check of the graph. Graph mode only.
disable-model-invocation: true
---

# memory doctor

The maintenance + inspection surface over the graph (graph mode only). Flags
**stale** nodes — last accessed more than the threshold (90 days by default)
*and* never recalled (`access_count == 0`) — and prunes them, but **only after
explicit confirmation**. Pinned nodes (`importance >= 0.8`) are never stale.
Recall maintains the access overlay, so a node that keeps getting recalled stays
fresh; one that nobody reads goes cold and surfaces here.

<what-to-do>

**Run a read-only stale-node scan first, show the list to the user, and prune only after they explicitly confirm — never pass `--prune --yes` on their behalf.**

## 1. Require graph mode

`doctor` needs graph mode — see [Memory preconditions](../../references/PRECONDITIONS.md). If memory is not initialized or is markdown-only, say so and stop — there is no graph to inspect.

## 2. Diagnose (read-only first)

Always list before deleting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" doctor
```

Add `--stale-days N` to change the threshold. This only **lists** — nothing is
deleted.

## 3. Prune only with confirmation

If the user wants the stale nodes gone, re-run with `--prune`. It re-lists the
candidates and asks for a typed `yes` before deleting:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" doctor --prune
```

In a non-interactive shell, `--prune` refuses unless `--yes` is also passed. Pass
`--yes` only when the user has already confirmed.

## DOs / DON'Ts

- ✅ Show the stale list and let the user decide — pruning is destructive.
- ✅ Treat pinned (`importance >= 0.8`) nodes as keepers; they never appear stale.
- ❌ Never run `--prune --yes` on the user's behalf without their explicit go-ahead — pruning is destructive.
- ❌ Don't lower `--stale-days` to force-flag nodes the user didn't ask to clean.

</what-to-do>

<supporting-info>

## MCP

The MCP server exposes the read-only half as `memory_doctor` (`stale_days`
arg). Pruning stays a confirmed CLI operation — it is not exposed over MCP.

</supporting-info>
