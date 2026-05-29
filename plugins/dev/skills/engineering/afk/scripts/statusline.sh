#!/usr/bin/env bash
# /afk statusline aggregator for Claude Code.
#
# Reads the Claude Code statusline JSON payload from stdin (cwd, model,
# effort, context window) and combines it with live /afk worker state
# from $cwd/.red/tmp/workers/*/*/.
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

# shellcheck disable=SC1091
source "$(dirname "${BASH_SOURCE[0]}")/lib/state.sh"

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

# ---- ANSI colour helpers (no-op when statusline is captured plain) -------
BOLD=$'\e[1m'
DIM=$'\e[2m'
RED=$'\e[31m'
GREEN=$'\e[32m'
YELLOW=$'\e[33m'
CYAN=$'\e[36m'
RESET=$'\e[0m'

sections=()

# ---- Block 1: project basename [+ git branch] ---------------------------
proj_block="${BOLD}$(basename "$cwd")${RESET}"
if branch=$(git symbolic-ref --short HEAD 2>/dev/null); then
  # Truncate long branches to keep statusline tight (e.g. afk/wFABQ/9-… )
  if (( ${#branch} > 28 )); then
    branch="${branch:0:27}…"
  fi
  # main/master in dim grey; feature branches in cyan to stand out
  if [[ "$branch" == "main" || "$branch" == "master" ]]; then
    proj_block="${proj_block} ${DIM}(${branch})${RESET}"
  else
    proj_block="${proj_block} ${CYAN}(${branch})${RESET}"
  fi
elif sha=$(git rev-parse --short HEAD 2>/dev/null); then
  proj_block="${proj_block} ${DIM}(detached ${sha})${RESET}"
fi
sections+=("$proj_block")

# ---- Block 2: model[·effort] ---------------------------------------------
model=$(jq -r '.model.display_name // empty' <<<"$input" 2>/dev/null)
effort=$(jq -r '.effort.level // empty' <<<"$input" 2>/dev/null)
if [[ -n "$model" ]]; then
  if [[ -n "$effort" ]]; then
    sections+=("${DIM}${model}·${effort}${RESET}")
  else
    sections+=("${DIM}${model}${RESET}")
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
    # Colour by usage: green < 50, yellow 50-80, red > 80
    if (( ctx_pct_int >= 80 )); then
      ctx_colour="$RED"
    elif (( ctx_pct_int >= 50 )); then
      ctx_colour="$YELLOW"
    else
      ctx_colour="$GREEN"
    fi
    sections+=("${DIM}${ctx_h}${RESET} ${ctx_colour}${ctx_pct_int}%${RESET}")
  else
    sections+=("${DIM}${ctx_h}${RESET}")
  fi
fi

# ---- Block 4: AFK workers ------------------------------------------------
if [[ -d .red/tmp ]]; then
  shopt -s nullglob

  # Derive GitHub repo URL once for hyperlinking issue numbers (OSC 8).
  repo_url=""
  if remote=$(git remote get-url origin 2>/dev/null); then
    if [[ "$remote" =~ ^git@github\.com:(.+)\.git$ ]]; then
      repo_url="https://github.com/${BASH_REMATCH[1]}"
    elif [[ "$remote" =~ ^git@github\.com:(.+)$ ]]; then
      repo_url="https://github.com/${BASH_REMATCH[1]}"
    elif [[ "$remote" =~ ^https://github\.com/(.+)\.git$ ]]; then
      repo_url="https://github.com/${BASH_REMATCH[1]}"
    elif [[ "$remote" =~ ^https://github\.com/(.+)$ ]]; then
      repo_url="https://github.com/${BASH_REMATCH[1]}"
    fi
  fi

  total_workers=0
  total_blocked=0
  total_added=0
  total_removed=0
  current_issues=()

  for state in .red/tmp/workers/*/*/afk.state.json; do
    state_is_live "$state" || continue
    state_read_into st "$state"

    total_workers=$((total_workers + 1))
    total_blocked=$((total_blocked + st_blocked))

    added="$st_current_diff_added"
    removed="$st_current_diff_removed"

    # Fallback: compute diffstat from worktree if state file fields absent
    if [[ "$added" == "0" && "$removed" == "0" ]]; then
      worktree="$st_current_worktree"
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

    [[ -n "$st_current_number" ]] && current_issues+=("#$st_current_number")
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

    # Build only the non-zero fields. Each emoji+number is one token.
    afk_tokens=()
    (( total_workers > 0 )) && afk_tokens+=("${GREEN}🤖${total_workers}${RESET}")
    (( queue > 0 ))         && afk_tokens+=("📋${queue}")
    (( human > 0 ))         && afk_tokens+=("${YELLOW}🙋${human}${RESET}")
    (( total_blocked > 0 )) && afk_tokens+=("${RED}🚧${total_blocked}${RESET}")
    (( total_added > 0 ))   && afk_tokens+=("${GREEN}+${total_added}${RESET}")
    (( total_removed > 0 )) && afk_tokens+=("${RED}-${total_removed}${RESET}")
    # OSC 8 hyperlink: \e]8;;URL\e\\TEXT\e]8;;\e\\
    # Falls back to plain coloured text when repo_url couldn't be derived.
    for n in "${current_issues[@]}"; do
      if [[ -n "$repo_url" ]]; then
        num="${n#\#}"
        afk_tokens+=("$(printf '\e]8;;%s/issues/%s\e\\%s%s%s\e]8;;\e\\' "$repo_url" "$num" "$CYAN" "$n" "$RESET")")
      else
        afk_tokens+=("${CYAN}${n}${RESET}")
      fi
    done

    if (( ${#afk_tokens[@]} > 0 )); then
      sections+=("${afk_tokens[*]}")
    fi
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
