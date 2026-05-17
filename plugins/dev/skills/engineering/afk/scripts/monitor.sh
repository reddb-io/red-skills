#!/usr/bin/env bash
# /afk monitor — readonly status board. Globs .red/tmp/work-*/afk.state.json
# (one file per live iteration) and renders one section per worker.
#
# Two modes, auto-selected by stdout type:
#   - TTY (real terminal): full box-drawing layout, refreshes every 3 s. Ctrl-C exits.
#   - Non-TTY (piped, captured by an agent, redirected): one-shot compact dashboard,
#     one line per worker, then exit 0. Force this with --once or MONITOR_COMPACT=1.
#
# Usage: monitor.sh [--once] [project_root]

set -eo pipefail

ONCE=0
[[ "${1:-}" == "--once" ]] && { ONCE=1; shift; }
[[ "${MONITOR_COMPACT:-0}" == "1" ]] && ONCE=1
[[ -t 1 ]] || ONCE=1   # not a TTY → one-shot compact

PROJECT_ROOT="${1:-$(pwd)}"
TMP_DIR="$PROJECT_ROOT/.red/tmp"
HISTORY_FILE="$PROJECT_ROOT/.red/state/afk-history.jsonl"

fmt_dur() {
  local s=$1
  printf '%02d:%02d:%02d' $((s/3600)) $(((s%3600)/60)) $((s%60))
}

# Diff stats for a worktree branch vs main. Captures committed + uncommitted
# changes so the number reflects "live progress" of the in-flight issue.
# Output: "+ADD -DEL" or "" on any failure (worktree missing, not a repo, etc).
worktree_diff_stats() {
  local worktree="$1"
  [[ -d "$worktree/.git" || -f "$worktree/.git" ]] || return 0
  local stat
  stat="$(git -C "$worktree" diff --shortstat main 2>/dev/null)" || return 0
  [[ -z "$stat" ]] && { printf '+0 -0'; return; }
  local ins del
  ins="$(grep -oE '[0-9]+ insertion' <<<"$stat" | grep -oE '[0-9]+' || echo 0)"
  del="$(grep -oE '[0-9]+ deletion'  <<<"$stat" | grep -oE '[0-9]+' || echo 0)"
  printf '+%s -%s' "${ins:-0}" "${del:-0}"
}

# 48h sparkline of `done` events per hour. 48 buckets, scaled to peak.
render_sparkline() {
  [[ -f "$HISTORY_FILE" ]] || { echo "history: (none yet — first /afk run will start it)"; return; }

  local now_s; now_s="$(date +%s)"
  local floor_h=$(( now_s / 3600 ))
  local from_h=$(( floor_h - 47 ))
  local from_s=$(( from_h * 3600 ))

  # bucket counts via jq — single pass.
  # output: 48 space-separated integers (oldest → newest).
  local counts_line
  counts_line="$(jq -rs --argjson from "$from_h" '
    map(select(.event == "done"))
    | map((.epoch / 3600 | floor) - $from)
    | map(select(. >= 0 and . < 48))
    | reduce .[] as $b ([range(48) | 0]; .[$b] += 1)
    | join(" ")
  ' "$HISTORY_FILE" 2>/dev/null || echo "")"
  [[ -z "$counts_line" ]] && { echo "history: (parse error)"; return; }

  local counts=( $counts_line )
  local max=0 v total=0
  for v in "${counts[@]}"; do
    (( v > max )) && max=$v
    total=$((total+v))
  done
  (( max == 0 )) && max=1

  local glyphs=('·' '▁' '▂' '▃' '▄' '▅' '▆' '▇' '█')
  local bar="" idx
  for v in "${counts[@]}"; do
    idx=$(( v * 8 / max ))
    bar+="${glyphs[$idx]}"
  done

  printf '48h: %s  (%d closed, peak %d/h, all workers)\n' "$bar" "$total" "$max"
}

# Compact one-line worker summary for non-TTY / inline-agent output.
render_worker_compact() {
  local state_file="$1"
  local iter_dir; iter_dir="$(dirname "$state_file")"
  local pid_file="$iter_dir/afk.pid"
  local state; state="$(cat "$state_file" 2>/dev/null || echo '{}')"

  local worker_id pid alive runner total done blocked failed
  local current_n current_title current_stage current_worktree started elapsed
  worker_id="$(jq -r '.worker_id // "?"' <<<"$state")"
  pid="$(cat "$pid_file" 2>/dev/null || echo '')"
  alive="dead"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null && alive="live"
  runner="$(jq -r '.runner // "-"' <<<"$state")"
  total="$(jq -r '.total // 0' <<<"$state")"
  done="$(jq -r '.done // 0' <<<"$state")"
  blocked="$(jq -r '.blocked // 0' <<<"$state")"
  failed="$(jq -r '.failed // 0' <<<"$state")"
  current_n="$(jq -r '.current.number // "-"' <<<"$state")"
  current_title="$(jq -r '.current.title // "-"' <<<"$state")"
  current_stage="$(jq -r '.current.stage // "-"' <<<"$state")"
  current_worktree="$(jq -r '.current.worktree // ""' <<<"$state")"
  started="$(jq -r '.started_at // ""' <<<"$state")"

  elapsed=0
  if [[ -n "$started" ]]; then
    local s_epoch n_epoch
    s_epoch="$(date -d "$started" +%s 2>/dev/null || echo 0)"
    n_epoch="$(date +%s)"
    elapsed=$(( n_epoch - s_epoch ))
  fi
  local pct=0
  [[ $total -gt 0 ]] && pct=$(( done * 100 / total ))
  local status_tag="$alive"
  [[ "$alive" == "dead" ]] && status_tag="stale"
  local flags=""
  [[ $blocked -gt 0 ]] && flags+=" blk:$blocked"
  [[ $failed  -gt 0 ]] && flags+=" fail:$failed"

  local diff_stat=""
  if [[ -n "$current_worktree" && "$current_worktree" != "null" ]]; then
    local wt_abs="$current_worktree"
    [[ "$wt_abs" != /* ]] && wt_abs="$PROJECT_ROOT/$current_worktree"
    local ds; ds="$(worktree_diff_stats "$wt_abs")"
    [[ -n "$ds" ]] && diff_stat="  $ds"
  fi

  local cur=""
  if [[ "$current_n" != "-" && "$current_n" != "null" ]]; then
    local title_trim="${current_title:0:48}"
    cur="  #${current_n} ${title_trim}  stage:${current_stage}  $(fmt_dur $elapsed)${diff_stat}"
  else
    cur="  idle"
  fi

  printf '%s [%s] %s  %d/%d (%d%%)%s%s\n' \
    "$worker_id" "$status_tag" "$runner" "$done" "$total" "$pct" "$flags" "$cur"
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
    local wt_abs="$current_worktree"
    [[ -n "$wt_abs" && "$wt_abs" != "null" && "$wt_abs" != /* ]] && wt_abs="$PROJECT_ROOT/$current_worktree"
    local diff_stat=""
    [[ -n "$wt_abs" && "$wt_abs" != "null" ]] && diff_stat="$(worktree_diff_stats "$wt_abs")"
    [[ -n "$diff_stat" ]] && printf '│   diff: %s (vs main, committed + uncommitted)\n' "$diff_stat"
    [[ -n "$current_last" && "$current_last" != "null" ]] && \
      printf '│   last: %s\n' "${current_last:0:55}"
  else
    printf '│ (no issue in progress)\n'
  fi
  printf '└────────────────────────────────────────────────────────────┘\n'
}

render_full() {
  clear
  render_sparkline
  echo
  local states=( "$TMP_DIR"/work-*/afk.state.json )
  if [[ ! -e "${states[0]}" ]]; then
    echo "no live iterations under $TMP_DIR/work-*/ — /afk not running here?"
    return
  fi
  for sf in "${states[@]}"; do render_worker "$sf"; done
}

render_compact() {
  render_sparkline
  local states=( "$TMP_DIR"/work-*/afk.state.json )
  if [[ ! -e "${states[0]}" ]]; then
    echo "workers: (none — /afk not running here)"
    return
  fi
  for sf in "${states[@]}"; do render_worker_compact "$sf"; done
}

command -v jq >/dev/null || { echo "jq required" >&2; exit 2; }

if [[ $ONCE -eq 1 ]]; then
  render_compact
  exit 0
fi

while true; do
  render_full
  sleep 3
done
