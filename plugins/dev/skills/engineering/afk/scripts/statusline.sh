#!/usr/bin/env bash
# /afk statusline aggregator for Claude Code.
#
# Reads the Claude Code statusline JSON payload from stdin (cwd, model,
# effort, context window) and combines it with live /afk worker state
# from $cwd/.red/tmp/work-*/.
#
# Output example (no truncation, one line):
#   red-skills · Opus·high · 47k 24% · 🤖4 📋1 🙋11 🚧10 +12 -3 #17
#
# Each block is optional and drops out silently when its data is absent
# (e.g. invoked outside Claude Code → no model/context block;
#  cwd without `.red/tmp/` → no AFK block).
#
# Stays under 100 ms via a 60 s cache on GitHub-derived counts.

set -u

# ---- Read Claude Code stdin payload --------------------------------------
input='{}'
if [[ ! -t 0 ]]; then
  input=$(cat 2>/dev/null || true)
  [[ -z "$input" ]] && input='{}'
fi

# Resolve cwd: prefer payload, fall back to $PWD
cwd=$(jq -r '.workspace.current_dir // .cwd // empty' <<<"$input" 2>/dev/null)
[[ -z "$cwd" ]] && cwd="$PWD"
cd "$cwd" 2>/dev/null || true

# ---- Per-project opt-out -------------------------------------------------
# Honours either a top-level `statusline: false` or a nested `afk.statusline: false`.
if [[ -f .red/config.yaml ]]; then
  if grep -qE '^[[:space:]]*statusline:[[:space:]]*false[[:space:]]*$' .red/config.yaml 2>/dev/null; then
    exit 0
  fi
  if awk '
    /^afk:[[:space:]]*$/ { in_afk = 1; next }
    /^[^[:space:]]/      { in_afk = 0 }
    in_afk && /^[[:space:]]+statusline:[[:space:]]*false[[:space:]]*$/ { found = 1; exit }
    END { exit !found }
  ' .red/config.yaml 2>/dev/null; then
    exit 0
  fi
fi

sections=()

# ---- Block 1: project basename -------------------------------------------
sections+=("$(basename "$cwd")")

# ---- Block 2: model[·effort] ---------------------------------------------
model=$(jq -r '.model.display_name // empty' <<<"$input" 2>/dev/null)
effort=$(jq -r '.effort.level // empty' <<<"$input" 2>/dev/null)
if [[ -n "$model" ]]; then
  if [[ -n "$effort" ]]; then
    sections+=("${model}·${effort}")
  else
    sections+=("$model")
  fi
fi

# ---- Block 3: context tokens + percent -----------------------------------
ctx_tokens=$(jq -r '.context_window.total_input_tokens // empty' <<<"$input" 2>/dev/null)
ctx_pct=$(jq -r '.context_window.used_percentage // empty' <<<"$input" 2>/dev/null)
if [[ -n "$ctx_tokens" && "$ctx_tokens" != "0" ]]; then
  if (( ctx_tokens >= 1000000 )); then
    ctx_h=$(awk "BEGIN { printf \"%.1fM\", $ctx_tokens/1000000 }")
  elif (( ctx_tokens >= 1000 )); then
    ctx_h="$((ctx_tokens / 1000))k"
  else
    ctx_h="$ctx_tokens"
  fi
  if [[ -n "$ctx_pct" ]]; then
    ctx_pct_int=$(printf '%.0f' "$ctx_pct" 2>/dev/null)
    sections+=("${ctx_h} ${ctx_pct_int}%")
  else
    sections+=("$ctx_h")
  fi
fi

# ---- Block 4: AFK workers ------------------------------------------------
if [[ -d .red/tmp ]]; then
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

  if (( total_workers > 0 )); then
    # GitHub-derived counts cached for 60 s in .red/tmp/statusline-cache.json
    CACHE_FILE=".red/tmp/statusline-cache.json"
    TTL=60
    queue=0
    human=0
    age=99999
    if [[ -f "$CACHE_FILE" ]]; then
      queue=$(jq -r '.queue // 0' "$CACHE_FILE" 2>/dev/null)
      human=$(jq -r '.human // 0' "$CACHE_FILE" 2>/dev/null)
      ts=$(jq -r '.ts // 0' "$CACHE_FILE" 2>/dev/null)
      age=$(( $(date +%s) - ts ))
    fi

    refresh_cache() {
      q=$(gh issue list --label ready-for-agent --state open --json number --jq length 2>/dev/null || echo 0)
      h=$(gh issue list --label ready-for-human --state open --json number --jq length 2>/dev/null || echo 0)
      jq -n --argjson q "$q" --argjson h "$h" --argjson t "$(date +%s)" \
        '{queue:$q, human:$h, ts:$t}' > "$CACHE_FILE.tmp" 2>/dev/null \
        && mv "$CACHE_FILE.tmp" "$CACHE_FILE"
      queue="$q"
      human="$h"
    }

    if [[ ! -f "$CACHE_FILE" ]]; then
      refresh_cache
    elif (( age >= TTL )); then
      ( refresh_cache >/dev/null 2>&1 ) &
    fi

    afk_part="🤖${total_workers} 📋${queue} 🙋${human} 🚧${total_blocked} +${total_added} -${total_removed}"
    if (( ${#current_issues[@]} > 0 )); then
      afk_part="${afk_part} ${current_issues[*]}"
    fi
    sections+=("$afk_part")
  fi
fi

# ---- Emit ----------------------------------------------------------------
out=""
for s in "${sections[@]}"; do
  if [[ -z "$out" ]]; then
    out="$s"
  else
    out="${out} · ${s}"
  fi
done
printf '%s\n' "$out"
