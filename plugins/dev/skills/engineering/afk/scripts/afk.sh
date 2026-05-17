#!/usr/bin/env bash
# /afk — autonomous loop that drains `ready-for-agent` issues.
#
# Usage:
#   afk.sh [--prd N | --issues N,N,N] [--runner claude|codex] [-n N] [--once] [project_root]
#
# See ../SKILL.md for the full contract. SAFETY.md is binding.

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

# ---------- arg parsing ----------
RUNNER=""
ITER_CAP=999
ONCE=0
FILTER_KIND="all"
FILTER_VALUE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prd)     FILTER_KIND="prd";    FILTER_VALUE="$2"; shift 2 ;;
    --issues)  FILTER_KIND="issues"; FILTER_VALUE="$2"; shift 2 ;;
    --runner)  RUNNER="$2"; shift 2 ;;
    -n)        ITER_CAP="$2"; shift 2 ;;
    --once)    ONCE=1; ITER_CAP=1; shift ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *)         PROJECT_ROOT="$1"; shift ;;
  esac
done

PROJECT_ROOT="${PROJECT_ROOT:-$(pwd)}"
PROJECT_ROOT="$(cd "$PROJECT_ROOT" && pwd)"
REPO_NAME="$(basename "$PROJECT_ROOT")"
TMP_DIR="$PROJECT_ROOT/.red/tmp"
STATE_DIR="$PROJECT_ROOT/.red/state"
HISTORY_FILE="$STATE_DIR/afk-history.jsonl"
HISTORY_MAX_LINES=10000

# Worker ID — 4 chars from [a-z0-9]. Regenerated until no live .red/tmp/work-{id}-i*/afk.pid exists.
gen_worker_id() {
  local id
  while :; do
    id="$(LC_ALL=C tr -dc 'a-z0-9' </dev/urandom | head -c 4)"
    [[ -z "$(ls -d "$TMP_DIR"/work-"$id"-i* 2>/dev/null)" ]] && { echo "$id"; return; }
  done
}
WORKER_ID=""        # set in bootstrap
ITER_DIR=""         # set per-iteration: $TMP_DIR/work-$WORKER_ID-i$N
STATE_FILE=""       # set per-iteration: $ITER_DIR/afk.state.json
ITER_LOG=""         # set per-iteration: $ITER_DIR/afk.log
ITER_PID_FILE=""    # set per-iteration: $ITER_DIR/afk.pid

EXPLICIT_RUNNER=$RUNNER
[[ -z "$RUNNER" ]] && RUNNER="${AFK_RUNNER:-claude}"
ALTERNATE=1
[[ -n "${AFK_RUNNER_PINNED:-}" || -n "$EXPLICIT_RUNNER" ]] && ALTERNATE=0
# explicit --runner pins the runner
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
#   - kill zombie heartbeat sub-shell (if state file records its pid)
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

    # zombie heartbeat → kill
    if [[ -f "$state_file" ]]; then
      local hb; hb="$(jq -r '.current.heartbeat_pid // empty' "$state_file" 2>/dev/null)"
      [[ -n "$hb" && "$hb" != "null" ]] && kill "$hb" 2>/dev/null || true
    fi

    local mtime_s; mtime_s="$(stat -c %Y "$d" 2>/dev/null || echo 0)"
    local safe=0
    local issue_n=""
    [[ -f "$state_file" ]] && issue_n="$(jq -r '.current.number // empty' "$state_file" 2>/dev/null)"

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
          safe=0
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
  state_init "$n"
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
}

# ---------- state file ----------
state_write() {
  local data="$1"
  [[ -z "$STATE_FILE" ]] && return 0
  local tmp="${STATE_FILE}.tmp"
  printf '%s' "$data" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_read() { cat "$STATE_FILE" 2>/dev/null || echo '{}'; }

state_init() {
  local n="$1"
  state_write "$(jq -n \
    --arg started "$AGG_STARTED" \
    --arg runner "$RUNNER" \
    --arg fk "$FILTER_KIND" \
    --arg fv "$FILTER_VALUE" \
    --arg wid "$WORKER_ID" \
    --arg log "$ITER_LOG" \
    --argjson pid "$$" \
    --argjson total "$AGG_TOTAL" \
    --argjson done "$AGG_DONE" \
    --argjson failed "$AGG_FAILED" \
    --argjson blocked "$AGG_BLOCKED" \
    --argjson completed "$AGG_COMPLETED" \
    --argjson queue "$AGG_QUEUE" \
    --argjson durs "$AGG_DURATIONS" \
    '{version:1, worker_id:$wid, pid:$pid, log:$log,
      started_at:$started, runner:$runner,
      filter:{kind:$fk, value:$fv},
      total:$total, done:$done, failed:$failed, blocked:$blocked,
      completed:$completed, queue:$queue, current:null,
      durations_seconds:$durs}')"
}

state_set() {
  # state_set <jq filter>
  [[ -z "$STATE_FILE" ]] && return 0
  local new
  new="$(state_read | jq -c "$1")"
  state_write "$new"
}

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

  case "$FILTER_KIND" in
    issues)
      echo "$raw" | jq --arg list "$FILTER_VALUE" '
        ($list | split(",") | map(tonumber)) as $want
        | map(select(.number as $n | $want | index($n))) '
      ;;
    prd)
      echo "$raw" | jq --arg prd "$FILTER_VALUE" '
        map(select(
          (.body // "") | test("prd:\\s*#?" + $prd + "\\b")
          or ((.labels | map(.name)) | index("prd:" + $prd))
        )) '
      ;;
    *)
      echo "$raw" | jq '.'
      ;;
  esac \
  | jq 'sort_by(
      # priority:high → 0, priority:low or unlabelled → 1
      ((.labels | map(.name) | map(select(. == "priority:high")) | length) | (if . > 0 then 0 else 1 end)),
      .number
    )'
}

gh_repo() {
  git -C "$PROJECT_ROOT" remote get-url origin \
    | sed -E 's#.*[:/]([^/]+/[^/]+?)(\.git)?$#\1#' \
    | sed -E 's#\.git$##'
}

# ---------- heartbeat ----------
HEARTBEAT_PID=""
heartbeat_start() {
  local issue="$1"
  (
    local glyphs=(':one:' ':two:' ':three:' ':four:')
    local i=0
    while sleep 600; do
      gh -R "$(gh_repo)" issue comment "$issue" \
        --body "${glyphs[$((i % 4))]}" >/dev/null 2>&1 || true
      i=$((i+1))
      state_set ".current.heartbeat_glyph = \"${glyphs[$(((i-1) % 4))]}\""
    done
  ) &
  HEARTBEAT_PID=$!
  state_set ".current.heartbeat_pid = $HEARTBEAT_PID"
}
heartbeat_stop() {
  [[ -n "$HEARTBEAT_PID" ]] && kill "$HEARTBEAT_PID" 2>/dev/null || true
  HEARTBEAT_PID=""
}

# ---------- handoff file ----------
write_handoff() {
  local n="$1" title="$2" slug="$3" body="$4" worktree="$5" runner="$6" attempt="$7"
  # Handoff file lives in the iteration directory (one level above the worktree).
  local handoff="$ITER_DIR/handoff.md"

  # Try to pull an AGENT-BRIEF comment from triage; fall back to issue body.
  local brief
  brief="$(gh -R "$(gh_repo)" issue view "$n" --json comments \
            --jq '.comments[] | select(.body | startswith("## AGENT-BRIEF")) | .body' \
            2>/dev/null | tail -n1)"
  [[ -z "$brief" ]] && brief="$body"

  local url
  url="$(gh -R "$(gh_repo)" issue view "$n" --json url --jq .url)"

  {
    echo "# Issue #${n} — ${title} [AFK]"
    echo
    echo "source: ${url}"
    [[ "$FILTER_KIND" == "prd" ]] && echo "prd: #${FILTER_VALUE}"
    echo "runner: ${runner}"
    echo "started: $(date -Iseconds)"
    echo "attempt: ${attempt}"
    echo
    echo "## Brief"
    echo "${brief}"
    echo
    echo "## Notes"
    echo "<!-- inner agent appends progress/blockers here across attempts -->"
  } > "$handoff"

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

run_claude() {
  local worktree="$1" prompt="$2"
  local tmp; tmp="$(mktemp)"
  (
    cd "$worktree"
    claude --model opus --effort medium --permission-mode bypassPermissions \
           --output-format stream-json --verbose --print "$prompt" 2>&1 \
      | grep --line-buffered '^{' \
      | tee "$tmp" \
      | jq --unbuffered -rj 'select(.type == "assistant").message.content[]? | select(.type == "text").text // empty | . + "\n"' \
        2>/dev/null || true
  )
  jq -r 'select(.type == "result").result // empty' "$tmp" 2>/dev/null || echo ""
  rm -f "$tmp"
}

run_codex() {
  local worktree="$1" prompt="$2"
  local last; last="$(mktemp)"
  codex exec --json -C "$worktree" \
    --sandbox danger-full-access \
    --dangerously-bypass-approvals-and-sandbox \
    --output-last-message "$last" \
    "$prompt" </dev/null 2>&1 \
    | jq --unbuffered -rj 'select(.type == "item.completed") | .item.text // empty | . + "\n"' \
      2>/dev/null || true
  cat "$last" 2>/dev/null || echo ""
  rm -f "$last"
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
  git -C "$PROJECT_ROOT" merge --no-ff "$branch" -m "merge: #${n} ${title}" 2>&1 | tee /tmp/afk-merge.log
  local rc=${PIPESTATUS[0]}
  if [[ $rc -ne 0 ]]; then
    git -C "$PROJECT_ROOT" merge --abort 2>/dev/null || true
    return 1
  fi
  git -C "$PROJECT_ROOT" push origin main
}

# ---------- per-issue processing ----------
process_issue() {
  local n="$1" title="$2" body="$3"
  local slug; slug="$(slugify "$title")"
  local branch="afk/${WORKER_ID}/${n}-${slug}"
  local started_at; started_at="$(date -Iseconds)"
  local started_epoch; started_epoch="$(date +%s)"

  hr; log "▶ #$n $title (runner=$RUNNER)"

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

  gh -R "$(gh_repo)" issue comment "$n" \
    --body "🤖 /afk started at \`$started_at\` on runner \`$RUNNER\` (worker \`$WORKER_ID\`). worktree: \`$worktree_rel\`" >/dev/null

  # worktree
  git -C "$PROJECT_ROOT" fetch origin main --quiet
  git -C "$PROJECT_ROOT" worktree add "$worktree" -b "$branch" origin/main >/dev/null

  state_set "
    .current = {
      number: $n, title: \"$(printf %s "$title" | jq -Rs '.' | sed 's/^\"//;s/\"$//')\",
      slug: \"$slug\", worktree: \"$worktree_rel\",
      handoff: \".red/tmp/work-${WORKER_ID}-i${n}/handoff.md\",
      started_at: \"$started_at\", stage: \"setup\",
      heartbeat_glyph: \"\", heartbeat_pid: null,
      runner: \"$RUNNER\", retries: 0, last_stream_line: \"\"
    }
  "

  local attempt=1
  local handoff
  handoff="$(write_handoff "$n" "$title" "$slug" "$body" "$worktree" "$RUNNER" "$attempt")"

  heartbeat_start "$n"
  state_set ".current.stage = \"impl\""

  local result
  result="$(run_inner "$worktree" "$handoff" "$RUNNER")"

  if [[ $RUNNER_EXHAUSTED -eq 1 ]]; then
    heartbeat_stop
    if [[ $ALTERNATE -eq 1 ]]; then
      local other="claude"; [[ "$RUNNER" == "claude" ]] && other="codex"
      log "runner $RUNNER exhausted — swapping to $other and retrying #$n"
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
        iter_close_preserve
        exit 75
      fi
    else
      gh -R "$(gh_repo)" issue comment "$n" --body "Runner \`$RUNNER\` exhausted; rerun /afk when quota resets." >/dev/null
      gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null
      history_append "exhausted" "$n" "$RUNNER" 0 "" "$RUNNER"
      iter_close_preserve
      exit 75
    fi
  fi

  heartbeat_stop

  # sentinel detection
  if echo "$result" | grep -q '<promise>BLOCKED</promise>'; then
    log "✗ #$n blocked by inner agent"
    local notes
    notes="$(awk '/^## Notes$/,0' "$handoff")"
    gh -R "$(gh_repo)" issue comment "$n" --body "$(printf 'BLOCKED by inner agent.\n\n%s\n\nIteration preserved at `%s`.' "$notes" "$ITER_DIR")" >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_set ".blocked = $AGG_BLOCKED | .current = null"
    history_append "blocked" "$n" "$RUNNER" "$(( $(date +%s) - started_epoch ))" "" "inner-agent"
    iter_close_preserve
    return 0
  fi

  if ! echo "$result" | grep -q '<promise>DONE</promise>'; then
    log "✗ #$n inner agent ended without DONE sentinel — treating as blocker"
    gh -R "$(gh_repo)" issue comment "$n" --body "Inner agent exited without a sentinel. Manual review needed. Iteration at \`$ITER_DIR\`." >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_set ".blocked = $AGG_BLOCKED | .current = null"
    history_append "blocked" "$n" "$RUNNER" "$(( $(date +%s) - started_epoch ))" "" "no-sentinel"
    iter_close_preserve
    return 0
  fi

  # feedback loops
  state_set ".current.stage = \"tests\""
  local fb; fb="$(feedback "$worktree")"
  log "feedback: $fb"

  # merge
  state_set ".current.stage = \"merge\""
  if ! do_merge "$branch" "$n" "$title"; then
    log "✗ #$n merge conflict (no inner self-resolve yet)"
    local diff
    diff="$(cat /tmp/afk-merge.log 2>/dev/null | tail -50)"
    gh -R "$(gh_repo)" issue comment "$n" --body "$(printf 'Merge conflict on \`main\`. Aborted. Iteration preserved at `%s`.\n\n```\n%s\n```' "$ITER_DIR" "$diff")" >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    AGG_BLOCKED=$((AGG_BLOCKED+1))
    state_set ".blocked = $AGG_BLOCKED | .current = null"
    history_append "blocked" "$n" "$RUNNER" "$(( $(date +%s) - started_epoch ))" "" "merge-conflict"
    iter_close_preserve
    return 0
  fi

  # close
  state_set ".current.stage = \"close\""
  local merge_sha; merge_sha="$(git -C "$PROJECT_ROOT" rev-parse --short HEAD)"
  local dur=$(( $(date +%s) - started_epoch ))
  gh -R "$(gh_repo)" issue comment "$n" \
    --body "$(printf '✓ /afk done in %dm%ds.\n\nfeedback: %s\nmerge: %s\nrunner: %s' \
      $((dur/60)) $((dur%60)) "$fb" "$merge_sha" "$RUNNER")" >/dev/null
  gh -R "$(gh_repo)" issue close "$n" --reason completed >/dev/null
  gh -R "$(gh_repo)" issue edit "$n" --remove-label running >/dev/null 2>&1 || true

  # cleanup
  git -C "$PROJECT_ROOT" worktree remove "$worktree" --force 2>/dev/null || log "could not remove worktree $worktree"
  git -C "$PROJECT_ROOT" branch -d "$branch" 2>/dev/null || true

  # aggregate state (in-memory; persists across iterations via next iter_open).
  AGG_DONE=$((AGG_DONE+1))
  AGG_COMPLETED="$(jq -c --argjson n "$n" '. + [$n]' <<<"$AGG_COMPLETED")"
  AGG_DURATIONS="$(jq -c --argjson d "$dur" '. + [$d]' <<<"$AGG_DURATIONS")"
  state_set "
    .completed = $AGG_COMPLETED
    | .done = $AGG_DONE
    | .durations_seconds = $AGG_DURATIONS
    | .current = null
  "
  history_append "done" "$n" "$RUNNER" "$dur" "$merge_sha" ""
  iter_close_success

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
  local current_n
  current_n="$(state_read | jq -r '.current.number // empty')"
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

# ---------- main ----------
precheck
bootstrap
prune_orphans

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
