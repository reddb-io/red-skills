#!/usr/bin/env bash
# /afk monitor — readonly status board. Reads .red/tmp/afk-state.json and
# renders a live header. Safe to run in a second terminal while afk.sh runs.
#
# Usage: monitor.sh [project_root]

set -eo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
STATE="$PROJECT_ROOT/.red/tmp/afk-state.json"

[[ -f "$STATE" ]] || { echo "no state file at $STATE — /afk not running here?" >&2; exit 1; }

fmt_dur() {
  local s=$1
  printf '%02d:%02d:%02d' $((s/3600)) $(((s%3600)/60)) $((s%60))
}

render() {
  command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
  local state; state="$(cat "$STATE")"

  local runner   total done blocked failed
  local started  current_n current_title current_stage current_glyph current_worktree current_last
  runner="$(jq -r '.runner // "-"' <<<"$state")"
  total="$(jq -r '.total // 0' <<<"$state")"
  done="$(jq -r '.done // 0' <<<"$state")"
  blocked="$(jq -r '.blocked // 0' <<<"$state")"
  failed="$(jq -r '.failed // 0' <<<"$state")"
  started="$(jq -r '.started_at // ""' <<<"$state")"

  current_n="$(jq -r '.current.number // "-"' <<<"$state")"
  current_title="$(jq -r '.current.title // "-"' <<<"$state")"
  current_stage="$(jq -r '.current.stage // "-"' <<<"$state")"
  current_glyph="$(jq -r '.current.heartbeat_glyph // ""' <<<"$state")"
  current_worktree="$(jq -r '.current.worktree // "-"' <<<"$state")"
  current_last="$(jq -r '.current.last_stream_line // ""' <<<"$state")"

  local elapsed=0
  if [[ -n "$started" ]]; then
    local s_epoch n_epoch
    s_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
    n_epoch="$(date +%s)"
    elapsed=$(( n_epoch - s_epoch ))
  fi

  local pct=0
  [[ $total -gt 0 ]] && pct=$(( done * 100 / total ))

  local avg=0 remaining_eta=0
  local avg_s
  avg_s="$(jq -r '.durations_seconds | if length > 0 then (add / length | floor) else 0 end' <<<"$state")"
  [[ "$avg_s" -gt 0 ]] && remaining_eta=$(( (total - done) * avg_s ))

  clear
  printf '┌─ /afk monitor ─────────────────────────────────────────────┐\n'
  printf '│ runner: %-10s elapsed: %s   eta: ~%s │\n' \
    "$runner" "$(fmt_dur $elapsed)" "$(fmt_dur $remaining_eta)"
  printf '│ done: %-3d / %-3d (%-3d%%)   blocked: %-3d   failed: %-3d         │\n' \
    "$done" "$total" "$pct" "$blocked" "$failed"
  printf '│\n'
  if [[ "$current_n" != "-" && "$current_n" != "null" ]]; then
    printf '│ ▶ #%s %s\n' "$current_n" "${current_title:0:50}"
    printf '│   worktree: %s\n' "${current_worktree:0:55}"
    printf '│   stage: %-12s heartbeat: %s\n' "$current_stage" "$current_glyph"
    [[ -n "$current_last" && "$current_last" != "null" ]] && \
      printf '│   last: %s\n' "${current_last:0:55}"
  else
    printf '│ (no issue in progress)\n'
  fi
  printf '│\n'
  local queue
  queue="$(jq -r '.queue // [] | map(tostring) | join(" #") | "#" + .' <<<"$state")"
  printf '│ queue: %s\n' "${queue:0:55}"
  printf '└────────────────────────────────────────────────────────────┘\n'
}

while true; do
  render
  sleep 3
done
