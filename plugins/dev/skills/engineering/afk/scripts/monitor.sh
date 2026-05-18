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

# ANSI colours. Respect NO_COLOR (https://no-color.org). Otherwise emit
# unconditionally — Claude Code / Codex agent transcripts render ANSI.
if [[ -z "${NO_COLOR:-}" ]]; then
  C_RESET=$'\033[0m'
  C_BOLD=$'\033[1m'
  C_DIM=$'\033[2m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_MAGENTA=$'\033[35m'
  C_CYAN=$'\033[36m'
  C_GRAY=$'\033[90m'
else
  C_RESET="" C_BOLD="" C_DIM="" C_RED="" C_GREEN="" C_YELLOW=""
  C_BLUE="" C_MAGENTA="" C_CYAN="" C_GRAY=""
fi

# Colour a progress percentage by stage of completion.
color_pct() {
  local p="$1"
  if   (( p >= 100 )); then printf '%s' "$C_GREEN"
  elif (( p >=  66 )); then printf '%s' "$C_CYAN"
  elif (( p >=  33 )); then printf '%s' "$C_YELLOW"
  else                      printf '%s' "$C_RED"
  fi
}

color_status() {
  case "$1" in
    live)   printf '%s' "$C_GREEN" ;;
    stale)  printf '%s' "$C_YELLOW" ;;
    dead)   printf '%s' "$C_RED" ;;
    parked) printf '%s' "$C_RED$C_BOLD" ;;
    *)      printf '%s' "$C_GRAY" ;;
  esac
}

# Render one row per parked slot from the supervisor's circuit state file.
# Emits nothing when the file is absent or has no parked entries — so
# pre-#12 fleets and healthy fleets are unaffected.
render_parked_slots() {
  local circuit_file="$TMP_DIR/afk-supervisor-circuit.json"
  [[ -f "$circuit_file" ]] || return 0
  local rows; rows="$(jq -c '.parked[]?' "$circuit_file" 2>/dev/null || true)"
  [[ -z "$rows" ]] && return 0
  local row slot count last
  while IFS= read -r row; do
    [[ -z "$row" ]] && continue
    slot="$(jq -r '.slot' <<<"$row")"
    count="$(jq -r '.fast_deaths' <<<"$row")"
    last="$(jq -r '.last_death_at // "?"' <<<"$row")"
    printf '%sslot-%s%s %s[⛔ parked]%s  %sfast_deaths=%s last_death=%s%s  %srun /dev:afk fleet stop & relaunch to clear%s\n' \
      "$C_CYAN$C_BOLD" "$slot" "$C_RESET" \
      "$(color_status parked)" "$C_RESET" \
      "$C_DIM" "$count" "$last" "$C_RESET" \
      "$C_DIM" "$C_RESET"
  done <<<"$rows"
}

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

# Fleet supervisor header — single line summarising supervisor state. Emits
# nothing when no PID file exists (so non-fleet usage is unaffected).
# Format (live):  🛡️ supervisor pid={pid} target={N} alive={M}/{N}
# Format (stale): ⚠️ supervisor pid={pid} STALE — run /dev:afk fleet stop to clean up
render_fleet_header() {
  local pid_file="$TMP_DIR/afk-supervisor.pid"
  [[ -f "$pid_file" ]] || return 0
  local pid; pid="$(cat "$pid_file" 2>/dev/null || true)"
  [[ -z "$pid" ]] && return 0
  if ! kill -0 "$pid" 2>/dev/null; then
    printf '%s⚠️  supervisor pid=%s STALE — run /dev:afk fleet stop to clean up%s\n' \
      "$C_YELLOW$C_BOLD" "$pid" "$C_RESET"
    return 0
  fi
  local log_file="$TMP_DIR/afk-supervisor.log"
  local target=""
  if [[ -f "$log_file" ]]; then
    target="$(grep -oE 'target=[0-9]+' "$log_file" | tail -n 1 | cut -d= -f2)"
  fi
  [[ -z "$target" ]] && target="?"
  # Count live workers by walking the latest "slot N: spawned worker pid=PID"
  # entry per slot in the supervisor log and probing kill -0. Supervisor log
  # is canonical: it records every (re)spawn, last entry per slot wins.
  local alive=0
  if [[ -f "$log_file" && "$target" != "?" ]]; then
    local i slot_pid
    for ((i=0; i<target; i++)); do
      slot_pid="$(grep -oE "slot $i: spawned worker pid=[0-9]+" "$log_file" \
                  | tail -n 1 | grep -oE '[0-9]+$' || true)"
      [[ -n "$slot_pid" ]] && kill -0 "$slot_pid" 2>/dev/null && alive=$((alive+1))
    done
  fi
  printf '%s🛡️  supervisor pid=%s target=%s alive=%s/%s%s\n' \
    "$C_BOLD$C_GREEN" "$pid" "$target" "$alive" "$target" "$C_RESET"
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

  printf '%s48h:%s %s%s%s  %s(%s%s%d closed%s%s, peak %s%s%d/h%s%s, all workers)%s\n' \
    "$C_BOLD"  "$C_RESET" \
    "$C_CYAN"  "$bar"   "$C_RESET" \
    "$C_DIM"   "$C_RESET" "$C_BOLD" "$total" "$C_RESET" "$C_DIM" \
    "$C_RESET" "$C_BOLD" "$max"   "$C_RESET" "$C_DIM" \
    "$C_RESET"
}

# Colour a "+N -M" diff string: + in green, - in red.
colorize_diff() {
  local raw="$1"
  [[ -z "$raw" ]] && return 0
  local ins del
  ins="${raw#+}"; ins="${ins%% *}"
  del="${raw##*-}"
  printf '%s+%s%s %s-%s%s' "$C_GREEN" "$ins" "$C_RESET" "$C_RED" "$del" "$C_RESET"
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
  # Per-iteration elapsed: prefer .current.started_at (set on each claim)
  # over .started_at (worker-process start, cumulative across N issues).
  # The worker-level field made elapsed look like 4h21m when the current
  # iteration was actually 30 min old.
  started="$(jq -r '.current.started_at // .started_at // ""' <<<"$state")"

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
  local s_col; s_col="$(color_status "$status_tag")"
  local p_col; p_col="$(color_pct "$pct")"

  local flags=""
  [[ $blocked -gt 0 ]] && flags+=" ${C_RED}${C_BOLD}blk:${blocked}${C_RESET}"
  [[ $failed  -gt 0 ]] && flags+=" ${C_RED}${C_BOLD}fail:${failed}${C_RESET}"

  local diff_stat=""
  local diff_ins=0
  if [[ -n "$current_worktree" && "$current_worktree" != "null" ]]; then
    local wt_abs="$current_worktree"
    [[ "$wt_abs" != /* ]] && wt_abs="$PROJECT_ROOT/$current_worktree"
    local ds; ds="$(worktree_diff_stats "$wt_abs")"
    if [[ -n "$ds" ]]; then
      diff_stat="  $(colorize_diff "$ds")"
      diff_ins="$(echo "$ds" | grep -oE '\+[0-9]+' | head -1 | tr -d +)"
      diff_ins="${diff_ins:-0}"
    fi
  fi

  # Stall heuristic: if the inner agent has been on this iteration for
  # >20 min, has written nothing to afk.log in the last 5 min, AND has
  # not added a single line in the worktree, surface a ⚠ stall marker.
  # Mirrors the bash-hang detection the watchdog catches later; the goal
  # here is *visibility* before the orchestrator kills it.
  local stall_warn=""
  local log_file="$iter_dir/afk.log"
  if (( elapsed > 1200 )) && (( diff_ins == 0 )); then
    local now_s log_mtime delta
    now_s="$(date +%s)"
    log_mtime=0
    [[ -f "$log_file" ]] && log_mtime="$(stat -c %Y "$log_file" 2>/dev/null || echo 0)"
    delta=$(( now_s - log_mtime ))
    if (( log_mtime > 0 && delta > 300 )); then
      stall_warn=" ${C_YELLOW}${C_BOLD}⚠ stalled?${C_RESET}${C_DIM} log idle ${delta}s${C_RESET}"
    elif (( log_mtime == 0 )); then
      stall_warn=" ${C_YELLOW}${C_BOLD}⚠ no log${C_RESET}${C_DIM} (upgrade to v1.10.1+)${C_RESET}"
    fi
  fi

  # Tail of afk.log: most recent non-empty line, trimmed to 60 chars.
  local log_tail=""
  if [[ -f "$log_file" && -s "$log_file" ]]; then
    log_tail="$(tail -n 1 "$log_file" 2>/dev/null | tr -d '\r' | sed 's/[[:space:]]*$//' | cut -c1-60)"
    [[ -n "$log_tail" ]] && log_tail="  ${C_DIM}| ${log_tail}${C_RESET}"
  fi

  local cur=""
  if [[ "$current_n" != "-" && "$current_n" != "null" ]]; then
    local title_trim="${current_title:0:48}"
    cur="  ${C_BOLD}#${current_n}${C_RESET} ${title_trim}  ${C_MAGENTA}stage:${current_stage}${C_RESET}  ${C_DIM}$(fmt_dur $elapsed)${C_RESET}${diff_stat}${stall_warn}${log_tail}"
  else
    cur="  ${C_DIM}idle${C_RESET}"
  fi

  printf '%s%s%s %s[%s]%s %s%s%s  %s%d%s/%d (%s%d%%%s)%s%s\n' \
    "$C_CYAN${C_BOLD}" "$worker_id" "$C_RESET" \
    "$s_col" "$status_tag" "$C_RESET" \
    "$C_DIM" "$runner" "$C_RESET" \
    "$p_col" "$done" "$C_RESET" "$total" \
    "$p_col" "$pct" "$C_RESET" \
    "$flags" "$cur"
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
  # Per-iteration elapsed; see render_worker_compact for the rationale.
  started="$(jq -r '.current.started_at // .started_at // ""' <<<"$state")"
  current_n="$(jq -r '.current.number // "-"' <<<"$state")"
  current_title="$(jq -r '.current.title // "-"' <<<"$state")"
  current_stage="$(jq -r '.current.stage // "-"' <<<"$state")"
  current_glyph="$(jq -r '.current.heartbeat_glyph // ""' <<<"$state")"
  current_worktree="$(jq -r '.current.worktree // "-"' <<<"$state")"
  current_last="$(jq -r '.current.last_stream_line // ""' <<<"$state")"
# Prefer the live tail of afk.log over the state field (which the
# orchestrator does not currently maintain). Falls back to state if
# the log is empty/missing.
if [[ -f "$iter_dir/afk.log" ]]; then
  local log_tail
  log_tail="$(tail -n 1 "$iter_dir/afk.log" 2>/dev/null | tr -d '\r' | sed 's/[[:space:]]*$//')"
  [[ -n "$log_tail" ]] && current_last="$log_tail"
fi

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
  local s_col; s_col="$(color_status "$status_tag")"
  local p_col; p_col="$(color_pct "$pct")"
  local b="$C_GRAY"  # box borders
  local r="$C_RESET"

  local blk_col="$C_GREEN"; [[ $blocked -gt 0 ]] && blk_col="$C_RED$C_BOLD"
  local fail_col="$C_GREEN"; [[ $failed  -gt 0 ]] && fail_col="$C_RED$C_BOLD"

  printf '%s┌─%s worker %s%s%s %s[%s%s%s]%s %s────────────────────────────────────┐%s\n' \
    "$b" "$r" "$C_CYAN$C_BOLD" "$worker_id" "$r" "$b" "$r" "$s_col$status_tag" "$r" "$b" "$b" "$r"
  printf '%s│%s runner: %s%-10s%s elapsed: %s%s%s   eta: ~%s%s%s %s│%s\n' \
    "$b" "$r" "$C_DIM" "$runner" "$r" "$C_DIM" "$(fmt_dur $elapsed)" "$r" "$C_DIM" "$(fmt_dur $remaining_eta)" "$r" "$b" "$r"
  printf '%s│%s done: %s%-3d%s / %-3d (%s%-3d%%%s)   blocked: %s%-3d%s   failed: %s%-3d%s     %s│%s\n' \
    "$b" "$r" "$p_col" "$done" "$r" "$total" "$p_col" "$pct" "$r" "$blk_col" "$blocked" "$r" "$fail_col" "$failed" "$r" "$b" "$r"
  printf '%s│%s\n' "$b" "$r"
  if [[ "$current_n" != "-" && "$current_n" != "null" ]]; then
    printf '%s│%s %s▶ #%s%s %s\n' "$b" "$r" "$C_BOLD" "$current_n" "$r" "${current_title:0:50}"
    printf '%s│%s   worktree: %s%s%s\n' "$b" "$r" "$C_DIM" "${current_worktree:0:55}" "$r"
    printf '%s│%s   stage: %s%-12s%s heartbeat: %s\n' "$b" "$r" "$C_MAGENTA" "$current_stage" "$r" "$current_glyph"
    local wt_abs="$current_worktree"
    [[ -n "$wt_abs" && "$wt_abs" != "null" && "$wt_abs" != /* ]] && wt_abs="$PROJECT_ROOT/$current_worktree"
    local diff_stat=""
    [[ -n "$wt_abs" && "$wt_abs" != "null" ]] && diff_stat="$(worktree_diff_stats "$wt_abs")"
    [[ -n "$diff_stat" ]] && printf '%s│%s   diff: %s %s(vs main, committed + uncommitted)%s\n' \
      "$b" "$r" "$(colorize_diff "$diff_stat")" "$C_DIM" "$r"
    [[ -n "$current_last" && "$current_last" != "null" ]] && \
      printf '%s│%s   last: %s%s%s\n' "$b" "$r" "$C_DIM" "${current_last:0:55}" "$r"
  else
    printf '%s│%s %s(no issue in progress)%s\n' "$b" "$r" "$C_DIM" "$r"
  fi
  printf '%s└────────────────────────────────────────────────────────────┘%s\n' "$b" "$r"
}

render_full() {
  clear
  render_fleet_header
  render_sparkline
  echo
  local states=( "$TMP_DIR"/work-*/afk.state.json )
  if [[ ! -e "${states[0]}" ]]; then
    echo "no live iterations under $TMP_DIR/work-*/ — /afk not running here?"
  else
    for sf in "${states[@]}"; do render_worker "$sf"; done
  fi
  render_parked_slots
}

render_compact() {
  # Directive for agent renderers (Claude Code, Codex) that capture this
  # output and paraphrase it for the user. Plain prose — no `#` prefix —
  # so it reads as instructional content, not as a comment the agent
  # might silently strip. ANSI escapes get lost on paraphrase, so the
  # text spells out both layout and colour mapping.
  cat <<'EOF'
=== /afk monitor — agent rendering contract ===
When you summarise the lines below for the user, follow these rules verbatim. Treat them as part of the output, not as metadata to skip.

1. ALWAYS include the "48h: …" sparkline line as the first line of your summary. Reproduce the bar, "(N closed, peak M/h, all workers)" suffix included. It is the at-a-glance throughput signal and must not be dropped even when worker activity is more salient.
2. ALWAYS include every worker line, one per worker, in the original order. Do not collapse, drop, or merge workers.
3. Preserve the colour cues. Map: [live]=green, [stale]=yellow, [dead]=red, [⛔ parked]=red bold, blk:N/fail:N=red bold, progress percent — 0-33 red / 33-66 yellow / 66-99 cyan / 100 green, diff +N=green / -M=red, worker id cyan+bold, stage:X magenta, elapsed dim, ⚠ stalled?/⚠ no log warnings yellow bold. Render via markdown (bold, code spans, emoji squares 🟢🟡🔴⛔ if needed) when ANSI is unavailable. Keep tag spelling and column order intact.
4. When a worker line carries a `| <text>` suffix, it is the most recent line written to that worker's afk.log — surface it verbatim (truncated as the script already truncated it). It is the single most useful "is the inner agent alive" signal; do not drop it.
5. When a worker line carries `⚠ stalled? log idle Ns`, repeat the warning verbatim and recommend the user run the bash-hang diagnostic from afk/SKILL.md (`pstree -p <orchestrator-pid>`, look for `until.*test result` cmdline). `⚠ no log` means the worker was spawned with v1.10.0 or earlier — recommend upgrading to v1.10.1+ for log tee, or v1.14.2+ for the full set of fixes.
6. Lines beginning `slot-N [⛔ parked]` mean the fleet supervisor tripped its per-slot circuit breaker (≥5 fast worker deaths within 90s). Always surface them — they explain why the fleet shrank below target. Recommend `/dev:afk fleet stop` followed by a relaunch to clear the parked state, and tell the user to investigate the runner before relaunching.

=== begin dashboard ===
EOF
  render_fleet_header
  render_sparkline
  local states=( "$TMP_DIR"/work-*/afk.state.json )
  if [[ ! -e "${states[0]}" ]]; then
    echo "workers: (none — /afk not running here)"
  else
    for sf in "${states[@]}"; do render_worker_compact "$sf"; done
  fi
  render_parked_slots
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
