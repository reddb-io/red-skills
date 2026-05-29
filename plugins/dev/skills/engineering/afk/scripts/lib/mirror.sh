#!/usr/bin/env bash
# lib/mirror.sh — Task-mirror modules for the native task surface (issue #43).
#
# Read-only reflection of live AFK workers onto the runner's native task list.
# Three layers, two of them pure:
#
#   state-reader      mirror_read_workers <project_root>
#     Globs .red/tmp/workers/*/*/afk.state.json, verifies liveness via the state
#     file's .pid (the orchestrator $$; kill -0), and emits one normalized JSONL
#     record per worker that currently maps to a task. No harness coupling,
#     never writes state.
#
#   mirror-reconciler mirror_reconcile <desired_jsonl> <tracked_jsonl>
#     Pure diff. Given the desired worker set (from the reader) and the set of
#     currently-tracked tasks, emits create/update/complete operations keyed by
#     "worker_id:issue" so parallel workers each get one task and re-runs never
#     duplicate. No I/O.
#
#   sink mapping      mirror_plan <project_root> <tracked_jsonl>
#     Ties reader + reconciler together and maps each operation to a harness
#     call descriptor (TaskCreate / TaskUpdate) at a single mockable boundary.
#     The Claude Code sink (see SKILL.md "Task Mirror") consumes this plan and
#     applies the actual TaskCreate/TaskUpdate harness calls.
#
# Record shapes (JSONL, one object per line):
#   worker  {"worker_id","issue","title","stage","started_at","status"}
#             status: "running" (live, working an issue) | "gone" (pid dead) |
#                     "blocked" (terminal failure) — terminal = anything but running.
#   tracked {"key","stage"}                       key = "worker_id:issue"
#   op      {"op":"create|update|complete","key",...payload}
#   call    {"call":"TaskCreate|TaskUpdate","key",...payload}

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/state.sh"

# mirror_read_workers <project_root>
# Emits JSONL, one record per work dir that maps to a live or crashed task.
# A record is emitted only when the iteration carries a current issue number
# (an idle worker between issues owns no task). Liveness comes from the state
# file's .pid (the orchestrator $$), matching monitor.sh / statusline.sh via
# state_is_live. A preserved blocked attempt has its .pid zeroed by
# iter_close_preserve, so it reads not-live — the same effect the old
# per-attempt afk.pid removal had under the flat scheme.
mirror_read_workers() {
  local root="${1:-$(pwd)}"
  local tmp_dir="$root/.red/tmp"
  local state_file iter_dir live status started

  shopt -s nullglob
  for state_file in "$tmp_dir"/workers/*/*/afk.state.json; do
    [[ -f "$state_file" ]] || continue
    iter_dir="$(dirname "$state_file")"

    state_read_into _w "$state_file"

    # No current issue → no task to mirror (idle between issues, or torn down).
    [[ -n "$_w_current_number" && "$_w_current_number" != "null" ]] || continue

    live=0
    state_is_live "$state_file" && live=1

    if (( live )); then
      status="running"
    else
      # State still names an issue but the worker process is gone: the
      # iteration died mid-flight (crash / kill). Surface it terminal so the
      # mirror completes the stale task rather than leaving it spinning.
      status="gone"
    fi

    started="${_w_current_started_at:-$_w_started_at}"

    jq -nc \
      --arg worker_id "$_w_worker_id" \
      --argjson issue "$_w_current_number" \
      --arg title "$_w_current_title" \
      --arg stage "$_w_current_stage" \
      --arg started_at "$started" \
      --arg status "$status" \
      '{worker_id:$worker_id, issue:$issue, title:$title,
        stage:$stage, started_at:$started_at, status:$status}'
  done
}

# mirror_reconcile <desired_jsonl> <tracked_jsonl>
# Pure diff between the desired worker set and the tracked-task set. Both args
# are JSONL strings (newline-separated objects; empty string = empty set).
# Emits operation records as JSONL. Keyed by "worker_id:issue".
#
#   running worker, key absent from tracked  → create
#   running worker, key tracked, stage moved → update
#   running worker, key tracked, same stage  → (no-op, nothing emitted)
#   terminal worker (gone/blocked/done)      → complete  (if tracked)
#   tracked key with no desired worker       → complete  (worker dropped out)
#
# complete carries result: "failed" for a blocked terminal, else "completed".
mirror_reconcile() {
  local desired="$1" tracked="$2"
  jq -nc \
    --slurpfile _d <(printf '%s\n' "$desired" | jq -c 'select(type=="object")' 2>/dev/null) \
    --slurpfile _t <(printf '%s\n' "$tracked" | jq -c 'select(type=="object")' 2>/dev/null) \
    '
    ($_d | map({key: (.worker_id + ":" + (.issue|tostring)), v: .})) as $des
    | ($_t | map({key: .key, v: .}))                                as $trk
    | ($des | map(.key)) as $deskeys
    | ($trk | INDEX(.key) | map_values(.v)) as $trkmap
    | (
        # desired-driven ops
        $des[]
        | .v as $w
        | .key as $k
        | ($trkmap[$k]) as $cur
        | if ($w.status == "running") then
            if ($cur == null) then
              {op:"create", key:$k, worker_id:$w.worker_id, issue:$w.issue,
               title:$w.title, stage:$w.stage, status:"running"}
            elif ($cur.stage != $w.stage) then
              {op:"update", key:$k, worker_id:$w.worker_id, issue:$w.issue,
               title:$w.title, stage:$w.stage, status:"running"}
            else
              empty
            end
          else
            # terminal status reported by the reader
            if ($cur != null) then
              {op:"complete", key:$k, worker_id:$w.worker_id, issue:$w.issue,
               result: (if $w.status == "blocked" then "failed" else "completed" end)}
            else
              empty
            end
          end
      ),
      (
        # tracked tasks whose worker no longer appears at all → complete/drop
        $trk[]
        | select((.key) as $k | ($deskeys | index($k)) | not)
        | {op:"complete", key:.key, result:"completed"}
      )
    '
}

# mirror_plan <project_root> <tracked_jsonl>
# End-to-end: read live workers, reconcile against tracked tasks, then map each
# operation to a harness call descriptor at the single mockable boundary the
# Claude Code sink consumes. Emits JSONL of call descriptors.
#
#   create   → TaskCreate (in_progress) with title "#<issue> <worker> — <title>"
#   update   → TaskUpdate (in_progress) refreshing the stage line
#   complete → TaskUpdate with state completed | failed
#
# TaskUpdate descriptors reference the op key; the sink owns the key→task_id
# bookkeeping (the harness assigns the id at create time).
mirror_plan() {
  local root="${1:-$(pwd)}" tracked="${2:-}"
  local desired ops
  desired="$(mirror_read_workers "$root")"
  ops="$(mirror_reconcile "$desired" "$tracked")"
  printf '%s\n' "$ops" | jq -c 'select(type=="object")' 2>/dev/null | jq -c '
    if .op == "create" then
      {call:"TaskCreate", key:.key,
       title: ("#" + (.issue|tostring) + " " + .worker_id + " — " + .title),
       description: ("stage: " + .stage),
       state:"in_progress"}
    elif .op == "update" then
      {call:"TaskUpdate", key:.key,
       description: ("stage: " + .stage),
       state:"in_progress"}
    elif .op == "complete" then
      {call:"TaskUpdate", key:.key, state:.result}
    else empty end
  '
}

# ----------------------------------------------------------------------
# Codex sink (issue #45)
# ----------------------------------------------------------------------
#
# The sink is the only runner-specific layer (ADR 0003): mirror_read_workers and
# mirror_reconcile — and the mirror_plan that ties them together — are reused
# unchanged. The Claude Code sink lives in SKILL.md and applies the mirror_plan
# descriptors via the TaskCreate/TaskUpdate harness tools. The Codex sink below
# is its sibling. There is deliberately NO cross-runner abstraction (rejected in
# ADR 0003): each runner gets an explicit adapter.

# codex_native_task_available
# Single mockable boundary the Codex sink branches on: does this Codex expose a
# native background-task / progress surface the mirror can drive? Codex ships no
# such primitive today, so the honest default is "no" (returns non-zero). A future
# Codex that grows one — or a test — overrides this function to return 0.
codex_native_task_available() {
  return 1
}

# mirror_sink_codex <project_root> [tracked_jsonl]
# Codex half of the runner-specific Task-mirror sink. Two routes:
#
#   native surface available → print the call plan (mirror_plan) for the Codex
#     agent to apply against its primitive — the same descriptors the Claude sink
#     consumes, so the reader + reconciler are reused, never reimplemented.
#   no native surface (today) → fall back to the monitor.sh dashboard rendering
#     and emit a single notice line. No native call descriptors are emitted, so
#     there is no half-rendered state; a monitor.sh hiccup is swallowed so the
#     fallback never crashes the monitor tick.
#
# Always returns 0: the fallback is a clean degrade, not an error.
mirror_sink_codex() {
  local root="${1:-$(pwd)}" tracked="${2:-}"

  if codex_native_task_available; then
    mirror_plan "$root" "$tracked"
    return 0
  fi

  local monitor
  monitor="$(dirname "${BASH_SOURCE[0]}")/../monitor.sh"
  if [[ -f "$monitor" ]]; then
    RED_AFK_MONITOR_COMPACT=1 bash "$monitor" --once "$root" 2>/dev/null || true
  fi
  printf 'afk: Codex has no native task surface — mirroring via the monitor.sh dashboard instead.\n'
  return 0
}
