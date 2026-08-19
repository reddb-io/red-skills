---
name: zoom-out
working-mode: interactive
description: Tell the agent to zoom out and give broader context or a higher-level perspective. Use when you're unfamiliar with a section of code or need to understand how it fits into the bigger picture.
disable-model-invocation: true
---

**Never paste raw graph output — interpret nodes and edges into project terms before answering.**

I don't know this area of code well. Go up a layer of abstraction and produce a map-first **Zoom-out answer** for the relevant part of the **Codebase understanding surface**.

<what-to-do>

## Gather Context

Use the project's glossary vocabulary from `.red/CONTEXT.md` and respect nearby ADRs. Then read the codebase normally: relevant modules, callers, tests, entrypoints, and configuration.

Opportunistically fold in Memory recall when it is available. Treat Memory as best-effort context, never a gate. For graph mode only — see [`scripts/graph-mode-plumbing.sh`](scripts/graph-mode-plumbing.sh) (variables `_zoom_out_target_file`, `_zoom_out_target_symbol`, `_zoom_out_focus_label`, `_zoom_out_path_from`, `_zoom_out_path_to`; calls `memory_structural_impact` via the `structural-impact-reader`, `memory_neighbors`, `memory_path`, `memory_graph_ready`, `memory_recall`).

If Memory is absent, unavailable, uninitialized, errors, or returns no context, continue through ordinary codebase exploration. Verify any recalled claim against current files before relying on it. If Memory is in graph mode but `memory_graph_ready` is false, continue through ordinary codebase exploration; mention `/memory:ingest` in **Risks/Gaps** only when indexing would materially improve future zoom-out work.

When the focused area is a likely change target and graph reads are available, consult the `structural-impact-reader` through `memory_structural_impact` before falling back to ordinary codebase exploration for the structural side of **Impact**. If it prints evidence, translate it into map-first prose about imports, importers, definitions, and containing files, then verify any correctness-affecting claim against the current worktree before including it. If it prints nothing, reports no structural impact, fails, Memory is markdown-only, or Memory is absent, behave identically to today's ad-hoc file-reading path.

If the user names a focused area and graph neighbors are available through `memory_neighbors`, interpret neighbor evidence into the **Relationships** section after verifying against current files. If `memory_neighbors` prints nothing or fails, continue with ordinary codebase exploration.

If the user asks about the relationship between two explicit project elements, use `memory_path` as optional graph evidence for the **Critical Paths** section, then verify against current files. If `memory_path` prints nothing, reports no path, fails, or graph reads are unavailable, continue through ordinary codebase exploration.

When the focused area is a likely change target and graph reads are available, `memory_neighbors` and `memory_recall` also surface **Reasoning workers** recorded by AFK — fold this evidence into the **Observed impact** sub-bullet per the Answer Contract below. If no attempt evidence is present, surfaced, or relevant, drop the sub-bullet silently.

</what-to-do>

<supporting-info>

## Answer Contract

The entire `zoom-out` answer is read-only. Do not run ingest, reindex, graph writes, memory stores, or any mutation from `zoom-out`, in the **Impact** section or anywhere else.

Start with the map, not raw graph output. Use this order:

1. **Modules/Layers** - the relevant modules, layers, skills, scripts, services, or packages and their responsibilities.
2. **Relationships** - the callers, dependencies, data/control flow, ownership boundaries, and how the pieces fit.
3. **Impact** *(optional — include when the user's focus is a file, symbol, module, skill, or concept that may change)* - the impact surface of that focused target, expressed in project terms. When evidence for both kinds is available, **separate structural impact from observed impact explicitly**:
   - **Structural impact** — what the codebase says today about the target: **imports**, **calls**, **containment** (module/package/skill membership), **type-use** (symbols referenced through type positions), **docs links** (referencing markdown/SKILL.md/CONTEXT/ADR), and **graph neighbors/paths** for the target. Every claim must be **verified against the current worktree** (current file relationships, current imports, current call sites) before it lands in the answer.
   - **Observed impact** — what prior **Reasoning workers** recorded by AFK show happened operationally around this target: files **touched together** with it across workers, **repeated** blocked / no-sentinel / merge-conflict workers, **retry chains** that led to (or away from) a successful worker, and **validation summaries** attached to those workers. Describe this as **operational history**, not authoritative product direction or acceptance criteria — it is evidence of what tends to break, retry, or co-change, not a spec. Verify any observed claim that affects the answer against the current worktree before relying on it.

   Interpret graph or recall evidence into project terms — do **not** paste raw nodes, edges, paths, recall output, worker records, or `memory_*` command output. If Memory is absent, stale, empty, failing, or has no relevant workers for this target, **degrade cleanly**: drop the Observed impact sub-bullet and answer from structural impact alone; if structural evidence is also absent, answer from ordinary code reads and mention indexing only as a risk/gap in **Risks/Gaps** when materially useful. This section is **read-only**: it must not run `/memory:ingest`, reindex, or any graph-write or memory-write command, and it must not create or reference a new `/impact` skill or a `memory_impact` primitive.
4. **Critical Paths** - the workflows or execution paths that matter most for the user's question or planned change.
5. **Risks/Gaps** - missing context, stale indexing, unclear ownership, brittle areas, test gaps, or change hazards.

Use project glossary terms for names and concepts. Do not lead with a graph dump, raw nodes/edges, raw neighbor output, or unprocessed recall output; graph or Memory evidence can support the map after the structure is clear.

</supporting-info>
