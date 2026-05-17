#!/usr/bin/env bash
# /afk monitor — readonly status board. Globs .red/tmp/work-*/afk.state.json
# (one file per live iteration) and renders one section per worker. Safe to run
# in a second terminal while afk.sh runs.
#
# Usage: monitor.sh [project_root]

set -eo pipefail

PROJECT_ROOT="${1:-$(pwd)}"
TMP_DIR="$PROJECT_ROOT/.red/tmp"

fmt_dur() {
  local s=$1
  printf '%02d:%02d:%02d' $((s/3600)) $(((s%3600)/60)) $((s%60))
}

render_worker() {
  local state_file="$1"
  local iter_dir; iter_dir="$(dirname "$state_file")"
  local pid_file="$iter_dir/afk.pid"
  local state; state="$(cat "$state_file" 2>/dev/null || echo '{}')"

  local worker_id pid alive runner total done blocked failed started
  local current_n current_title current_stage current_glyph current_worktree current_last
  worker_id="$(jq -r '.worker_id // "?"' <<<"$state")"
  pid="$(cat "$pid_file" 2>/dev/null || echo '')"
  alive="dead"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive="live"
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
  local avg_s remaining_eta=0
  avg_s="$(jq -r '.durations_seconds | if length > 0 then (add / length | floor) else 0 end' <<<"$state")"
  [[ "$avg_s" -gt 0 ]] && remaining_eta=$(( (total - done) * avg_s ))

  local status_tag="$alive"
  [[ "$alive" == "dead" ]] && status_tag="stale"

  printf '┌─ worker %s [%s] ────────────────────────────────────┐\n' "$worker_id" "$status_tag"
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
  printf '└────────────────────────────────────────────────────────────┘\n'
}

render() {
  command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }
  clear
  local states=( "$TMP_DIR"/work-*/afk.state.json )
  if [[ ! -e "${states[0]}" ]]; then
    echo "no live iterations under $TMP_DIR/work-*/ — /afk not running here?"
    return
  fi
  for sf in "${states[@]}"; do render_worker "$sf"; done
}

while true; do
  render
  sleep 3
done
