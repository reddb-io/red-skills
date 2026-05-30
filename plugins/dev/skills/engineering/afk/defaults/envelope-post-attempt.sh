#!/usr/bin/env bash
# envelope-post-attempt.sh — built-in post_attempt default (PRD #207, issue
# #212; renamed from post_worker in #226).
#
# Reconciles the iteration's intermediate envelope state on the AFK state
# file as soon as the runner returns — before any user `post_attempt` hook
# runs, so a user notifier/pager integration that reads state already sees
# the worker's terminal result classified.
#
# Contract:
#   stdin   — JSON object: post_attempt context with `.result.status` of
#             "success" or "fail".
#   stdout  — empty (context unchanged). Pure side-effect on the state file.
#   exit    — 0. Never aborts the chain.
#
# Env contract (set by afk.sh before dispatch):
#   RED_AFK_STATE_FILE      — path to the iteration's afk.state.json;
#                             when unset/missing, the default is a no-op.
#   RED_AFK_RESULT_STATUS   — redundant fallback for tests / runners that
#                             can't shape a ctx; if ctx.result.status is
#                             absent the env var is used instead.
#
# Disable with `afk.hooks.defaults.envelope: false` in `.red/config.yaml`.

set -uo pipefail

ctx="$(cat || true)"

state_file="${RED_AFK_STATE_FILE:-}"
[[ -z "$state_file" || ! -f "$state_file" ]] && exit 0

status=""
if [[ -n "$ctx" ]]; then
  status="$(printf '%s' "$ctx" | jq -r '.result.status // empty' 2>/dev/null || true)"
fi
[[ -z "$status" ]] && status="${RED_AFK_RESULT_STATUS:-}"
[[ -z "$status" ]] && exit 0

tmp="${state_file}.tmp.$$"
if jq --arg s "$status" '.current = ((.current // {}) + {result_status: $s})' \
     "$state_file" > "$tmp" 2>/dev/null; then
  mv "$tmp" "$state_file"
else
  rm -f "$tmp"
fi

exit 0
