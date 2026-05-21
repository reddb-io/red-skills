#!/usr/bin/env bash
# /afk — autonomous loop that drains `ready-for-agent` issues.
#
# Usage:
#   afk.sh [--prd N | --issues N,N,N] [--runner claude|codex]
#          [--alternate] [--fallback-runner] [-n N] [--once] [project_root]
#
# Runner resolution cascade (when --runner is not set):
#   1. env-var sniff (CLAUDECODE / CLAUDE_CODE_*, CODEX_HOME / CODEX_SANDBOX*)
#   2. $BASH_SOURCE path sniff (~/.claude/... → claude, ~/.codex/... → codex)
#   3. env fallback (${RED_AFK_RUNNER:-claude})
#
# See ../SKILL.md for the full contract. SAFETY.md is binding.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# shellcheck source=./config.sh
source "$SCRIPT_DIR/config.sh"
# shellcheck source=./hooks.sh
source "$SCRIPT_DIR/hooks.sh"
# shellcheck source=./lib/state.sh
source "$SCRIPT_DIR/lib/state.sh"
# shellcheck source=./lib/merge.sh
source "$SCRIPT_DIR/lib/merge.sh"

# ---------- arg parsing ----------
RUNNER=""
ITER_CAP=999
ONCE=0
FILTER_KIND="all"
FILTER_VALUE=""
ALTERNATE_FLAG=0
FALLBACK_RUNNER_FLAG=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prd)              FILTER_KIND="prd";    FILTER_VALUE="$2"; shift 2 ;;
    --issues)           FILTER_KIND="issues"; FILTER_VALUE="$2"; shift 2 ;;
    --runner)           RUNNER="$2"; shift 2 ;;
    --alternate)        ALTERNATE_FLAG=1; shift ;;
    --fallback-runner)  FALLBACK_RUNNER_FLAG=1; shift ;;
    -n)                 ITER_CAP="$2"; shift 2 ;;
    --once)             ONCE=1; ITER_CAP=1; shift ;;
    -h|--help)          sed -n '2,13p' "$0"; exit 0 ;;
    *)                  PROJECT_ROOT="$1"; shift ;;
  esac
done

if [[ $ALTERNATE_FLAG -eq 1 && -n "$RUNNER" ]]; then
  echo "[afk] ERROR: --alternate and --runner are mutually exclusive" >&2
  exit 2
fi

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
REPO_NAME="$(basename "$PROJECT_ROOT")"
TMP_DIR="$PROJECT_ROOT/.red/tmp"
STATE_DIR="$PROJECT_ROOT/.red/state"
HISTORY_FILE="$STATE_DIR/afk-history.jsonl"
HISTORY_MAX_LINES=10000

# Worker ID — literal "w" + 4 chars from [A-Z0-9] (e.g. wZ2R4).
# Regenerated until no live .red/tmp/work-{id}-i*/afk.pid exists.
# Format is distinct from arbitrary directory globs so `work-w*-i*` reliably
# matches only AFK iteration dirs, and IDs stand out visually in logs.
gen_worker_id() {
  local id
  while :; do
    id="w$(LC_ALL=C tr -dc 'A-Z0-9' </dev/urandom | head -c 4)"
    [[ -z "$(ls -d "$TMP_DIR"/work-"$id"-i* 2>/dev/null)" ]] && { echo "$id"; return; }
  done
}
WORKER_ID=""        # set in bootstrap
ITER_DIR=""         # set per-iteration: $TMP_DIR/work-$WORKER_ID-i$N
STATE_FILE=""       # set per-iteration: $ITER_DIR/afk.state.json
ITER_LOG=""         # set per-iteration: $ITER_DIR/afk.log
ITER_PID_FILE=""    # set per-iteration: $ITER_DIR/afk.pid

# ---------- runner detection cascade ----------
# detect_runner — resolve the default runner via a 3-step cascade.
# Echoes "<runner>|<method>" so callers can log how the choice was made.
#   $1 — explicit pin (the --runner flag value); when non-empty short-circuits to "<pin>|pin"
#   $2 — script path to inspect (defaults to $SCRIPT_DIR); allows tests to override
#
# Cascade order:
#   1. env-var sniff   — harness identifiers (CLAUDECODE / CLAUDE_CODE_*, CODEX_HOME / CODEX_SANDBOX*)
#   2. path sniff      — script lives under a runner's plugin tree (~/.claude/... or ~/.codex/...)
#   3. env fallback    — ${RED_AFK_RUNNER:-claude}, the historical last-resort
detect_runner() {
  local pin="${1:-}"
  local src_path="${2:-${SCRIPT_DIR:-${BASH_SOURCE[0]}}}"
  if [[ -n "$pin" ]]; then
    echo "${pin}|pin"
    return 0
  fi
  if [[ -n "${CLAUDECODE:-}" || -n "${CLAUDE_CODE_ENTRYPOINT:-}" || -n "${CLAUDE_CODE_SSE_PORT:-}" ]]; then
    echo "claude|env-var"; return 0
  fi
  if [[ -n "${CODEX_HOME:-}" || -n "${CODEX_SANDBOX:-}" || -n "${CODEX_SANDBOX_NETWORK_DISABLED:-}" ]]; then
    echo "codex|env-var"; return 0
  fi
  if [[ "$src_path" == */.claude/* ]]; then
    echo "claude|path"; return 0
  fi
  if [[ "$src_path" == */.codex/* ]]; then
    echo "codex|path"; return 0
  fi
  echo "${RED_AFK_RUNNER:-claude}|env-fallback"
}

EXPLICIT_RUNNER=$RUNNER
_detection="$(detect_runner "$EXPLICIT_RUNNER")"
RUNNER="${_detection%%|*}"
RUNNER_DETECTION_METHOD="${_detection##*|}"
unset _detection

# Alternation is now opt-in. Pin (--runner) is mutually exclusive with --alternate (enforced above).
ALTERNATE=$ALTERNATE_FLAG
FALLBACK_RUNNER=$FALLBACK_RUNNER_FLAG

[[ "$RUNNER" == "claude" || "$RUNNER" == "codex" ]] || { echo "bad runner: $RUNNER" >&2; exit 2; }

# ---------- logging ----------
log()  { printf '[afk] %s\n' "$*" >&2; }
die()  { printf '[afk] ERROR: %s\n' "$*" >&2; exit 1; }
hr()   { printf -- '─%.0s' $(seq 1 60); echo; }

# ---------- preconditions ----------
precheck() {
  command -v gh   >/dev/null || die "gh not installed"
  command -v jq   >/dev/null || die "jq not installed"
  command -v git  >/dev/null || die "git not installed"
  command -v pnpm >/dev/null || log "warn: pnpm not on PATH; feedback loops will be skipped"

  gh auth status >/dev/null 2>&1 || die "gh not authenticated — run 'gh auth login'"

  git -C "$PROJECT_ROOT" rev-parse --show-toplevel >/dev/null 2>&1 \
    || die "$PROJECT_ROOT is not a git repo"

  # SSH-only remotes
  while IFS= read -r url; do
    [[ "$url" == https://* ]] && die "https remote forbidden: $url — use SSH"
  done < <(git -C "$PROJECT_ROOT" remote -v | awk '{print $2}' | sort -u)

  git -C "$PROJECT_ROOT" show-ref --verify --quiet refs/heads/main \
    || die "no local 'main' branch in primary checkout"

  local current
  current="$(git -C "$PROJECT_ROOT" branch --show-current)"
  [[ "$current" == "main" ]] || die "primary checkout must be on 'main' (currently '$current')"
}

# ---------- bootstrap ----------
bootstrap() {
  mkdir -p "$TMP_DIR" "$STATE_DIR"
  local gi="$PROJECT_ROOT/.gitignore"
  grep -qxF '.red/tmp/'   "$gi" 2>/dev/null || { echo '.red/tmp/'   >> "$gi"; log "added .red/tmp/ to .gitignore"; }
  grep -qxF '.red/state/' "$gi" 2>/dev/null || { echo '.red/state/' >> "$gi"; log "added .red/state/ to .gitignore"; }
  WORKER_ID="$(gen_worker_id)"
  log "worker: $WORKER_ID"
}

# ---------- event log ----------
# Append-only JSONL, one line per terminal event (done|blocked|exhausted).
# Survives reboots and worktree wipes. Read by monitor.sh for the 48h sparkline.
# Concurrent workers serialise via flock.
history_append() {
  # history_append <event> <issue#> <runner> [duration_s] [merge_sha] [reason]
  local event="$1" issue="$2" runner="$3" dur="${4:-0}" sha="${5:-}" reason="${6:-}"
  mkdir -p "$STATE_DIR"
  local line
  line="$(jq -cn \
    --arg ts "$(date -Iseconds)" \
    --argjson epoch "$(date +%s)" \
    --arg worker "$WORKER_ID" \
    --argjson issue "$issue" \
    --arg event "$event" \
    --argjson duration_s "$dur" \
    --arg runner "$runner" \
    --arg merge_sha "$sha" \
    --arg reason "$reason" \
    '{ts:$ts, epoch:$epoch, worker:$worker, issue:$issue, event:$event,
      duration_s:$duration_s, runner:$runner}
     + (if $merge_sha != "" then {merge_sha:$merge_sha} else {} end)
     + (if $reason    != "" then {reason:$reason}       else {} end)')"
  ( flock 9; printf '%s\n' "$line" >&9 ) 9>>"$HISTORY_FILE"
}

# Trim oldest lines if file exceeds cap. Called from prune_orphans.
history_trim() {
  [[ -f "$HISTORY_FILE" ]] || return 0
  local n; n="$(wc -l < "$HISTORY_FILE" 2>/dev/null || echo 0)"
  (( n > HISTORY_MAX_LINES )) || return 0
  local tmp; tmp="$(mktemp)"
  tail -n "$HISTORY_MAX_LINES" "$HISTORY_FILE" > "$tmp"
  ( flock 9; cat "$tmp" > "$HISTORY_FILE" ) 9>>"$HISTORY_FILE"
  rm -f "$tmp"
  log "trimmed history to last $HISTORY_MAX_LINES lines"
}

# ---------- orphan iteration cleanup ----------
# Sweeps $TMP_DIR/work-*/ at boot. An iteration dir is orphaned when its
# orchestrator pid is dead. For each orphan:
#   - (heartbeat sub-shell retired — Slice D)
#   - if the issue is closed OR no longer carries ready-for-human → rm -rf
#   - if the issue is still labelled running (orchestrator crashed mid-issue)
#     → restore ready-for-agent, comment, then rm -rf
#   - if the issue is ready-for-human → keep (human still needs the dir)
#   - if gh API check fails → fall back to mtime > 7d TTL
# Iter dirs without a state file (truly broken) → TTL of 1d, then rm -rf.
TTL_LONG=$((7*86400))
TTL_SHORT=$((1*86400))

prune_orphans() {
  local repo; repo="$(gh_repo)"
  local pruned=0 d
  local restored=()
  local now_s; now_s="$(date +%s)"

  shopt -s nullglob
  for d in "$TMP_DIR"/work-*/; do
    [[ -d "$d" ]] || continue
    local pid_file="$d/afk.pid"
    local state_file="$d/afk.state.json"

    # active worker → skip
    if [[ -f "$pid_file" ]]; then
      local p; p="$(cat "$pid_file" 2>/dev/null)"
      if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null; then
        continue
      fi
    fi

    # Heartbeat sub-shell was retired in Slice D — nothing to reap here.
    # heartbeat_pid in older state files is vestigial and ignored.

    local mtime_s; mtime_s="$(stat -c %Y "$d" 2>/dev/null || echo 0)"
    local safe=0
    local issue_n=""
    if [[ -f "$state_file" ]]; then
      local _orphan_current_number=""
      state_read_into _orphan "$state_file" 2>/dev/null
      issue_n="$_orphan_current_number"
    fi

    if [[ -z "$issue_n" || "$issue_n" == "null" ]]; then
      # no state → garbage if old enough
      (( now_s - mtime_s > TTL_SHORT )) && safe=1
    else
      local view
      if view="$(gh -R "$repo" issue view "$issue_n" --json labels,state 2>/dev/null)"; then
        local labels state
        labels=",$(echo "$view" | jq -r '[.labels[].name] | join(",")'),"
        state="$(echo "$view" | jq -r '.state')"

        if [[ "$state" == "CLOSED" ]]; then
          safe=1
        elif [[ "$labels" == *",ready-for-human,"* ]]; then
          # Preserved for human review. Apply split TTL based on whether the
          # canonical record (envelope comment) made it to the issue:
          #   posted=true  → 1d TTL (issue thread has the full envelope; the
          #                  local dir is pure redundancy).
          #   posted=false → 7d TTL (post failed — the local dir is the only
          #                  copy of notes/log, keep the safety window).
          local envelope_posted="false"
          if [[ -f "$state_file" ]]; then
            local _orphan_envelope_posted="false"
            state_read_into _orphan "$state_file" 2>/dev/null
            envelope_posted="$_orphan_envelope_posted"
          fi
          local ttl=$TTL_LONG
          [[ "$envelope_posted" == "true" ]] && ttl=$TTL_SHORT
          (( now_s - mtime_s > ttl )) && safe=1
        elif [[ "$labels" == *",running,"* ]]; then
          gh -R "$repo" issue edit "$issue_n" \
            --remove-label running --add-label ready-for-agent >/dev/null 2>&1 || true
          gh -R "$repo" issue comment "$issue_n" \
            --body "🤖 /afk orchestrator died mid-issue; restoring ready-for-agent." >/dev/null 2>&1 || true
          restored+=("$issue_n")
          safe=1
        else
          safe=1
        fi
      else
        # gh failed → TTL fallback
        (( now_s - mtime_s > TTL_LONG )) && safe=1
      fi
    fi

    if [[ $safe -eq 1 ]]; then
      rm -rf "$d"
      pruned=$((pruned+1))
    fi
  done
  shopt -u nullglob

  [[ $pruned -gt 0 ]] && log "pruned $pruned orphan iteration dir(s)"
  [[ ${#restored[@]} -gt 0 ]] && log "restored ready-for-agent on: #${restored[*]}"

  # Stale claim-lock sweep: rmdir any .red/tmp/claims/{N}/ whose pid is dead.
  local stale_claims=0 c
  shopt -s nullglob
  for c in "$TMP_DIR"/claims/*/; do
    [[ -d "$c" ]] || continue
    local cp; cp="$(cat "$c/pid" 2>/dev/null)"
    if [[ -z "$cp" ]] || ! kill -0 "$cp" 2>/dev/null; then
      rm -rf "$c"
      stale_claims=$((stale_claims+1))
    fi
  done
  shopt -u nullglob
  [[ $stale_claims -gt 0 ]] && log "released $stale_claims stale claim lock(s)"

  history_trim
}

# ---------- unblock sweep ----------
# Boot-time: scan every issue currently labelled `ready-for-human` and check
# whether all blockers listed under "## Blocked by" in its body have closed.
# If yes, auto-promote the issue back to `ready-for-agent`.
#
# Format expected in body (set by /to-issues):
#
#     ## Blocked by
#
#     - [ ] #123
#     - [x] #456
#
# The checkbox state is human UX only; we always look up the referenced
# issue's actual state via `gh issue view`. Trade-off accepted: an issue
# may have hit ready-for-human for an unrelated reason (test failure, spec
# ambiguity) and not because of these blockers — auto-promotion will then
# bounce back to ready-for-human on the next attempt. That's cheap and the
# fresh BLOCKED Notes are more informative than stale ones.
sweep_unblocked() {
  local repo; repo="$(gh_repo)"
  local list
  list="$(gh -R "$repo" issue list --label ready-for-human --state open \
            --json number,body --limit 100 2>/dev/null || echo '[]')"
  local n_candidates
  n_candidates="$(echo "$list" | jq 'length')"
  [[ "$n_candidates" -eq 0 ]] && return 0

  local promoted=()
  local entry n body refs ref r_state all_closed
  while IFS= read -r entry; do
    n="$(jq -r '.number' <<<"$entry")"
    body="$(jq -r '.body // ""' <<<"$entry")"
    # extract refs under `## Blocked by` (stop at next `## ` heading).
    # The grep is wrapped in a block with `|| true` so `set -o pipefail`
    # does not propagate grep's exit=1 when the section is empty or says
    # "None" — that propagation killed sweep_unblocked mid-loop before
    # the `return 0` at the end could fire, and bypassed the v1.12.1
    # final-line fix.
    refs="$(awk '/^## Blocked by[[:space:]]*$/{flag=1; next} /^## /{flag=0} flag' <<<"$body" \
            | { grep -oE '#[0-9]+' || true; } \
            | sort -u)"
    [[ -z "$refs" ]] && continue
    all_closed=1
    for ref in $refs; do
      r_state="$(gh -R "$repo" issue view "${ref#\#}" --json state --jq .state 2>/dev/null)"
      if [[ "$r_state" != "CLOSED" ]]; then
        all_closed=0
        break
      fi
    done
    if [[ $all_closed -eq 1 ]]; then
      if gh -R "$repo" issue edit "$n" \
            --remove-label ready-for-human --add-label ready-for-agent >/dev/null 2>&1; then
        gh -R "$repo" issue comment "$n" \
          --body "🤖 /afk promoted to ready-for-agent: all blockers closed ($(echo "$refs" | paste -sd' ' -))." >/dev/null 2>&1 || true
        promoted+=("$n")
      fi
    fi
  done < <(echo "$list" | jq -c '.[]')

  [[ ${#promoted[@]} -gt 0 ]] && log "unblocked ${#promoted[@]} issue(s): #${promoted[*]}"
  return 0
}

# Cross-iteration in-memory aggregates (state file is per-iteration; these survive between issues).
AGG_STARTED="$(date -Iseconds)"
AGG_TOTAL=0 AGG_DONE=0 AGG_BLOCKED=0 AGG_FAILED=0
AGG_COMPLETED='[]'
AGG_QUEUE='[]'
AGG_DURATIONS='[]'

# ---------- per-iteration directory ----------
iter_open() {
  local n="$1"
  ITER_DIR="$TMP_DIR/work-${WORKER_ID}-i${n}"
  STATE_FILE="$ITER_DIR/afk.state.json"
  ITER_LOG="$ITER_DIR/afk.log"
  ITER_PID_FILE="$ITER_DIR/afk.pid"
  mkdir -p "$ITER_DIR"
  printf '%s' "$$" > "$ITER_PID_FILE"
  : >> "$ITER_LOG"
  state_init "$STATE_FILE" \
    worker_id="$WORKER_ID" \
    pid:=$$ \
    log="$ITER_LOG" \
    started_at="$AGG_STARTED" \
    runner="$RUNNER" \
    filter.kind="$FILTER_KIND" \
    filter.value="$FILTER_VALUE" \
    total:=$AGG_TOTAL \
    done:=$AGG_DONE \
    failed:=$AGG_FAILED \
    blocked:=$AGG_BLOCKED \
    completed:="$AGG_COMPLETED" \
    queue:="$AGG_QUEUE" \
    current:=null \
    durations_seconds:="$AGG_DURATIONS"
}

iter_close_success() {
  [[ -n "$ITER_DIR" && -d "$ITER_DIR" ]] && rm -rf "$ITER_DIR"
  ITER_DIR="" STATE_FILE="" ITER_LOG="" ITER_PID_FILE=""
  claim_lock_release
}

iter_close_preserve() {
  # blocker / interrupt — keep dir for human, only drop the pid so monitor flags as inactive.
  [[ -n "$ITER_PID_FILE" && -f "$ITER_PID_FILE" ]] && rm -f "$ITER_PID_FILE"
  ITER_DIR="" STATE_FILE="" ITER_LOG="" ITER_PID_FILE=""
  claim_lock_release
}

# ---------- lifecycle hooks ----------
# Per-iteration call sites for the generic hook orchestrator (lib/hooks.sh).
# Four points are wired into process_issue / do_merge:
#   pre-iteration   — after claim, before `git worktree add`. Abort on non-zero.
#   pre-merge       — before `git merge --no-ff`.            Abort on non-zero.
#   post-merge      — after `git push origin main`.          Log on non-zero.
#   post-iteration  — every terminal outcome (done|blocked|no-sentinel
#                     |merge-conflict|discarded).            Log on non-zero.
#
# Env contract exported to every invocation (per the brief on issue #20):
#   RED_AFK_SLOT, RED_AFK_WORKER_ID, RED_AFK_RUNNER, RED_AFK_ISSUE, RED_AFK_ITER_DIR,
#   RED_AFK_BRANCH, RED_AFK_STATE_FILE, RED_AFK_PLUGIN_DIR
#   pre-merge / post-merge add RED_AFK_MERGE_BASE / RED_AFK_MERGE_SHA.
#   post-iteration adds RED_AFK_ITER_STATUS + RED_AFK_DURATION_S.
# RED_AFK_HOOK_ENV_FILE is set per-script by the orchestrator itself.
#
# Trailing KEY=VAL pairs become additional exports for this call only.
run_lifecycle_hook() {
  local point="$1"; shift
  export RED_AFK_SLOT="${RED_AFK_SLOT:-}"
  export RED_AFK_WORKER_ID="${WORKER_ID:-}"
  export RED_AFK_RUNNER="${RUNNER:-}"
  export RED_AFK_ISSUE="${CURRENT_ISSUE:-}"
  export RED_AFK_ITER_DIR="${ITER_DIR:-}"
  export RED_AFK_BRANCH="${CURRENT_BRANCH:-}"
  export RED_AFK_STATE_FILE="${STATE_FILE:-}"
  export RED_AFK_PLUGIN_DIR="${SKILL_DIR:-}"
  local kv
  for kv in "$@"; do
    export "$kv"
  done
  hooks_run "$point"
}

# Per-iteration cursor used by run_lifecycle_hook. Set/cleared in process_issue.
CURRENT_ISSUE=""
CURRENT_BRANCH=""

# Snapshot of ITER_DIR / STATE_FILE captured by snapshot_iter_for_hook just
# before iter_close_* zeroes the live cursors. fire_post_iteration replays
# the snapshot into RED_AFK_ITER_DIR / RED_AFK_STATE_FILE so post-iteration hooks
# still see the paths the brief promises.
LAST_ITER_DIR=""
LAST_STATE_FILE=""

snapshot_iter_for_hook() {
  LAST_ITER_DIR="$ITER_DIR"
  LAST_STATE_FILE="$STATE_FILE"
}

# fire_post_iteration STATUS DURATION_S
# Call AFTER iter_close_*. Hook failure is logged and ignored — the
# iteration's outcome is already final by the time this fires.
fire_post_iteration() {
  local status="$1" duration="$2"
  run_lifecycle_hook post-iteration \
    "RED_AFK_ITER_DIR=${LAST_ITER_DIR}" \
    "RED_AFK_STATE_FILE=${LAST_STATE_FILE}" \
    "RED_AFK_ITER_STATUS=${status}" \
    "RED_AFK_DURATION_S=${duration}" \
    || log "post-iteration hook reported non-zero (status=${status}); continuing"
  LAST_ITER_DIR="" LAST_STATE_FILE=""
  CURRENT_ISSUE="" CURRENT_BRANCH=""
}

# ---------- claim lock ----------
# `gh issue edit --remove-label X --add-label Y` is NOT atomic: gh resolves
# the new label set client-side and submits the union, so two parallel
# workers can both think they claimed the same issue. Fix layers:
#   1. mkdir-based local lock at .red/tmp/claims/{N}/ (POSIX atomic on the
#      same checkout — covers the typical "two terminals, one repo" case).
#   2. Pre-check the label state via `gh issue view` before the edit. Cuts
#      the race window down to ~1 round-trip; doesn't close it entirely,
#      but combined with (1) covers all single-checkout races.
#   3. Stale-lock sweep at boot (in prune_orphans) reaps locks whose pid
#      is dead, so a crashed orchestrator doesn't poison the lock forever.
# Residual gap: two clones of the same repo on the same host don't share
# .red/tmp/, so each holds its own mkdir lock and the gh edit race is back.
# Multi-host has the same property. Acceptable for the intended scale.

CLAIMED_ISSUE=""

claim_lock_acquire() {
  local n="$1"
  mkdir -p "$TMP_DIR/claims" 2>/dev/null
  mkdir "$TMP_DIR/claims/$n" 2>/dev/null || return 1
  printf '%s' "$$" > "$TMP_DIR/claims/$n/pid" 2>/dev/null
  CLAIMED_ISSUE="$n"
  return 0
}

claim_lock_release() {
  local n="${1:-$CLAIMED_ISSUE}"
  [[ -z "$n" ]] && return 0
  rm -rf "$TMP_DIR/claims/$n" 2>/dev/null || true
  [[ "$n" == "$CLAIMED_ISSUE" ]] && CLAIMED_ISSUE=""
  return 0
}

# ---------- state file ----------
# state_init / state_read_into / state_write / state_is_live live in lib/state.sh
# and own the v1 schema. Every state-file read or write in this file flows
# through them — never raw jq on the state file.

# ---------- issue selection ----------
slugify() {
  echo "$1" | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+|-+$//g' \
    | cut -c1-40
}

select_issues() {
  local raw
  raw="$(gh -R "$(gh_repo)" issue list --label ready-for-agent --state open \
        --json number,title,labels,body --limit 100)"

  # Hard exclude PRDs even if accidentally tagged ready-for-agent.
  # PRDs are not implementable units; /to-issues must split them first.
  local rejected_prds
  rejected_prds="$(echo "$raw" | jq -c '[ .[] | select((.labels | map(.name)) | index("type:prd")) | .number ]')"
  if [[ "$(echo "$rejected_prds" | jq 'length')" -gt 0 ]]; then
    log "⚠ excluding PRDs from queue (type:prd cannot be implemented directly): $(echo "$rejected_prds" | jq -r 'join(", #") | "#" + .')"
    log "  run /to-issues on each PRD to generate implementable slices, then remove ready-for-agent from the PRD itself."
  fi
  raw="$(echo "$raw" | jq '[ .[] | select(((.labels | map(.name)) | index("type:prd")) | not) ]')"

  # Split the candidate pool: urgents always jump the queue, regardless
  # of --prd / --issues filter. Anything carrying `priority:urgent` lands
  # first; the filter applies only to the remainder.
  local urgent rest filtered
  urgent="$(echo "$raw" | jq '[ .[] | select((.labels | map(.name)) | index("priority:urgent")) ]')"
  rest="$(echo "$raw"   | jq '[ .[] | select(((.labels | map(.name)) | index("priority:urgent")) | not) ]')"

  case "$FILTER_KIND" in
    issues)
      filtered="$(echo "$rest" | jq --arg list "$FILTER_VALUE" '
        ($list | split(",") | map(tonumber)) as $want
        | map(select(.number as $n | $want | index($n))) ')"
      ;;
    prd)
      filtered="$(echo "$rest" | jq --arg prd "$FILTER_VALUE" '
        map(select(
          ((.body // "") | test("prd:\\s*#?" + $prd + "\\b"))
          or ((.labels | map(.name)) | index("prd:" + $prd))
        )) ')"
      ;;
    *)
      filtered="$rest"
      ;;
  esac

  # Concat urgents (sorted by number asc — oldest fire first) ahead of
  # the filtered list (sorted by priority:high then number asc).
  # Dedupe by number while preserving order — urgents always win the slot.
  jq -sc '
    (.[0] | sort_by(.number)) as $urg
    | (.[1] | sort_by(
        ((.labels | map(.name) | map(select(. == "priority:high")) | length) | (if . > 0 then 0 else 1 end)),
        .number
      )) as $rest
    | ($urg | map(.number)) as $urg_nums
    | $urg + ($rest | map(select(.number as $n | $urg_nums | index($n) | not)))
  ' <(echo "$urgent") <(echo "$filtered")
}

gh_repo() {
  git -C "$PROJECT_ROOT" remote get-url origin \
    | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#' \
    | sed -E 's#\.git$##'
}

# ---------- local heartbeat ----------
# Issue-thread heartbeat glyphs (`:one:` … `:four:`) were retired in Slice D —
# the heartbeat sub-shell that posted them no longer exists. Local liveness
# signal is provided by:
#   - the inner-agent stream tee'd into ITER_LOG (continuous forensic trail)
#   - state file mtime, bumped on every state_write call (monitor uses this to
#     compute the 🟢 live / 🟡 stale flag together with the orchestrator pid)
# The `heartbeat_glyph` and `heartbeat_pid` state-file fields are kept as
# vestigial nulls for one release window so old monitors don't error on read.
HEARTBEAT_PID=""
heartbeat_start() {
  [[ -n "$ITER_LOG" ]] && printf '[heartbeat] iteration started for #%s at %s\n' \
    "$1" "$(date -Is)" >> "$ITER_LOG"
}
heartbeat_stop() {
  [[ -n "$ITER_LOG" ]] && printf '[heartbeat] iteration stopped at %s\n' \
    "$(date -Is)" >> "$ITER_LOG"
}

# ---------- terminal-event envelope ----------
# Every terminal event of an iteration (BLOCKED, no-sentinel, merge-conflict,
# DONE) posts exactly one structured comment on the issue. The envelope wraps
# a deterministic `<details data-attempt-status="...">` block so a future
# parser can reconstruct the iteration history from the thread alone.
#
# Schema (intentionally narrow — Slice C will parse it):
#
#   <details data-attempt-status="blocked|no-sentinel|merge-conflict|done">
#   <summary>worker `wXXXX` · status: … · duration: NmSs · diff: +N -M | merged · attempt: K [· merge: <sha>]</summary>
#
#   <details data-section="notes"><summary>notes</summary>
#
#   …handoff `## Notes` body…
#
#   </details>
#
#   <details data-section="log"><summary>log (last 50 lines)</summary>
#
#   ```
#   …
#   ```
#
#   </details>
#
#   </details>
#
# DONE envelopes are lightweight: status=done, summary carries the merge-commit
# link, and no `data-section="diff"` block is emitted (the merge commit on
# `main` is the diff).

fmt_duration() {
  local s="${1:-0}"
  printf '%dm%ds' $((s/60)) $((s%60))
}

# Diffstat for the iteration branch relative to its merge base with main.
# Returns the literal "+N -M" so summary lines stay scannable. Falls back to
# "+0 -0" when the branch has no commits or git fails.
branch_diffstat() {
  local branch="$1"
  [[ -z "$branch" ]] && { echo "+0 -0"; return; }
  local raw
  raw="$(git -C "$PROJECT_ROOT" diff --shortstat "origin/main...$branch" 2>/dev/null || true)"
  local ins del
  ins="$(echo "$raw" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)"
  del="$(echo "$raw" | grep -oE '[0-9]+ deletion'  | grep -oE '[0-9]+' || echo 0)"
  printf '+%s -%s' "${ins:-0}" "${del:-0}"
}

# Extended diffstat with file count, for the envelope's `data-section="diff"`
# body. Format: `+N -M files=K`. Falls back to zeroes on any failure.
branch_diffstat_full() {
  local branch="$1"
  [[ -z "$branch" ]] && { echo "+0 -0 files=0"; return; }
  local raw
  raw="$(git -C "$PROJECT_ROOT" diff --shortstat "origin/main...$branch" 2>/dev/null || true)"
  local ins del files
  ins="$(echo "$raw"   | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+' || echo 0)"
  del="$(echo "$raw"   | grep -oE '[0-9]+ deletion'  | grep -oE '[0-9]+' || echo 0)"
  files="$(echo "$raw" | grep -oE '[0-9]+ file'      | grep -oE '[0-9]+' || echo 0)"
  printf '+%s -%s files=%s' "${ins:-0}" "${del:-0}" "${files:-0}"
}

# Push the worker branch to the remote `afk-attempts/{wid}/{n}-{slug}` namespace
# so forensic investigators have a stable ref after the worktree is cleaned up.
# Echoes the remote branch name on success and returns 0; emits nothing and
# returns non-zero on failure. Only called from terminal-failure paths
# (BLOCKED, no-sentinel, merge-conflict) — DONE iterations merge to main and
# the merge commit carries the diff.
push_attempt_branch() {
  local branch="$1" n="$2" slug="$3"
  local remote_branch="afk-attempts/${WORKER_ID}/${n}-${slug}"
  if git -C "$PROJECT_ROOT" push origin "${branch}:refs/heads/${remote_branch}" >/dev/null 2>&1; then
    printf '%s' "$remote_branch"
    return 0
  fi
  log "warn: failed to push attempt branch to origin/${remote_branch}"
  return 1
}

# Body of the envelope's `data-section="diff"` block. When the attempt branch
# was pushed, the primary content is a compare-link to the pushed ref; when
# the push failed, we embed the local worktree path so a human can still find
# the work. The diffstat line is always included so the section is scannable.
build_diff_section_body() {
  local branch="$1" remote_branch="$2" worktree_rel="$3"
  local stat; stat="$(branch_diffstat_full "$branch")"
  if [[ -n "$remote_branch" ]]; then
    local repo; repo="$(gh_repo)"
    local url="https://github.com/${repo}/compare/main...${remote_branch}"
    printf '<a href="%s">compare/main...%s</a>\n\n%s\n' "$url" "$remote_branch" "$stat"
  else
    printf 'push to `afk-attempts/` failed — local worktree: `%s`\n\n%s\n' "$worktree_rel" "$stat"
  fi
}

# Extract the body inside `<agent-notes>…</agent-notes>` from the handoff
# file, dropping the placeholder HTML comment. Empty string when the inner
# agent appended nothing.
extract_handoff_notes() {
  local handoff="$1"
  [[ -f "$handoff" ]] || { echo ""; return; }
  awk '
    /^<agent-notes>[[:space:]]*$/ { flag=1; next }
    /^<\/agent-notes>[[:space:]]*$/ { flag=0; next }
    flag { print }
  ' "$handoff" \
    | grep -v '^<!-- inner agent appends progress/blockers here across attempts -->$' \
    | sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

# Read last N lines from the iteration log (the captured inner-agent stdout).
tail_iter_log() {
  local n="${1:-50}"
  [[ -f "$ITER_LOG" ]] || { echo ""; return; }
  tail -n "$n" "$ITER_LOG"
}

# build_envelope_summary <status> <duration_s> <diff_or_merged> <attempt> [merge_sha]
# Emits the deterministic summary line — kept centralised so every callsite
# (and the unit test) renders the same shape.
build_envelope_summary() {
  local status="$1" dur="$2" diff_or_merged="$3" attempt="$4" merge_sha="${5:-}"
  local merge_part=""
  [[ -n "$merge_sha" ]] && merge_part=" · merge: \`$merge_sha\`"
  printf 'worker `%s` · status: %s · duration: %s · diff: %s · attempt: %d%s' \
    "$WORKER_ID" "$status" "$(fmt_duration "$dur")" "$diff_or_merged" "$attempt" "$merge_part"
}

# build_envelope <status> <summary> [<section_name> <section_body_file>]...
# Writes the full envelope body to stdout. Section bodies come from files so
# we don't shell-escape multi-KB log tails through arguments. `log` sections
# get wrapped in a fenced code block; everything else is rendered raw.
build_envelope() {
  local status="$1" summary="$2"
  shift 2
  printf '<details data-attempt-status="%s"><summary>%s</summary>\n\n' "$status" "$summary"
  while [[ $# -ge 2 ]]; do
    local section="$1" body_file="$2"
    shift 2
    printf '<details data-section="%s"><summary>%s</summary>\n\n' "$section" "$section"
    if [[ "$section" == "log" ]]; then
      printf '```\n'
      cat "$body_file"
      printf '\n```\n\n'
    else
      cat "$body_file"
      printf '\n\n'
    fi
    printf '</details>\n\n'
  done
  printf '</details>\n'
}

# Compose + post in one shot. Sets `.envelope.posted` to true on any 2xx,
# false on failure — boot-time prune_orphans reads this to choose TTL.
# emit_envelope <status> <issue#> <duration_s> <branch> <attempt> <merge_sha> [<section> <body_file>]...
emit_envelope() {
  local status="$1" n="$2" dur="$3" branch="$4" attempt="$5" merge_sha="$6"
  shift 6
  local diff_or_merged
  if [[ "$status" == "done" ]]; then
    diff_or_merged="merged"
  else
    diff_or_merged="$(branch_diffstat "$branch")"
  fi
  local summary
  summary="$(build_envelope_summary "$status" "$dur" "$diff_or_merged" "$attempt" "$merge_sha")"

  local body; body="$(build_envelope "$status" "$summary" "$@")"

  if gh -R "$(gh_repo)" issue comment "$n" --body "$body" >/dev/null 2>&1; then
    state_write "$STATE_FILE" envelope.posted:=true
    return 0
  fi
  state_write "$STATE_FILE" envelope.posted:=false
  log "warn: failed to post envelope for #$n (status=$status)"
  return 1
}

# ---------- envelope parser (Slice C read side) ----------
# The orchestrator's envelope writer (build_envelope) emits a deterministic
# `<details data-attempt-status="…">` block per terminal attempt. These helpers
# consume the same shape so the retry handoff builder can surface prior
# attempts to the next inner agent. Pure functions, easy to unit-test by
# sourcing afk.sh.

# A well-formed envelope opens with `<details data-attempt-status="…">` and
# closes with `</details>`. Anything else (legacy `<details>` without the
# attribute, free text, etc.) is treated as a regular comment and falls into
# `## Human guidance` per the acceptance criteria.
envelope_is_envelope() {
  local body="$1"
  [[ "$body" == "<details data-attempt-status=\""* ]] && [[ "$body" == *"</details>"* ]]
}

# Orchestrator-authored audit lines. Excluded from `## Human guidance` so the
# inner agent doesn't mistake them for human direction.
comment_is_boot_stamp() {
  [[ "$1" == "🤖 /afk started "* ]]
}

comment_is_promotion_audit() {
  [[ "$1" == "🤖 /afk promoted to ready-for-agent"* ]]
}

# Heartbeat glyphs (`:one:` … `:six:`) were retired in Slice D but legacy ones
# may still live on older issues.
comment_is_heartbeat_glyph() {
  local trimmed="${1//[[:space:]]/}"
  [[ "$trimmed" =~ ^:(one|two|three|four|five|six):$ ]]
}

# Single composed predicate the builder consults per comment. A comment is
# human guidance iff it is not blank, not an envelope, and not one of the
# orchestrator's noise classes.
comment_is_human_guidance() {
  local body="$1"
  [[ -z "${body//[[:space:]]/}" ]] && return 1
  envelope_is_envelope "$body"      && return 1
  comment_is_boot_stamp "$body"     && return 1
  comment_is_promotion_audit "$body" && return 1
  comment_is_heartbeat_glyph "$body" && return 1
  return 0
}

# ---------- comment classifier (PRD #29 #30) ----------
# Two pure functions — no I/O, no `gh`, no global mutation — that become the
# single source of truth both downstream tracks (A1 directive routing, B1 cap
# state machine) read from. The legacy predicates above stay in place during
# this slice; `classify_comment` composes them so the consolidation is
# transparent at the seam, and A1/B1 migrate their callers later.

# classify_comment <body>  →  prints one of:
#   envelope | directive_carrier | thread_discussion | audit_noise
#
# Precedence (first match wins), so the noise classes can never be mistaken
# for human direction:
#   1. blank body                                   → audit_noise
#   2. `<details data-attempt-status="…">` envelope → envelope
#   3. boot stamp / promotion audit / heartbeat     → audit_noise
#   4. ≥1 well-formed `<details data-kind="directive">…</details>` element
#      (well-formedness == extract_directives can pull it out)  → directive_carrier
#   5. anything else (plain narrative, malformed marker)        → thread_discussion
#
# Note the directive arm defers to `extract_directives` for well-formedness
# rather than a substring peek, so classify_comment and extract_directives can
# never disagree about whether a comment carries a directive.
classify_comment() {
  local body="$1"
  [[ -z "${body//[[:space:]]/}" ]]   && { echo audit_noise; return 0; }
  envelope_is_envelope "$body"        && { echo envelope; return 0; }
  comment_is_boot_stamp "$body"       && { echo audit_noise; return 0; }
  comment_is_promotion_audit "$body"  && { echo audit_noise; return 0; }
  comment_is_heartbeat_glyph "$body"  && { echo audit_noise; return 0; }
  local ndir
  ndir="$(extract_directives "$body" | tr -dc '\0' | wc -c)"
  if (( ndir > 0 )); then
    echo directive_carrier
  else
    echo thread_discussion
  fi
}

# extract_directives <body>  →  NUL-separated list to stdout
# Prints the verbatim text content of every well-formed
# `<details data-kind="directive">…</details>` element in `body`, in document
# order, each terminated by a NUL byte. Downstream reads it back with
#   mapfile -d '' arr < <(extract_directives "$body")
# Prints nothing (empty list) when no marker is present or only malformed
# markers exist.
#
# Parsing contract (line-oriented; markers live on their own lines, as GitHub
# renders `<details>` markdown):
#   - The opening tag is recognised only as a whole trimmed line equal to
#     `<details data-kind="directive">`.
#   - Content is every line strictly between that open and its *matching*
#     `</details>`, joined with `\n`, verbatim — including any nested
#     `<details>` block an operator pasted in.
#   - Nesting: a trimmed line starting `<details` raises depth, a trimmed line
#     exactly `</details>` lowers it; the directive ends only when depth
#     returns to 0. A closing tag carrying attributes (`</details foo>`) is not
#     a valid close.
#   - Code fences: a line whose trimmed text starts with ``` toggles a fence;
#     while inside a fence, tag detection is suspended, so a literal
#     `</details>` inside a fenced code block never terminates the parse early.
#   - CRLF: a trailing `\r` is stripped from every line before matching.
#   - Malformed (opened but never closed, or closed only with an attributed
#     tag) yields no output for that element.
#
# Pure: reads only its argument via a here-string. No filesystem, no network.
extract_directives() {
  local body="$1"
  local line trimmed depth=0 fence=0 content=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    # trim leading/trailing whitespace for tag matching (content uses $line raw)
    trimmed="${line#"${line%%[![:space:]]*}"}"
    trimmed="${trimmed%"${trimmed##*[![:space:]]}"}"

    if [[ "$trimmed" == '```'* ]]; then
      (( depth > 0 )) && content+=$'\n'"$line"
      fence=$(( fence ^ 1 ))
      continue
    fi
    if (( fence )); then
      (( depth > 0 )) && content+=$'\n'"$line"
      continue
    fi

    if (( depth == 0 )); then
      [[ "$trimmed" == '<details data-kind="directive">' ]] && { depth=1; content=""; }
      continue
    fi

    if [[ "$trimmed" == '<details'* ]]; then
      depth=$(( depth + 1 )); content+=$'\n'"$line"; continue
    fi
    if [[ "$trimmed" == '</details>' ]]; then
      depth=$(( depth - 1 ))
      if (( depth == 0 )); then
        printf '%s\0' "${content#$'\n'}"
        content=""
      else
        content+=$'\n'"$line"
      fi
      continue
    fi
    content+=$'\n'"$line"
  done <<<"$body"
}

# envelope_field <body> <name>  →  prints value to stdout.
# Pulls a single field from the envelope opening / summary line. `status` is
# the `data-attempt-status` attribute; `worker` and `duration` come from the
# summary line that build_envelope_summary emits.
envelope_field() {
  local body="$1" name="$2"
  case "$name" in
    status)
      sed -n 's/.*data-attempt-status="\([^"]*\)".*/\1/p' <<<"$body" | head -n1
      ;;
    worker)
      sed -n 's/.*worker `\([^`]*\)`.*/\1/p' <<<"$body" | head -n1
      ;;
    duration)
      # `duration: 2m5s · …` — capture up to the next ` ·` or end of line.
      sed -n 's/.*duration: \([^ ]*\).*/\1/p' <<<"$body" | head -n1
      ;;
  esac
}

# envelope_section <body> <name>  →  raw section content to stdout.
# Walks the envelope and captures the body of `<details data-section="name">`
# up to the next `</details>` at the same depth (sections are siblings inside
# the envelope, never nested in each other). For `log` sections the wrapping
# ``` fences are stripped so the caller can re-fence if it wants. Exits 1 when
# the section is absent.
envelope_section() {
  local body="$1" name="$2"
  awk -v name="$name" '
    BEGIN { capture=0; found=0; depth=0 }
    {
      if (capture) {
        if ($0 ~ /^<\/details>[[:space:]]*$/) { capture=0; next }
        # drop the summary line (e.g. "<summary>notes</summary>")
        if ($0 ~ /^<summary>.*<\/summary>[[:space:]]*$/) next
        print
        next
      }
      idx = index($0, "<details data-section=\"" name "\">")
      if (idx > 0) { capture=1; found=1; next }
    }
    END { if (!found) exit 1 }
  ' <<<"$body" | _strip_log_fences_and_blanks
}

# Internal: remove leading/trailing blank lines and, if the content is wrapped
# in a single ```…``` block, peel those fences. Keeps section output tidy.
_strip_log_fences_and_blanks() {
  awk '
    { lines[NR] = $0 }
    END {
      # find first/last non-blank
      first = 0; last = 0
      for (i = 1; i <= NR; i++) {
        if (lines[i] !~ /^[[:space:]]*$/) { if (!first) first = i; last = i }
      }
      if (!first) exit 0
      # peel matching ``` fences
      if (lines[first] ~ /^```/ && lines[last] ~ /^```[[:space:]]*$/ && last > first) {
        first++; last--
      }
      for (i = first; i <= last; i++) print lines[i]
    }
  '
}

# build_previous_attempts <comments_json>
# Reads a JSON array of comments on stdin (`{author, body, createdAt}` shape)
# and emits an XML block listing every envelope in chronological order.
# Each attempt is a `<previous-attempt>` element with status/worker/duration/
# branch as attributes (when present) and `<notes>`/`<drop>`/`<log>` child
# elements carrying free-text content. Empty output when there are no
# envelopes — caller suppresses the wrapping `<previous-attempts>` tag.
build_previous_attempts() {
  local comments_json="$1"
  local n
  n="$(jq 'length' <<<"$comments_json")"
  [[ "$n" -gt 0 ]] || return 0

  local count=0 i body status worker duration notes drop log branch entry_idx=0
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body" <<<"$comments_json")"
    envelope_is_envelope "$body" || continue
    count=$((count + 1))
  done
  [[ "$count" -gt 0 ]] || return 0

  local first=1
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body" <<<"$comments_json")"
    envelope_is_envelope "$body" || continue
    entry_idx=$((entry_idx + 1))
    status="$(envelope_field "$body" status)"
    worker="$(envelope_field "$body" worker)"
    duration="$(envelope_field "$body" duration)"
    branch="$(envelope_section "$body" branch 2>/dev/null || true)"
    [[ -n "$branch" ]] && branch="$(printf '%s' "$branch" | head -n1)"

    if [[ $first -eq 1 ]]; then first=0; else printf '\n'; fi
    printf '<previous-attempt n="%d" status="%s"' "$entry_idx" "${status:-unknown}"
    [[ -n "$worker"   ]] && printf ' worker="%s"' "$worker"
    [[ -n "$duration" ]] && printf ' duration="%s"' "$duration"
    [[ -n "$branch"   ]] && printf ' branch="%s"' "$branch"
    printf '>\n'

    notes="$(envelope_section "$body" notes 2>/dev/null || true)"
    if [[ -n "$notes" ]]; then
      printf '<notes>\n%s\n</notes>\n' "$notes"
    fi
    drop="$(envelope_section "$body" drop 2>/dev/null || true)"
    if [[ -n "$drop" ]]; then
      printf '<drop>\n%s\n</drop>\n' "$drop"
    fi
    log="$(envelope_section "$body" log 2>/dev/null || true)"
    if [[ -n "$log" ]]; then
      printf '<log>\n%s\n</log>\n' "$log"
    fi
    printf '</previous-attempt>\n'
  done
}

# build_human_guidance <comments_json>
# Emits one `<human-guidance>` element per *extracted directive*, in document
# order within each comment and chronological order across comments. Empty
# output when no comment carries a directive — caller suppresses the wrapping
# `<human-guidance-thread>` tag.
#
# Two-channel split (PRD #29 Track A): the directive marker, not the comment's
# human-ness, is now the gate. A comment is routed by `classify_comment` (#30):
# only `directive_carrier` comments reach this builder; their authoritative
# content is the verbatim text of each `<details data-kind="directive">…</details>`
# element pulled by `extract_directives` (#30), *not* the whole comment body.
# A comment with two markers therefore produces two sibling `<human-guidance>`
# elements with identical author/at attributes; a comment with no marker
# produces zero elements and falls through to `<thread-discussion>`.
#
# The XML tag is the load-bearing signal to the agent, because the
# `author.login` field cannot be trusted: every comment the orchestrator posts
# via `gh issue comment` from the operator's host carries the operator's GitHub
# login, indistinguishable on the wire from a real human reply. The directive
# marker is what makes the content authoritative, and `classify_comment` strips
# orchestrator audits (boot stamps, promotion lines, heartbeats, envelopes) by
# body shape before any routing decision.
build_human_guidance() {
  local comments_json="$1"
  local n; n="$(jq 'length' <<<"$comments_json")"
  [[ "$n" -gt 0 ]] || return 0

  local first=1 i body author created
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body" <<<"$comments_json")"
    [[ "$(classify_comment "$body")" == directive_carrier ]] || continue
    author="$(jq -r ".[$i].author.login // \"unknown\"" <<<"$comments_json")"
    created="$(jq -r ".[$i].createdAt // \"\"" <<<"$comments_json")"
    local -a dirs=()
    mapfile -t -d '' dirs < <(extract_directives "$body")
    local d
    for d in "${dirs[@]}"; do
      if [[ $first -eq 1 ]]; then first=0; else printf '\n'; fi
      if [[ -n "$created" ]]; then
        printf '<human-guidance author="@%s" at="%s">\n%s\n</human-guidance>\n' "$author" "$created" "$d"
      else
        printf '<human-guidance author="@%s">\n%s\n</human-guidance>\n' "$author" "$d"
      fi
    done
  done
}

# build_thread_discussion <comments_json>
# Sibling shape of build_human_guidance for the *advisory* channel. Emits one
# `<thread-discussion-entry>` element per comment classified `thread_discussion`
# by `classify_comment` (#30) — narrative comments that carry no directive
# marker and are not audit-noise — wrapping the verbatim body in chronological
# order. Empty output when none; caller suppresses the wrapping
# `<thread-discussion>` container.
#
# These entries are the lowest authority in the precedence ladder: the inner
# agent may consult them only as a tie-breaker when the brief is genuinely
# ambiguous and no `<human-guidance>` resolves it (see ADR 0002). The whole
# body surfaces verbatim — there is no marker to extract from, by definition.
build_thread_discussion() {
  local comments_json="$1"
  local n; n="$(jq 'length' <<<"$comments_json")"
  [[ "$n" -gt 0 ]] || return 0

  local first=1 i body author created
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body" <<<"$comments_json")"
    [[ "$(classify_comment "$body")" == thread_discussion ]] || continue
    author="$(jq -r ".[$i].author.login // \"unknown\"" <<<"$comments_json")"
    created="$(jq -r ".[$i].createdAt // \"\"" <<<"$comments_json")"
    if [[ $first -eq 1 ]]; then first=0; else printf '\n'; fi
    if [[ -n "$created" ]]; then
      printf '<thread-discussion-entry author="@%s" at="%s">\n%s\n</thread-discussion-entry>\n' "$author" "$created" "$body"
    else
      printf '<thread-discussion-entry author="@%s">\n%s\n</thread-discussion-entry>\n' "$author" "$body"
    fi
  done
}

# count_blocked_since_guidance <comments_json>  →  prints int
# Per-issue BLOCKED cap counter for PRD #29 Track B. Walks the comments
# array (`{author, body, createdAt}` shape, chronological order) backwards
# and counts the trailing run of `data-attempt-status="blocked"` envelopes.
#
# Stop conditions while walking from newest to oldest:
#   - directive_carrier comment (contains a well-formed
#     `<details data-kind="directive">…</details>` marker after audit-noise
#     filtering) → human has handed down a fresh directive; reset.
#   - any envelope whose status is not "blocked" (done, no-sentinel,
#     merge-conflict, discarded, …) → trailing-BLOCKED run is broken.
#
# Skip (do not count, do not stop):
#   - audit_noise: boot stamp, promotion audit, heartbeat glyph, blank body.
#   - thread_discussion: any other narrative comment with no directive marker.
#
# Pure: jq only, no `gh`, no filesystem. Empty / `[]` / `null` → 0.
#
# This is the load-bearing decision the per-issue cap rests on. Supervisor
# integration lives in a follow-up slice; here we only ship the function
# plus its dedicated unit test suite.
count_blocked_since_guidance() {
  local comments_json="$1"
  local n count i body status
  [[ -z "$comments_json" || "$comments_json" == "null" ]] && { echo 0; return 0; }
  n="$(jq 'length' <<<"$comments_json" 2>/dev/null || echo 0)"
  [[ "$n" -gt 0 ]] || { echo 0; return 0; }

  count=0
  for ((i = n - 1; i >= 0; i--)); do
    body="$(jq -r ".[$i].body // \"\"" <<<"$comments_json")"
    if envelope_is_envelope "$body"; then
      status="$(envelope_field "$body" status)"
      if [[ "$status" == "blocked" ]]; then
        count=$((count + 1))
        continue
      fi
      # Non-blocked envelope breaks the trailing-BLOCKED run.
      break
    fi
    if _comment_is_directive_carrier "$body"; then
      break
    fi
    # audit_noise or thread_discussion — skip without resetting.
  done
  echo "$count"
}

# _comment_is_directive_carrier <body>
# True iff the comment body contains at least one well-formed
# `<details data-kind="directive">…</details>` element. Body-shape filter:
# audit-noise classes (boot stamp / promotion audit / heartbeat glyph /
# blank) are rejected first so we never mistake a system audit for human
# direction. Envelopes are also rejected — a `data-attempt-status` block
# is not a directive carrier even if it happens to embed marker-like text.
#
# Private helper; consolidation into PRD #29 #30's `classify_comment`
# happens in that slice. The detection here is intentionally narrow:
# substring match for the opening tag plus a closing `</details>` after it,
# which is enough for the count_blocked_since_guidance state machine.
_comment_is_directive_carrier() {
  local body="$1"
  [[ -z "${body//[[:space:]]/}" ]]    && return 1
  envelope_is_envelope "$body"        && return 1
  comment_is_boot_stamp "$body"       && return 1
  comment_is_promotion_audit "$body"  && return 1
  comment_is_heartbeat_glyph "$body"  && return 1
  local open='<details data-kind="directive">'
  [[ "$body" == *"$open"* ]] || return 1
  local after="${body#*$open}"
  [[ "$after" == *"</details>"* ]]
}

# ---------- per-issue BLOCKED cap (PRD #29 Track B) ----------

# per_issue_cap  →  prints the resolved cap K
# Reads RED_AFK_PER_ISSUE_CAP (default 3). Defensive: a non-numeric value,
# zero, or a negative number falls back to the default — an operator typo
# must never disable the cap or trip it on the first attempt.
per_issue_cap() {
  local v="${RED_AFK_PER_ISSUE_CAP:-3}"
  if [[ "$v" =~ ^[0-9]+$ ]] && (( v > 0 )); then
    echo "$v"
  else
    echo 3
  fi
}

# _thread_lacks_directive_marker <comments_json>  →  prints "true" | "false"
# "true" when the thread contains no directive_carrier comment at all — the
# operator has never used the `<details data-kind="directive">` marker, so the
# trip comment teaches the syntax. "false" when at least one directive_carrier
# is present (the operator already knows the marker), so the self-teaching
# block is redundant and omitted.
_thread_lacks_directive_marker() {
  local comments_json="$1"
  local n i body
  [[ -z "$comments_json" || "$comments_json" == "null" ]] && { echo true; return 0; }
  n="$(jq 'length' <<<"$comments_json" 2>/dev/null || echo 0)"
  for ((i = 0; i < n; i++)); do
    body="$(jq -r ".[$i].body // \"\"" <<<"$comments_json")"
    if _comment_is_directive_carrier "$body"; then
      echo false
      return 0
    fi
  done
  echo true
}

# trip_per_issue_cap <issue_n> <count> <latest_lacks_marker_bool>
# Flips `ready-for-agent` → `ready-for-human` and posts a trip comment naming
# the consecutive-BLOCKED count. When latest_lacks_marker_bool is "true" the
# comment also carries a copy-pasteable `<details data-kind="directive">`
# example so the operator learns how to hand down authoritative guidance.
#
# Defensive: a gh failure on either the label flip or the comment post logs a
# warning but never aborts — the cap exists to make a stuck loop better, never
# worse. Recovery is the operator manually relabelling ready-for-human →
# ready-for-agent (no auto-relabel, no cooldown — out of scope per PRD #29).
trip_per_issue_cap() {
  local n="$1" count="$2" lacks_marker="$3"
  local repo; repo="$(gh_repo)"
  local comment
  comment="🤖 /afk per-issue cap tripped: ${count} consecutive BLOCKED attempts without human directive."
  if [[ "$lacks_marker" == "true" ]]; then
    comment+=$'\n\n'"To unblock, add your authoritative guidance to this issue using a directive marker, then relabel \`ready-for-human\` → \`ready-for-agent\`:"
    comment+=$'\n\n```\n<details data-kind="directive">\n…your authoritative guidance here…\n</details>\n```'
  fi
  if ! gh -R "$repo" issue edit "$n" \
        --remove-label ready-for-agent --add-label ready-for-human >/dev/null 2>&1; then
    log "⚠ per-issue cap: failed to flip labels on #$n (gh edit) — continuing"
  fi
  if ! gh -R "$repo" issue comment "$n" --body "$comment" >/dev/null 2>&1; then
    log "⚠ per-issue cap: failed to post trip comment on #$n (gh comment) — continuing"
  fi
}

# build_retry_handoff_body <n> <title> <body> <runner> <attempt> <url> <comments_json>
# Composes the full handoff markdown to stdout. Pure function — no network,
# no filesystem writes. Sections that would be empty are omitted entirely.
build_retry_handoff_body() {
  local n="$1" title="$2" body="$3" runner="$4" attempt="$5" url="$6" comments_json="$7"
  echo "# Issue #${n} — ${title} [AFK]"
  echo
  echo "source: ${url}"
  [[ "$FILTER_KIND" == "prd" ]] && echo "prd: #${FILTER_VALUE}"
  echo "runner: ${runner}"
  echo "started: $(date -Iseconds)"
  echo "attempt: ${attempt}"
  echo
  echo "<issue-body>"
  echo "${body}"
  echo "</issue-body>"

  local attempts_block guidance_block discussion_block
  attempts_block="$(build_previous_attempts "$comments_json")"
  guidance_block="$(build_human_guidance "$comments_json")"
  discussion_block="$(build_thread_discussion "$comments_json")"

  if [[ -n "$attempts_block" ]]; then
    echo
    echo "<previous-attempts>"
    printf '%s\n' "$attempts_block"
    echo "</previous-attempts>"
  fi

  if [[ -n "$guidance_block" ]]; then
    echo
    echo "<human-guidance-thread>"
    printf '%s\n' "$guidance_block"
    echo "</human-guidance-thread>"
  fi

  if [[ -n "$discussion_block" ]]; then
    echo
    echo "<thread-discussion>"
    printf '%s\n' "$discussion_block"
    echo "</thread-discussion>"
  fi

  echo
  echo "<agent-notes>"
  echo "<!-- inner agent appends progress/blockers here across attempts -->"
  echo "</agent-notes>"
}

# ---------- handoff file ----------
write_handoff() {
  local n="$1" title="$2" slug="$3" body="$4" worktree="$5" runner="$6" attempt="$7"
  # Handoff file lives in the iteration directory (one level above the worktree).
  local handoff="$ITER_DIR/handoff.md"

  local url comments_json
  url="$(gh -R "$(gh_repo)" issue view "$n" --json url --jq .url 2>/dev/null)"
  comments_json="$(gh -R "$(gh_repo)" issue view "$n" --json comments \
    --jq '.comments | map({author: {login: .author.login}, body: .body, createdAt: .createdAt})' \
    2>/dev/null)"
  [[ -z "$comments_json" ]] && comments_json='[]'

  build_retry_handoff_body "$n" "$title" "$body" "$runner" "$attempt" "$url" "$comments_json" > "$handoff"

  echo "$handoff"
}

# ---------- runner invocation ----------
RUNNER_EXHAUSTED=0

run_inner() {
  local worktree="$1" handoff="$2" runner="$3"
  RUNNER_EXHAUSTED=0

  local commits
  commits="$(git -C "$PROJECT_ROOT" log -n 5 --format='%H%n%ad%n%B---' --date=short main)"

  local prompt_body
  prompt_body="$(cat "$SKILL_DIR/AGENT-PROMPT.md")"

  local full_prompt
  full_prompt="$(cat <<EOF
Handoff file: $handoff  (read this first)

Recent commits on main:
$commits

$prompt_body
EOF
)"

  local result=""
  if [[ "$runner" == "claude" ]]; then
    result="$(run_claude "$worktree" "$full_prompt")"
  else
    result="$(run_codex "$worktree" "$full_prompt")"
  fi

  # exhaustion strings — keep in sync with runner-*.md
  if echo "$result" | grep -qiE 'usage limit|weekly (limit|cap)|session (limit|exhausted)|quota|rate_limit_error|try again later'; then
    RUNNER_EXHAUSTED=1
    echo ""
    return
  fi

  echo "$result"
}

# Recursively SIGTERM (then SIGKILL on grace) a pid and all its descendants.
# Used by the inner-agent watchdog to kill claude / codex pipelines whose
# child bash processes are stuck in a polling loop without a timeout — the
# wheel-spin pattern where the inner agent emits <promise>DONE</promise>
# but a pending tool call (typically `until grep "test result"`) keeps the
# stream-json pipe open and the orchestrator stalls indefinitely.
kill_tree() {
  local pid="$1" sig="${2:-TERM}"
  local k
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$k" "$sig"
  done
  kill -"$sig" "$pid" 2>/dev/null || true
}

# Watchdog spawned alongside an inner-agent pipeline. Extracts assistant
# text from the stream-json capture file via the runner-specific jq filter
# and matches the DONE/BLOCKED sentinel **line-anchored** — the contract in
# AGENT-PROMPT.md is "<promise>DONE</promise> on a line by itself, last".
# Un-anchored matching false-positives on the agent quoting the sentinel
# inside intermediate planning output (issues #4, #6, #7). Once seen, gives
# the pipeline RED_AFK_WATCHDOG_GRACE_S to close on its own, then kills the
# whole subtree.
RED_AFK_WATCHDOG_GRACE_S="${RED_AFK_WATCHDOG_GRACE_S:-30}"
SENTINEL_LINE_REGEX='^<promise>(DONE|BLOCKED)</promise>$'
CLAUDE_ASSISTANT_TEXT_JQ='select(.type == "assistant").message.content[]? | select(.type == "text").text // empty'
CODEX_ASSISTANT_TEXT_JQ='select(.type == "item.completed") | .item.text // empty'

run_sentinel_watchdog() {
  local pipe_pid="$1" capture_file="$2" jq_filter="${3:-$CLAUDE_ASSISTANT_TEXT_JQ}"
  while kill -0 "$pipe_pid" 2>/dev/null; do
    if jq -r "$jq_filter" "$capture_file" 2>/dev/null \
        | grep -qE "$SENTINEL_LINE_REGEX"; then
      sleep "$RED_AFK_WATCHDOG_GRACE_S"
      if kill -0 "$pipe_pid" 2>/dev/null; then
        printf '[afk] watchdog: inner emitted sentinel but pipeline still open after %ss — killing tree (likely bash-hang from polling without timeout)\n' \
          "$RED_AFK_WATCHDOG_GRACE_S" >&2
        kill_tree "$pipe_pid" TERM
        sleep 5
        kill -0 "$pipe_pid" 2>/dev/null && kill_tree "$pipe_pid" KILL
      fi
      return 0
    fi
    sleep 2
  done
}

run_claude() {
  local worktree="$1" prompt="$2"
  local tmp; tmp="$(mktemp)"
  local log_target="${ITER_LOG:-/dev/null}"

  (
    cd "$worktree"
    claude --model opus --effort medium --permission-mode bypassPermissions \
           --output-format stream-json --verbose --print "$prompt" 2>&1 \
      | grep --line-buffered '^{' \
      | tee "$tmp" \
      | jq --unbuffered -rj 'select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | . + "\n"' \
        2>/dev/null \
      | tee -a "$log_target" \
      || true
  ) &
  local pipe_pid=$!

  run_sentinel_watchdog "$pipe_pid" "$tmp" &
  local wd_pid=$!

  wait "$pipe_pid" 2>/dev/null || true
  kill "$wd_pid" 2>/dev/null || true
  wait "$wd_pid" 2>/dev/null || true

  jq -r 'select(.type == "result").result // empty' "$tmp" 2>/dev/null || echo ""
  rm -f "$tmp"
}

run_codex() {
  local worktree="$1" prompt="$2"
  local last; last="$(mktemp)"
  local raw; raw="$(mktemp)"
  local log_target="${ITER_LOG:-/dev/null}"

  (
    codex exec --json -C "$worktree" \
      --sandbox danger-full-access \
      --dangerously-bypass-approvals-and-sandbox \
      --output-last-message "$last" \
      "$prompt" </dev/null 2>&1 \
      | tee "$raw" \
      | jq --unbuffered -rj 'select(.type == "item.completed") | .item.text // empty | . + "\n"' \
        2>/dev/null \
      | tee -a "$log_target" \
      || true
  ) &
  local pipe_pid=$!

  run_sentinel_watchdog "$pipe_pid" "$raw" "$CODEX_ASSISTANT_TEXT_JQ" &
  local wd_pid=$!

  wait "$pipe_pid" 2>/dev/null || true
  kill "$wd_pid" 2>/dev/null || true
  wait "$wd_pid" 2>/dev/null || true

  cat "$last" 2>/dev/null || echo ""
  rm -f "$last" "$raw"
}

# ---------- feedback loops ----------
feedback() {
  local worktree="$1"
  local report=""
  for script in test typecheck lint build; do
    if (cd "$worktree" && jq -e ".scripts.\"$script\"" package.json >/dev/null 2>&1); then
      if (cd "$worktree" && pnpm "$script" >/tmp/afk-$script.log 2>&1); then
        report+="$script:✓ "
      else
        report+="$script:✗ "
      fi
    else
      report+="$script:- "
    fi
  done
  echo "$report"
}

# ---------- merge & push ----------
do_merge() {
  local branch="$1" n="$2" title="$3"

  # dirty primary → snapshot commit
  if [[ -n "$(git -C "$PROJECT_ROOT" status --porcelain)" ]]; then
    git -C "$PROJECT_ROOT" add -A
    git -C "$PROJECT_ROOT" commit -m "chore(afk): pre-merge snapshot for #${n}"
  fi

  git -C "$PROJECT_ROOT" fetch origin main --quiet

  # Integrate the freshly-fetched origin/main into local main BEFORE merging.
  # `git fetch` only moves the origin/main ref; without this the worker branch
  # would merge onto the stale boot-time HEAD and the eventual push would be
  # rejected non-fast-forward whenever origin moved mid-run (issue #37).
  if ! merge_integrate_origin "$PROJECT_ROOT" origin main; then
    log "✗ #$n could not integrate origin/main before merge (diverged/conflict) — aborting merge"
    return 1
  fi

  # pre-merge hook — fires just before `git merge --no-ff`. RED_AFK_MERGE_BASE is
  # the merge base between primary main and the iteration branch. Non-zero
  # abort funnels through the existing merge-conflict path in process_issue.
  local merge_base
  merge_base="$(git -C "$PROJECT_ROOT" merge-base HEAD "$branch" 2>/dev/null || true)"
  if ! run_lifecycle_hook pre-merge "RED_AFK_MERGE_BASE=${merge_base}"; then
    local hook_rc=$?
    log "✗ pre-merge hook failed (rc=$hook_rc) for #$n — aborting merge"
    return 1
  fi

  # Capture the integrated tip so a rejected push can be rolled back to it,
  # leaving no orphan merge commit on local main.
  local pre_merge_sha
  pre_merge_sha="$(git -C "$PROJECT_ROOT" rev-parse HEAD)"

  git -C "$PROJECT_ROOT" merge --no-ff "$branch" -m "merge: #${n} ${title}" 2>&1 | tee /tmp/afk-merge.log
  local rc=${PIPESTATUS[0]}
  if [[ $rc -ne 0 ]]; then
    # Conflict → one-shot inner-agent resolver (SKILL.md per-issue loop step 8)
    # before giving up. On resolver success the merge is committed; fall
    # through to push. On failure, abort cleanly.
    if ! merge_resolve_conflict "$branch" "$n" "$title"; then
      git -C "$PROJECT_ROOT" merge --abort 2>/dev/null || true
      return 1
    fi
  fi

  if ! git -C "$PROJECT_ROOT" push origin main; then
    # Push rejected (origin moved again, or hook). Roll the merge commit back to
    # the integrated tip so local main carries no orphan merge commit before the
    # issue is flipped to ready-for-human.
    log "✗ #$n push to origin/main rejected — rolling back merge commit to keep local main clean"
    merge_rollback "$PROJECT_ROOT" "$pre_merge_sha"
    return 1
  fi

  # post-merge hook — after the push to origin/main succeeds. RED_AFK_MERGE_SHA
  # is the short SHA of the merge commit on primary. Non-zero is logged by
  # hooks.sh; we do not roll back the merge.
  local merge_sha
  merge_sha="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
  run_lifecycle_hook post-merge "RED_AFK_MERGE_SHA=${merge_sha}" || true
}

# merge_resolve_conflict <branch> <n> <title>
# One-shot inner-agent conflict resolver (SKILL.md per-issue loop step 8).
# A `git merge --no-ff <branch>` into main has left conflicts in the primary
# checkout. Re-enter the configured runner *in the primary checkout* with the
# conflict diff + `git status` as context, instructing it to resolve the
# conflicts and commit the merge. Returns 0 iff the merge is resolved and
# committed (no unmerged paths, no MERGE_HEAD left behind), else 1.
merge_resolve_conflict() {
  local branch="$1" n="$2" title="$3"
  log "↻ #$n merge conflict — dispatching one-shot inner-agent resolver"

  local status diff
  status="$(git -C "$PROJECT_ROOT" status 2>&1 || true)"
  diff="$(git -C "$PROJECT_ROOT" diff 2>&1 | head -n 400 || true)"

  local prompt
  prompt="$(cat <<EOF
You are an AFK merge-conflict resolver. A \`git merge --no-ff $branch\` into \`main\` for issue #$n ("$title") hit conflicts in THIS checkout. Resolve every conflict, then commit the merge.

Rules:
- Work only in this checkout. Do NOT switch branches, \`git merge --abort\`, \`git reset\`, \`git rebase\`, or push.
- Resolve each conflicted file by hand, honouring both sides' intent, then \`git add\` it.
- When all conflicts are staged, run \`git commit --no-edit\` to complete the merge. Do not change the merge message or introduce unrelated edits.
- When the merge is committed (or you have determined you cannot resolve it), emit \`<promise>DONE</promise>\` on a line by itself as your final output.

\`git status\`:
$status

\`git diff\` (truncated to 400 lines):
$diff
EOF
)"

  if [[ "$RUNNER" == "claude" ]]; then
    run_claude "$PROJECT_ROOT" "$prompt" >/dev/null 2>&1 || true
  else
    run_codex "$PROJECT_ROOT" "$prompt" >/dev/null 2>&1 || true
  fi

  # Resolved iff no unmerged paths remain AND the merge was committed
  # (MERGE_HEAD cleared). Either condition failing → fall back to abort.
  local unmerged
  unmerged="$(git -C "$PROJECT_ROOT" diff --name-only --diff-filter=U 2>/dev/null)"
  if [[ -n "$unmerged" ]]; then
    log "✗ #$n resolver left unmerged paths — falling back to merge --abort"
    return 1
  fi
  if git -C "$PROJECT_ROOT" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1; then
    log "✗ #$n resolver did not commit the merge — falling back to merge --abort"
    return 1
  fi
  log "✓ #$n resolver completed the merge"
  return 0
}

# ---------- per-issue processing ----------
process_issue() {
  local n="$1" title="$2" body="$3"
  local slug; slug="$(slugify "$title")"
  local branch="afk/${WORKER_ID}/${n}-${slug}"
  local started_at; started_at="$(date -Iseconds)"
  local started_epoch; started_epoch="$(date +%s)"

  hr; log "▶ #$n $title (runner=$RUNNER)"

  # per-issue BLOCKED cap gate (PRD #29 Track B) — checked *before* claiming.
  # Count the trailing run of BLOCKED attempts since the last human directive;
  # at or above the cap, flip the issue to ready-for-human and skip it without
  # recording a worker spawn. Never claim an issue that keeps coming back
  # BLOCKED with no fresh guidance to break the loop.
  local cap; cap="$(per_issue_cap)"
  local cap_comments
  cap_comments="$(gh -R "$(gh_repo)" issue view "$n" --json comments \
    --jq '.comments | map({author: {login: .author.login}, body: .body, createdAt: .createdAt})' 2>/dev/null)"
  [[ -z "$cap_comments" ]] && cap_comments='[]'
  local blocked_count; blocked_count="$(count_blocked_since_guidance "$cap_comments")"
  if (( blocked_count >= cap )); then
    local lacks_marker; lacks_marker="$(_thread_lacks_directive_marker "$cap_comments")"
    log "⛔ #$n hit per-issue cap (${blocked_count} ≥ ${cap} consecutive BLOCKED) — flipping to ready-for-human, skipping"
    trip_per_issue_cap "$n" "$blocked_count" "$lacks_marker"
    return 0
  fi

  # claim — three layers (see claim_lock_acquire comment for the why):
  # 1. local mkdir lock so two workers on this checkout can't both pass.
  if ! claim_lock_acquire "$n"; then
    log "local claim lock held for #$n (another worker on this checkout) — skipping"
    return 0
  fi

  # 2. pre-check: ready-for-agent must still be present. Skip if another
  #    worker (or human) raced us between issue selection and now.
  local repo; repo="$(gh_repo)"
  local cur_labels
  cur_labels=",$(gh -R "$repo" issue view "$n" --json labels --jq '[.labels[].name] | join(",")' 2>/dev/null || true),"
  if [[ "$cur_labels" != *",ready-for-agent,"* ]]; then
    log "#$n is no longer ready-for-agent (raced) — skipping"
    claim_lock_release "$n"
    return 0
  fi
  if [[ "$cur_labels" == *",running,"* ]]; then
    log "#$n already labelled running (claimed by another worker) — skipping"
    claim_lock_release "$n"
    return 0
  fi

  # 3. the actual edit. Still not atomic on the gh side, but the local
  #    lock + pre-check eliminate the realistic race surface.
  if ! gh -R "$repo" issue edit "$n" \
        --remove-label ready-for-agent --add-label running >/dev/null 2>&1; then
    log "could not claim #$n (gh edit failed) — skipping"
    claim_lock_release "$n"
    return 0
  fi

  iter_open "$n"
  local worktree="$ITER_DIR/worktree"
  local worktree_rel=".red/tmp/work-${WORKER_ID}-i${n}/worktree"

  # Lifecycle cursor used by run_lifecycle_hook.
  CURRENT_ISSUE="$n"
  CURRENT_BRANCH="$branch"

  # pre-iteration hook — after a successful claim, before any worktree setup.
  # A non-zero exit aborts the iteration: the claim is released back to
  # `ready-for-agent`, ITER_DIR is torn down, and we never create the worktree.
  if ! run_lifecycle_hook pre-iteration; then
    local hook_rc=$?
    log "✗ pre-iteration hook failed (rc=$hook_rc) for #$n — aborting iteration, restoring ready-for-agent"
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null 2>&1 || true
    gh -R "$(gh_repo)" issue comment "$n" --body "🤖 /afk aborted before worktree setup: pre-iteration hook exited \`$hook_rc\`. Restored \`ready-for-agent\`." >/dev/null 2>&1 || true
    [[ -n "$ITER_DIR" && -d "$ITER_DIR" ]] && rm -rf "$ITER_DIR"
    ITER_DIR="" STATE_FILE="" ITER_LOG="" ITER_PID_FILE=""
    claim_lock_release "$n"
    CURRENT_ISSUE="" CURRENT_BRANCH=""
    return 0
  fi

  gh -R "$(gh_repo)" issue comment "$n" \
    --body "🤖 /afk started at \`$started_at\` on runner \`$RUNNER\` (worker \`$WORKER_ID\`). worktree: \`$worktree_rel\`" >/dev/null

  # worktree
  git -C "$PROJECT_ROOT" fetch origin main --quiet
  git -C "$PROJECT_ROOT" worktree add "$worktree" -b "$branch" origin/main >/dev/null

  state_write "$STATE_FILE" \
    current.number:=$n \
    current.title="$title" \
    current.slug="$slug" \
    current.worktree="$worktree_rel" \
    current.handoff=".red/tmp/work-${WORKER_ID}-i${n}/handoff.md" \
    current.started_at="$started_at" \
    current.stage=setup \
    current.heartbeat_glyph:=null \
    current.heartbeat_pid:=null \
    current.runner="$RUNNER" \
    current.retries:=0 \
    current.last_stream_line=""

  local attempt=1
  local handoff
  handoff="$(write_handoff "$n" "$title" "$slug" "$body" "$worktree" "$RUNNER" "$attempt")"

  heartbeat_start "$n"
  state_write "$STATE_FILE" current.stage=impl

  local result
  result="$(run_inner "$worktree" "$handoff" "$RUNNER")"

  if [[ $RUNNER_EXHAUSTED -eq 1 ]]; then
    heartbeat_stop
    if [[ $FALLBACK_RUNNER -eq 1 ]]; then
      local other="claude"; [[ "$RUNNER" == "claude" ]] && other="codex"
      log "runner $RUNNER exhausted — swapping to $other and retrying #$n (--fallback-runner)"
      RUNNER="$other"
      attempt=$((attempt+1))
      handoff="$(write_handoff "$n" "$title" "$slug" "$body" "$worktree" "$RUNNER" "$attempt")"
      heartbeat_start "$n"
      result="$(run_inner "$worktree" "$handoff" "$RUNNER")"
      if [[ $RUNNER_EXHAUSTED -eq 1 ]]; then
        heartbeat_stop
        gh -R "$(gh_repo)" issue comment "$n" --body "Both runners exhausted. Iteration preserved at \`$ITER_DIR\`." >/dev/null
        gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null
        history_append "exhausted" "$n" "$RUNNER" 0 "" "both-runners"
        local dur_ex=$(( $(date +%s) - started_epoch ))
        snapshot_iter_for_hook
        iter_close_preserve
        fire_post_iteration "discarded" "$dur_ex"
        exit 75
      fi
    else
      log "runner $RUNNER exhausted — exiting (no --fallback-runner; rerun /afk when quota resets, or pass --fallback-runner to swap)"
      gh -R "$(gh_repo)" issue comment "$n" --body "Runner \`$RUNNER\` exhausted; rerun /afk when quota resets, or pass \`--fallback-runner\` to swap to the other runner on exhaustion." >/dev/null
      gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null
      history_append "exhausted" "$n" "$RUNNER" 0 "" "$RUNNER"
      local dur_ex=$(( $(date +%s) - started_epoch ))
      snapshot_iter_for_hook
      iter_close_preserve
      fire_post_iteration "discarded" "$dur_ex"
      exit 75
    fi
  fi

  heartbeat_stop

  # sentinel detection
  if echo "$result" | grep -q '<promise>BLOCKED</promise>'; then
    log "✗ #$n blocked by inner agent"
    local dur_blocked=$(( $(date +%s) - started_epoch ))
    local notes_file diff_file remote_branch
    notes_file="$(mktemp)"; diff_file="$(mktemp)"
    extract_handoff_notes "$handoff" > "$notes_file" || true
    [[ -s "$notes_file" ]] || printf '_(inner agent emitted BLOCKED without appending Notes — see iteration log at `%s`)_' "$ITER_DIR" > "$notes_file"
    remote_branch="$(push_attempt_branch "$branch" "$n" "$slug" || true)"
    build_diff_section_body "$branch" "$remote_branch" "$worktree_rel" > "$diff_file"
    emit_envelope "blocked" "$n" "$dur_blocked" "$branch" "$attempt" "" \
      "notes" "$notes_file" \
      "diff"  "$diff_file" || true
    rm -f "$notes_file" "$diff_file"
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_write "$STATE_FILE" blocked:=$AGG_BLOCKED current:=null
    history_append "blocked" "$n" "$RUNNER" "$dur_blocked" "" "inner-agent"
    snapshot_iter_for_hook
    iter_close_preserve
    fire_post_iteration "blocked" "$dur_blocked"
    return 0
  fi

  if ! echo "$result" | grep -q '<promise>DONE</promise>'; then
    log "✗ #$n inner agent ended without DONE sentinel — treating as blocker"
    local dur_ns=$(( $(date +%s) - started_epoch ))
    local notes_file log_file diff_file remote_branch
    notes_file="$(mktemp)"; log_file="$(mktemp)"; diff_file="$(mktemp)"
    extract_handoff_notes "$handoff" > "$notes_file" || true
    [[ -s "$notes_file" ]] || printf '_(no Notes appended; inner agent exited without a sentinel)_' > "$notes_file"
    tail_iter_log 50 > "$log_file" || true
    [[ -s "$log_file" ]] || printf '(no captured stdout)' > "$log_file"
    remote_branch="$(push_attempt_branch "$branch" "$n" "$slug" || true)"
    build_diff_section_body "$branch" "$remote_branch" "$worktree_rel" > "$diff_file"
    emit_envelope "no-sentinel" "$n" "$dur_ns" "$branch" "$attempt" "" \
      "notes" "$notes_file" \
      "diff"  "$diff_file" \
      "log"   "$log_file" || true
    rm -f "$notes_file" "$log_file" "$diff_file"
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_write "$STATE_FILE" blocked:=$AGG_BLOCKED current:=null
    history_append "blocked" "$n" "$RUNNER" "$dur_ns" "" "no-sentinel"
    snapshot_iter_for_hook
    iter_close_preserve
    fire_post_iteration "no-sentinel" "$dur_ns"
    return 0
  fi

  # feedback loops
  state_write "$STATE_FILE" current.stage=tests
  local fb; fb="$(feedback "$worktree")"
  log "feedback: $fb"

  # merge
  state_write "$STATE_FILE" current.stage=merge
  if ! do_merge "$branch" "$n" "$title"; then
    log "✗ #$n merge failed (resolver exhausted or push rejected) — flipping to ready-for-human"
    local dur_mc=$(( $(date +%s) - started_epoch ))
    local log_file diff_file remote_branch
    log_file="$(mktemp)"; diff_file="$(mktemp)"
    tail -n 50 /tmp/afk-merge.log 2>/dev/null > "$log_file" || true
    [[ -s "$log_file" ]] || printf '(no merge log captured)' > "$log_file"
    remote_branch="$(push_attempt_branch "$branch" "$n" "$slug" || true)"
    build_diff_section_body "$branch" "$remote_branch" "$worktree_rel" > "$diff_file"
    emit_envelope "merge-conflict" "$n" "$dur_mc" "$branch" "$attempt" "" \
      "diff" "$diff_file" \
      "log"  "$log_file" || true
    rm -f "$log_file" "$diff_file"
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_write "$STATE_FILE" blocked:=$AGG_BLOCKED current:=null
    history_append "blocked" "$n" "$RUNNER" "$dur_mc" "" "merge-conflict"
    snapshot_iter_for_hook
    iter_close_preserve
    fire_post_iteration "merge-conflict" "$dur_mc"
    return 0
  fi

  # close
  state_write "$STATE_FILE" current.stage=close
  local merge_sha; merge_sha="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
  local dur=$(( $(date +%s) - started_epoch ))
  emit_envelope "done" "$n" "$dur" "$branch" "$attempt" "$merge_sha" || true
  gh -R "$(gh_repo)" issue close "$n" --reason completed >/dev/null
  gh -R "$(gh_repo)" issue edit "$n" --remove-label running >/dev/null 2>&1 || true

  # cleanup
  git -C "$PROJECT_ROOT" worktree remove "$worktree" --force 2>/dev/null || log "could not remove worktree $worktree"
  git -C "$PROJECT_ROOT" branch -d "$branch" 2>/dev/null || true

  # aggregate state (in-memory; persists across iterations via next iter_open).
  AGG_DONE=$((AGG_DONE+1))
  AGG_COMPLETED="$(jq -c --argjson n "$n" '. + [$n]' <<<"$AGG_COMPLETED")"
  AGG_DURATIONS="$(jq -c --argjson d "$dur" '. + [$d]' <<<"$AGG_DURATIONS")"
  state_write "$STATE_FILE" \
    completed:="$AGG_COMPLETED" \
    done:=$AGG_DONE \
    durations_seconds:="$AGG_DURATIONS" \
    current:=null
  history_append "done" "$n" "$RUNNER" "$dur" "$merge_sha" ""
  snapshot_iter_for_hook
  iter_close_success
  fire_post_iteration "done" "$dur"

  log "✓ #$n done in ${dur}s — merge $merge_sha — $fb"

  # rotate runner for next issue if alternating
  if [[ $ALTERNATE -eq 1 ]]; then
    [[ "$RUNNER" == "claude" ]] && RUNNER="codex" || RUNNER="claude"
  fi
}

# ---------- signal handling ----------
cleanup() {
  heartbeat_stop
  # release any in-flight claim so the next /afk run can pick it up
  local current_n=""
  if [[ -n "$STATE_FILE" && -f "$STATE_FILE" ]]; then
    local _cleanup_current_number=""
    state_read_into _cleanup "$STATE_FILE" 2>/dev/null
    current_n="$_cleanup_current_number"
  fi
  if [[ -n "$current_n" ]]; then
    gh -R "$(gh_repo)" issue edit "$current_n" \
      --remove-label running --add-label ready-for-agent >/dev/null 2>&1 || true
    gh -R "$(gh_repo)" issue comment "$current_n" \
      --body "🤖 /afk interrupted. claim released; iteration preserved at \`$ITER_DIR\`." >/dev/null 2>&1 || true
  fi
  log "interrupted — iteration preserved at ${ITER_DIR:-<none>}"
  iter_close_preserve
  exit 130
}
trap cleanup INT TERM

# When sourced (e.g. from test harnesses), skip the orchestrator's main block —
# expose every function for unit testing without invoking the real loop.
[[ "${BASH_SOURCE[0]}" != "$0" ]] && return 0 2>/dev/null

# ---------- pre-spawn boot-log ----------
# Run the generic hook orchestrator's `pre-spawn` chain once at worker
# boot. Detectors that apply write KEY=value lines into their per-call
# env-file; hooks.sh sources those back into this shell, so exports
# propagate to every issue spawned by this worker. We announce the
# applied detector names (skipping not-applicable / config-disabled
# ones) to the worker's stderr log, which the supervisor captures into
# .red/tmp/afk-supervisor-slot-N.log when present.
log_applied_detectors_boot_line() {
  export RED_AFK_SLOT="${RED_AFK_SLOT:-0}"
  export RED_AFK_PLUGIN_DIR="${SKILL_DIR}"
  export PROJECT_ROOT
  hooks_run pre-spawn || true
  if (( ${#HOOKS_APPLIED_DETECTORS[@]} > 0 )); then
    local joined; joined="${HOOKS_APPLIED_DETECTORS[*]}"
    log "pre-spawn: applied detectors [${joined// /, }]"
  fi
}

# ---------- main ----------
precheck
bootstrap
log "runner: $RUNNER (detected via $RUNNER_DETECTION_METHOD)"
log_applied_detectors_boot_line
prune_orphans
sweep_unblocked

# --- straggler check: warn about issues that never made it to ready-for-agent
straggler_check() {
  local repo; repo="$(gh_repo)"
  local unlabeled needs_triage needs_info needs_slicing
  unlabeled="$(gh -R "$repo" issue list --state open --search 'no:label' --json number --jq 'length' 2>/dev/null || echo 0)"
  needs_triage="$(gh -R "$repo" issue list --state open --label needs-triage --json number --jq 'length' 2>/dev/null || echo 0)"
  needs_info="$(gh -R "$repo" issue list --state open --label needs-info --json number --jq 'length' 2>/dev/null || echo 0)"
  needs_slicing="$(gh -R "$repo" issue list --state open --label needs-slicing --json number --jq 'length' 2>/dev/null || echo 0)"

  if [[ "$unlabeled" -gt 0 || "$needs_triage" -gt 0 || "$needs_info" -gt 0 || "$needs_slicing" -gt 0 ]]; then
    log "⚠ stragglers detected: $unlabeled unlabeled, $needs_triage needs-triage, $needs_info needs-info, $needs_slicing needs-slicing"
    log "  needs-slicing → run /to-issues on those PRDs. others → run /triage."
    if [[ -t 0 && $ONCE -eq 0 ]]; then
      read -r -p "[afk] proceed anyway? [y/N] " ans
      [[ "$ans" =~ ^[yY]$ ]] || { log "aborted by user"; exit 0; }
    fi
  fi
}
straggler_check

ISSUES_JSON="$(select_issues)"
TOTAL="$(echo "$ISSUES_JSON" | jq 'length')"
[[ "$TOTAL" -eq 0 ]] && { echo "<promise>NO MORE TASKS</promise>"; exit 0; }

NUMBERS=()
while IFS= read -r n; do NUMBERS+=("$n"); done < <(echo "$ISSUES_JSON" | jq '.[].number')

AGG_TOTAL=$TOTAL
AGG_QUEUE="$(echo "$ISSUES_JSON" | jq -c '[.[].number]')"

log "/afk: $TOTAL issue(s) queued (filter=$FILTER_KIND${FILTER_VALUE:+:$FILTER_VALUE}, runner=$RUNNER, cap=$ITER_CAP, worker=$WORKER_ID)"

I=0
for n in "${NUMBERS[@]}"; do
  I=$((I+1))
  [[ $I -gt $ITER_CAP ]] && break

  TITLE="$(echo "$ISSUES_JSON" | jq -r --arg n "$n" '.[] | select(.number == ($n|tonumber)) | .title')"
  BODY="$(echo  "$ISSUES_JSON" | jq -r --arg n "$n" '.[] | select(.number == ($n|tonumber)) | .body')"

  process_issue "$n" "$TITLE" "$BODY"

  REMAINING=$((TOTAL - I))
  PCT=$(( I * 100 / TOTAL ))
  log "progress: $I/$TOTAL (${PCT}%) — $REMAINING remaining"

  [[ $ONCE -eq 1 ]] && break
done

hr
log "/afk done. worker: $WORKER_ID, processed: $AGG_DONE done, $AGG_BLOCKED blocked"
echo "<promise>NO MORE TASKS</promise>"
