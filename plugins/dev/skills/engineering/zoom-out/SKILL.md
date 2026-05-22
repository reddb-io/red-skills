---
name: zoom-out
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
disable-model-invocation: true
---

I don't know this area of code well. Go up a layer of abstraction and produce a map-first **Zoom-out answer** for the relevant part of the **Codebase understanding surface**.

## Gather Context

Use the project's glossary vocabulary from `.red/CONTEXT.md` and respect nearby ADRs. Then read the codebase normally: relevant modules, callers, tests, entrypoints, and configuration.

Opportunistically fold in Memory recall when it is available. Treat Memory as best-effort context, never a gate:

```bash
if [ -f .red/memory/config.json ]; then
  _bridge="${CLAUDE_PLUGIN_ROOT:-}/scripts/memory-bridge.sh"
  [ -f "$_bridge" ] || _bridge="$(git rev-parse --show-toplevel 2>/dev/null)/plugins/dev/scripts/memory-bridge.sh"
  if [ -f "$_bridge" ] && source "$_bridge"; then
    MEMORY_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
    _memory_mode="$(memory_mode . 2>/dev/null || printf 'unavailable\n')"
    if [ "$_memory_mode" = "graph" ]; then
      if memory_graph_ready .; then
        memory_recall . "<2-6 keywords for the code area>"
      else
        _zoom_out_memory_ingest_hint=1
      fi
    else
      memory_recall . "<2-6 keywords for the code area>"
    fi
  fi
fi
```

If Memory is absent, unavailable, uninitialized, errors, or returns no context, continue through ordinary codebase exploration. Verify any recalled claim against current files before relying on it.
If Memory is in graph mode but `memory_graph_ready` is false, treat graph-backed context as missing or insufficient: keep the answer read-only, continue through ordinary codebase exploration, and mention `/memory:ingest` in **Risks/Gaps** only when indexing would materially improve future zoom-out work. Do not run `/memory:ingest`, reindex, or any graph write command from `zoom-out`. Markdown-only Memory continues to use `memory_recall` as a best-effort fallback.

## Answer Contract

Start with the map, not raw graph output. Use this order:

1. **Modules/Layers** - the relevant modules, layers, skills, scripts, services, or packages and their responsibilities.
2. **Relationships** - the callers, dependencies, data/control flow, ownership boundaries, and how the pieces fit.
3. **Critical Paths** - the workflows or execution paths that matter most for the user's question or planned change.
4. **Risks/Gaps** - missing context, stale indexing, unclear ownership, brittle areas, test gaps, or change hazards.

Use project glossary terms for names and concepts. Do not lead with a graph dump, raw nodes/edges, or unprocessed recall output; graph or Memory evidence can support the map after the structure is clear.
