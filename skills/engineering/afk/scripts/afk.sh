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
WORKSPACES="$(cd "$PROJECT_ROOT/.." && pwd)/.workspaces"
STATE_FILE="$PROJECT_ROOT/.red/tmp/afk-state.json"
TMP_DIR="$PROJECT_ROOT/.red/tmp"

[[ -z "$RUNNER" ]] && RUNNER="${AFK_RUNNER:-claude}"
ALTERNATE=1
[[ -n "${AFK_RUNNER_PINNED:-}" ]] && ALTERNATE=0
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
  mkdir -p "$TMP_DIR" "$WORKSPACES"
  local gi="$PROJECT_ROOT/.gitignore"
  if ! grep -qxF '.red/tmp/' "$gi" 2>/dev/null; then
    echo '.red/tmp/' >> "$gi"
    log "added .red/tmp/ to .gitignore"
  fi
  state_init
}

# ---------- state file ----------
state_write() {
  local data="$1"
  local tmp="${STATE_FILE}.tmp"
  printf '%s' "$data" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

state_read() { cat "$STATE_FILE" 2>/dev/null || echo '{}'; }

state_init() {
  state_write "$(jq -n \
    --arg started "$(date -Iseconds)" \
    --arg runner "$RUNNER" \
    --arg fk "$FILTER_KIND" \
    --arg fv "$FILTER_VALUE" \
    '{version:1, started_at:$started, runner:$runner,
      filter:{kind:$fk, value:$fv},
      total:0, done:0, failed:0, blocked:0,
      completed:[], queue:[], current:null,
      durations_seconds:[]}')"
}

state_set() {
  # state_set <jq filter>
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

# ---------- drop file ----------
write_drop() {
  local n="$1" title="$2" slug="$3" body="$4" worktree="$5" runner="$6" attempt="$7"
  local drop="$worktree/.red/tmp/drop-${n}-${slug}.md"
  mkdir -p "$worktree/.red/tmp"
  if ! grep -qxF '.red/tmp/' "$worktree/.gitignore" 2>/dev/null; then
    echo '.red/tmp/' >> "$worktree/.gitignore"
  fi

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
  } > "$drop"

  echo "$drop"
}

# ---------- runner invocation ----------
RUNNER_EXHAUSTED=0

run_inner() {
  local worktree="$1" drop="$2" runner="$3"
  RUNNER_EXHAUSTED=0

  local commits
  commits="$(git -C "$PROJECT_ROOT" log -n 5 --format='%H%n%ad%n%B---' --date=short main)"

  local prompt_body
  prompt_body="$(cat "$SKILL_DIR/AGENT-PROMPT.md")"

  local full_prompt
  full_prompt="$(cat <<EOF
Drop file: $drop  (read this first)

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
  local worktree="$WORKSPACES/${REPO_NAME}-${n}"
  local branch="afk/${n}-${slug}"
  local started_at; started_at="$(date -Iseconds)"
  local started_epoch; started_epoch="$(date +%s)"

  hr; log "▶ #$n $title (runner=$RUNNER)"

  # claim
  if ! gh -R "$(gh_repo)" issue edit "$n" \
        --remove-label ready-for-agent --add-label running >/dev/null 2>&1; then
    log "could not claim #$n (already taken?) — skipping"
    return 0
  fi
  gh -R "$(gh_repo)" issue comment "$n" \
    --body "🤖 /afk started at \`$started_at\` on runner \`$RUNNER\`. worktree: \`$worktree\`" >/dev/null

  # worktree
  git -C "$PROJECT_ROOT" fetch origin main --quiet
  git -C "$PROJECT_ROOT" worktree add "$worktree" -b "$branch" origin/main >/dev/null

  state_set "
    .current = {
      number: $n, title: \"$(printf %s "$title" | jq -Rs '.' | sed 's/^\"//;s/\"$//')\",
      slug: \"$slug\", worktree: \"$worktree\",
      drop: \".red/tmp/drop-${n}-${slug}.md\",
      started_at: \"$started_at\", stage: \"setup\",
      heartbeat_glyph: \"\", heartbeat_pid: null,
      runner: \"$RUNNER\", retries: 0, last_stream_line: \"\"
    }
  "

  local attempt=1
  local drop
  drop="$(write_drop "$n" "$title" "$slug" "$body" "$worktree" "$RUNNER" "$attempt")"

  heartbeat_start "$n"
  state_set ".current.stage = \"impl\""

  local result
  result="$(run_inner "$worktree" "$drop" "$RUNNER")"

  if [[ $RUNNER_EXHAUSTED -eq 1 ]]; then
    heartbeat_stop
    if [[ $ALTERNATE -eq 1 ]]; then
      local other="claude"; [[ "$RUNNER" == "claude" ]] && other="codex"
      log "runner $RUNNER exhausted — swapping to $other and retrying #$n"
      RUNNER="$other"
      attempt=$((attempt+1))
      drop="$(write_drop "$n" "$title" "$slug" "$body" "$worktree" "$RUNNER" "$attempt")"
      heartbeat_start "$n"
      result="$(run_inner "$worktree" "$drop" "$RUNNER")"
      if [[ $RUNNER_EXHAUSTED -eq 1 ]]; then
        heartbeat_stop
        gh -R "$(gh_repo)" issue comment "$n" --body "Both runners exhausted. Worktree preserved at \`$worktree\`." >/dev/null
        gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null
        exit 75
      fi
    else
      gh -R "$(gh_repo)" issue comment "$n" --body "Runner \`$RUNNER\` exhausted; rerun /afk when quota resets." >/dev/null
      gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-agent >/dev/null
      exit 75
    fi
  fi

  heartbeat_stop

  # sentinel detection
  if echo "$result" | grep -q '<promise>BLOCKED</promise>'; then
    log "✗ #$n blocked by inner agent"
    local notes
    notes="$(awk '/^## Notes$/,0' "$drop")"
    gh -R "$(gh_repo)" issue comment "$n" --body "$(printf 'BLOCKED by inner agent.\n\n%s\n\nWorktree preserved at `%s`.' "$notes" "$worktree")" >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    state_set ".blocked += 1 | .current = null"
    return 0
  fi

  if ! echo "$result" | grep -q '<promise>DONE</promise>'; then
    log "✗ #$n inner agent ended without DONE sentinel — treating as blocker"
    gh -R "$(gh_repo)" issue comment "$n" --body "Inner agent exited without a sentinel. Manual review needed. Worktree at \`$worktree\`." >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    state_set ".blocked += 1 | .current = null"
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
    gh -R "$(gh_repo)" issue comment "$n" --body "$(printf 'Merge conflict on \`main\`. Aborted. Worktree preserved at `%s`.\n\n```\n%s\n```' "$worktree" "$diff")" >/dev/null
    gh -R "$(gh_repo)" issue edit "$n" --remove-label running --add-label ready-for-human >/dev/null
    state_set ".blocked += 1 | .current = null"
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

  # state
  state_set "
    .completed += [$n]
    | .done += 1
    | .durations_seconds += [$dur]
    | .current = null
  "

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
      --body "🤖 /afk interrupted. claim released; worktree preserved." >/dev/null 2>&1 || true
  fi
  log "interrupted — state preserved at $STATE_FILE"
  exit 130
}
trap cleanup INT TERM

# ---------- main ----------
precheck
bootstrap

# --- straggler check: warn about issues that never made it to ready-for-agent
straggler_check() {
  local repo; repo="$(gh_repo)"
  local unlabeled needs_triage needs_info
  unlabeled="$(gh -R "$repo" issue list --state open --search 'no:label' --json number --jq 'length' 2>/dev/null || echo 0)"
  needs_triage="$(gh -R "$repo" issue list --state open --label needs-triage --json number --jq 'length' 2>/dev/null || echo 0)"
  needs_info="$(gh -R "$repo" issue list --state open --label needs-info --json number --jq 'length' 2>/dev/null || echo 0)"

  if [[ "$unlabeled" -gt 0 || "$needs_triage" -gt 0 || "$needs_info" -gt 0 ]]; then
    log "⚠ stragglers detected: $unlabeled unlabeled, $needs_triage needs-triage, $needs_info needs-info"
    log "  these are invisible to /afk. consider running /triage before draining."
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

state_set ".total = $TOTAL | .queue = $(echo "$ISSUES_JSON" | jq '[.[].number]')"

log "/afk: $TOTAL issue(s) queued (filter=$FILTER_KIND${FILTER_VALUE:+:$FILTER_VALUE}, runner=$RUNNER, cap=$ITER_CAP)"

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
log "/afk done. state: $STATE_FILE"
echo "<promise>NO MORE TASKS</promise>"
