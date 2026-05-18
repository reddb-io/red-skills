#!/usr/bin/env bash
# /afk statusline aggregator.
# Renders one compact line summarising live worker state for the cwd:
#   🤖 N · 📋 ready N · 🙋 human N · 🚧 blocked N · +A -B · #X #Y
# Outputs nothing when the cwd has no .red/tmp/ or no live workers.
# Designed to stay under 100 ms by caching GitHub-derived counts for 60 s.

set -u

# Per-project opt-out via .red/config.yaml (best-effort, no yq dep)
if [[ -f .red/config.yaml ]] && grep -qE '^[[:space:]]*statusline:[[:space:]]*false[[:space:]]*$' .red/config.yaml 2>/dev/null; then
  exit 0
fi

[[ -d .red/tmp ]] || exit 0

shopt -s nullglob

total_workers=0
total_blocked=0
total_added=0
total_removed=0
current_issues=()

for state in .red/tmp/work-*/afk.state.json; do
  pid=$(jq -r '.pid // empty' "$state" 2>/dev/null) || continue
  [[ -z "$pid" ]] && continue
  kill -0 "$pid" 2>/dev/null || continue

  total_workers=$((total_workers + 1))

  blk=$(jq -r '.blocked // 0' "$state" 2>/dev/null)
  total_blocked=$((total_blocked + blk))

  added=$(jq -r '.current.diff_added // 0' "$state" 2>/dev/null)
  removed=$(jq -r '.current.diff_removed // 0' "$state" 2>/dev/null)

  # Fallback: compute diffstat from worktree if state file fields absent
  if [[ "$added" == "0" && "$removed" == "0" ]]; then
    worktree=$(jq -r '.current.worktree // empty' "$state" 2>/dev/null)
    if [[ -n "$worktree" && -d "$worktree" ]]; then
      stat=$(git -C "$worktree" diff --shortstat origin/main 2>/dev/null || true)
      a=$(echo "$stat" | grep -oE '[0-9]+ insertion' | grep -oE '[0-9]+')
      r=$(echo "$stat" | grep -oE '[0-9]+ deletion' | grep -oE '[0-9]+')
      added="${a:-0}"
      removed="${r:-0}"
    fi
  fi
  total_added=$((total_added + added))
  total_removed=$((total_removed + removed))

  issue=$(jq -r '.current.number // empty' "$state" 2>/dev/null)
  [[ -n "$issue" ]] && current_issues+=("#$issue")
done

[[ "$total_workers" -eq 0 ]] && exit 0

# GitHub-derived counts cached for 60 s in .red/tmp/statusline-cache.json
CACHE_FILE=".red/tmp/statusline-cache.json"
TTL=60

read_cache() {
  if [[ -f "$CACHE_FILE" ]]; then
    queue=$(jq -r '.queue // 0' "$CACHE_FILE" 2>/dev/null)
    human=$(jq -r '.human // 0' "$CACHE_FILE" 2>/dev/null)
    ts=$(jq -r '.ts // 0' "$CACHE_FILE" 2>/dev/null)
    age=$(( $(date +%s) - ts ))
  else
    queue=0
    human=0
    age=99999
  fi
}

refresh_cache_sync() {
  q=$(gh issue list --label ready-for-agent --state open --json number --jq length 2>/dev/null || echo 0)
  h=$(gh issue list --label ready-for-human --state open --json number --jq length 2>/dev/null || echo 0)
  jq -n --argjson q "$q" --argjson h "$h" --argjson t "$(date +%s)" \
    '{queue:$q, human:$h, ts:$t}' > "$CACHE_FILE.tmp" 2>/dev/null \
    && mv "$CACHE_FILE.tmp" "$CACHE_FILE"
  queue="$q"
  human="$h"
}

read_cache
if [[ ! -f "$CACHE_FILE" ]]; then
  # First render: pay the cost so subsequent ones are cached
  refresh_cache_sync
elif [[ "$age" -ge "$TTL" ]]; then
  # Stale: render with stale values, refresh in background for next render
  ( refresh_cache_sync >/dev/null 2>&1 ) &
fi

issues_str="${current_issues[*]}"

printf '🤖 %d · 📋 ready %d · 🙋 human %d · 🚧 blocked %d · +%d -%d · %s\n' \
  "$total_workers" "$queue" "$human" "$total_blocked" "$total_added" "$total_removed" "$issues_str"
