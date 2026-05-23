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
_zoom_out_focus_label="<skill/module/file/concept label from the user's request, or empty>"
_zoom_out_path_from="<first explicitly named skill/module/file/concept, or empty>"
_zoom_out_path_to="<second explicitly named skill/module/file/concept, or empty>"
if [ -f .red/memory/config.json ]; then
  _bridge="${CLAUDE_PLUGIN_ROOT:-}/scripts/memory-bridge.sh"
  [ -f "$_bridge" ] || _bridge="$(git rev-parse --show-toplevel 2>/dev/null)/plugins/dev/scripts/memory-bridge.sh"
  if [ -f "$_bridge" ] && source "$_bridge"; then
    MEMORY_REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
    _memory_mode="$(memory_mode . 2>/dev/null || printf 'unavailable\n')"
    if [ "$_memory_mode" = "graph" ]; then
      if memory_graph_ready .; then
        if [ -n "$_zoom_out_path_from" ] && [ -n "$_zoom_out_path_to" ]; then
          memory_path . "$_zoom_out_path_from" "$_zoom_out_path_to" bfs
        fi
        if [ -n "$_zoom_out_focus_label" ]; then
          memory_neighbors . "$_zoom_out_focus_label" 1 both
        fi
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
If the user names a focused area (a skill, module, file-like component, or concept) and graph neighbors are available through `memory_neighbors`, interpret neighbor evidence into the **Relationships** section: callers, dependencies, adjacent concepts, ownership boundaries, and likely traversal paths. Do not paste raw neighbor, node, or edge output; use it only after verifying against current files where the answer depends on it. If `memory_neighbors` prints nothing or fails, continue with ordinary codebase exploration.
If the user asks about the relationship between two explicit project elements (two skills, modules, files, components, or concepts), set `_zoom_out_path_from` and `_zoom_out_path_to` to those labels and use `memory_path` as optional graph evidence for the **Critical Paths** section. Interpret path evidence into the shortest meaningful workflow, dependency chain, or change-impact route between the two elements, then verify the explanation against current files before relying on it. Do not paste raw path, hop, or weight output; explain what the path means in project terms. If `memory_path` prints nothing, reports no path, fails, or graph reads are unavailable, continue through ordinary codebase exploration and answer from the files normally.

When the focused area is a likely change target and graph reads are available, the `memory_neighbors` and `memory_recall` calls above will also surface **Reasoning attempts** recorded by AFK (graph node type `attempt`, often with `TOUCHED` edges to file nodes and `PRECEDES` edges between attempts on the same issue). Fold this evidence into the **Observed impact** sub-bullet of the **Impact** section: files repeatedly touched together with the target, repeated blocked / no-sentinel / merge-conflict attempts, retry chains leading to a successful attempt, and validation summaries attached to those attempts. Treat attempt evidence as **operational history**, not authoritative product requirements or acceptance criteria — verify any observed claim that affects the answer against the current worktree before relying on it, and never paste raw attempt records or `memory_*` output. If no attempt evidence is present, surfaced, or relevant, drop the Observed impact sub-bullet silently and answer from structural impact and ordinary code reads.

## Answer Contract

Start with the map, not raw graph output. Use this order:

1. **Modules/Layers** - the relevant modules, layers, skills, scripts, services, or packages and their responsibilities.
2. **Relationships** - the callers, dependencies, data/control flow, ownership boundaries, and how the pieces fit.
3. **Impact** *(optional — include when the user's focus is a file, symbol, module, skill, or concept that may change)* - the impact surface of that focused target, expressed in project terms. When evidence for both kinds is available, **separate structural impact from observed impact explicitly**:
   - **Structural impact** — what the codebase says today about the target: **imports**, **calls**, **containment** (module/package/skill membership), **type-use** (symbols referenced through type positions), **docs links** (referencing markdown/SKILL.md/CONTEXT/ADR), and **graph neighbors/paths** for the target. Every claim must be **verified against the current worktree** (current file relationships, current imports, current call sites) before it lands in the answer.
   - **Observed impact** — what prior **Reasoning attempts** recorded by AFK show happened operationally around this target: files **touched together** with it across attempts, **repeated** blocked / no-sentinel / merge-conflict attempts, **retry chains** that led to (or away from) a successful attempt, and **validation summaries** attached to those attempts. Describe this as **operational history**, not authoritative product direction or acceptance criteria — it is evidence of what tends to break, retry, or co-change, not a spec. Verify any observed claim that affects the answer against the current worktree before relying on it.

   Interpret graph or recall evidence into project terms — do **not** paste raw nodes, edges, paths, recall output, attempt records, or `memory_*` command output. If Memory is absent, stale, empty, failing, or has no relevant attempts for this target, **degrade cleanly**: drop the Observed impact sub-bullet and answer from structural impact alone; if structural evidence is also absent, answer this section from ordinary code reads and mention indexing only as a risk/gap in **Risks/Gaps** when materially useful. This section is **read-only**: it must not run `/memory:ingest`, reindex, or any graph-write or memory-write command, and it must not create or reference a new `/impact` skill or a `memory_impact` primitive — both structural and observed impact in `zoom-out` ride on `memory_neighbors`, `memory_path`, `memory_recall`, and ordinary code exploration only.
4. **Critical Paths** - the workflows or execution paths that matter most for the user's question or planned change.
5. **Risks/Gaps** - missing context, stale indexing, unclear ownership, brittle areas, test gaps, or change hazards.

Use project glossary terms for names and concepts. Do not lead with a graph dump, raw nodes/edges, raw neighbor output, or unprocessed recall output; graph or Memory evidence can support the map after the structure is clear.

The entire `zoom-out` answer is read-only. Do not run ingest, reindex, graph writes, memory stores, or any mutation from `zoom-out`, in the **Impact** section or anywhere else. Do not introduce a new `/impact` skill or a `memory_impact` primitive to satisfy the **Impact** section — it is fulfilled by the existing read primitives (`memory_neighbors`, `memory_path`, `memory_recall`) plus ordinary code reads.
