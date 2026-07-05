#!/usr/bin/env bash
# Graph-mode memory plumbing for zoom-out.
# Source only; do not execute directly. Called by zoom-out Gather Context
# when Memory is available. All reads only — no writes, no ingest, no reindex.

_zoom_out_focus_label="<skill/module/file/concept label from the user's request, or empty>"
_zoom_out_path_from="<first explicitly named skill/module/file/concept, or empty>"
_zoom_out_path_to="<second explicitly named skill/module/file/concept, or empty>"
_zoom_out_target_file="<focused file path when the user's request names one, or empty>"
_zoom_out_target_symbol="<focused symbol name when the user's request names one, or empty>"
if { [ -f .red/config.yaml ] && grep -qE '^[[:space:]]+memory:' .red/config.yaml; } || [ -f .red/memory/config.json ]; then
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
        if [ -n "$_zoom_out_target_file" ] || [ -n "$_zoom_out_target_symbol" ]; then
          memory_structural_impact . "$_zoom_out_target_file" "$_zoom_out_target_symbol"
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
