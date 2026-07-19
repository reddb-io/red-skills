#!/usr/bin/env bash
# heartbeat-post-attempt.sh — built-in post_attempt default (PRD #207, issue
# #212; renamed from post_worker in #226).
#
# Contract:
#   stdin   — JSON object: post_attempt context (issue, workspace, result).
#   stdout  — empty (context unchanged). The default is a pure side-effect:
#             it stops the orchestrator's per-minute heartbeat side-channel
#             and writes the "iteration stopped" boundary marker into the
#             iteration log, migrating the inline `heartbeat_stop` that
#             used to fire from afk.sh right after `run_inner` returned.
#   exit    — 0. Never aborts the post_attempt chain (the dispatcher already
#             routes post_attempt rc through `continue` policy, but the
#             default also belt-and-braces this with a 0 exit).
#
# Env contract (set by afk.sh before dispatch):
#   RED_AFK_HEARTBEAT_PID — pid of the orchestrator heartbeat sub-shell;
#                           empty when no heartbeat was started for this
#                           iteration (smoke paths). Killing a stale pid
#                           is a no-op via `kill -0` guard.
#   RED_AFK_ITER_LOG      — path to the iteration log; the boundary line
#                           is appended only when the file exists.
#
# Disable with `afk.hooks.defaults.heartbeat: false` in `.red/config.yaml`.

set -uo pipefail

# Drain stdin (context flows through unchanged — emit nothing).
timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat >/dev/null 2>&1 || true

pid="${RED_AFK_HEARTBEAT_PID:-}"
if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
  kill "$pid" 2>/dev/null || true
  # Best-effort reap; the sub-shell may already be exiting.
  wait "$pid" 2>/dev/null || true
fi

iterlog="${RED_AFK_ITER_LOG:-}"
if [[ -n "$iterlog" && -f "$iterlog" ]]; then
  printf '[heartbeat] iteration stopped at %s\n' "$(date -Is)" >> "$iterlog"
fi

exit 0
