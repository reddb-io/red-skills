#!/usr/bin/env bash
# Unit tests for plugins/dev/skills/engineering/afk/scripts/statusline.sh
#
# Locks the live render contract:
#
#   - No live workers (empty .red/tmp) => the AFK block is absent (no 🤖),
#     but the project-name block is still emitted.
#   - One live worker on #17 with +12 -3 from state file => render contains
#     "🤖1", "+12 -3", "#17", plus the cached counts 📋 / 🆘 / 🚧.
#   - Two live workers => 🤖2, summed diffstat, both issue numbers, summed 🚧.
#   - Dead worker (pid not alive) is filtered out via kill -0.
#   - An explicit first-arg root overrides $PWD (the $CLAUDE_PROJECT_DIR wiring).
#   - .red/config.yaml with `statusline: false` (top-level or nested under
#     afk:) => exit 0, empty stdout.
#
# No GitHub calls: pre-seed the statusline-cache.json so the script never
# shells out to `gh` during the test.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$HERE/../statusline.sh"
[[ -x "$SCRIPT" || -f "$SCRIPT" ]] || { echo "missing script: $SCRIPT"; exit 1; }

TMP_ROOT="$(mktemp -d -t statusline.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT

assertions=0
fail() { echo "FAIL: $*" >&2; exit 1; }
assert_eq() { assertions=$((assertions+1)); [[ "$1" == "$2" ]] || fail "$3: expected [$2], got [$1]"; }
assert_contains() { assertions=$((assertions+1)); [[ "$1" == *"$2"* ]] || fail "$3: [$1] does not contain [$2]"; }
assert_not_contains() { assertions=$((assertions+1)); [[ "$1" != *"$2"* ]] || fail "$3: [$1] should not contain [$2]"; }

# Strip ANSI + OSC 8 hyperlink escapes so assertions match on plain text.
plain() { sed -E $'s/\e\\[[0-9;]*m//g; s/\e\\]8;;[^\e]*\e\\\\//g'; }

# Pre-seed the cache so the script never calls `gh`.
seed_cache() {
  local root="$1"
  mkdir -p "$root/.red/tmp"
  jq -n --argjson q 11 --argjson h 3 --argjson t "$(date +%s)" \
    '{queue:$q, human:$h, ts:$t}' > "$root/.red/tmp/statusline-cache.json"
}

# Build a worker state dir. Args: root, slug, pid, issue, added, removed, blocked.
make_worker() {
  local root="$1" slug="$2" pid="$3" issue="$4" added="$5" removed="$6" blocked="$7"
  local dir="$root/.red/tmp/workers/$slug/${issue}-a1"
  mkdir -p "$dir"
  jq -n \
    --argjson pid "$pid" \
    --argjson blocked "$blocked" \
    --argjson number "$issue" \
    --argjson added "$added" \
    --argjson removed "$removed" \
    '{pid:$pid, blocked:$blocked, current:{number:$number, diff_added:$added, diff_removed:$removed}}' \
    > "$dir/afk.state.json"
}

# Run from inside the root (root resolved via $PWD / stdin fallback).
run_script() {
  ( cd "$1" && bash "$SCRIPT" ) | plain
}

# Run from an unrelated cwd, passing the root explicitly as the first arg.
run_script_arg() {
  local root="$1"
  ( cd "$TMP_ROOT" && bash "$SCRIPT" "$root" ) | plain
}

# ------------------------------------------------------------------
# Case 1: no .red/tmp => no AFK block (no 🤖), project name still present.
case1="$TMP_ROOT/c1"
mkdir -p "$case1"
out="$(run_script "$case1" || true)"
assert_not_contains "$out" "🤖" "case1: no AFK block when .red/tmp missing"
assert_contains "$out" "c1" "case1: project-name block still emitted"

# ------------------------------------------------------------------
# Case 2: .red/tmp exists but no workers => no AFK block.
case2="$TMP_ROOT/c2"
mkdir -p "$case2/.red/tmp"
out="$(run_script "$case2")"
assert_not_contains "$out" "🤖" "case2: no AFK block when no worker state files"

# ------------------------------------------------------------------
# Case 3: one live worker on #17 with +12 -3 and blocked=2.
case3="$TMP_ROOT/c3"
mkdir -p "$case3"
seed_cache "$case3"
make_worker "$case3" "alive1" "$$" 17 12 3 2
out="$(run_script "$case3")"
assert_contains "$out" "🤖1" "case3: 🤖1 worker"
assert_contains "$out" "+12 -3" "case3: diffstat +12 -3"
assert_contains "$out" "#17" "case3: issue number"
assert_contains "$out" "🚧2" "case3: blocked count"
assert_contains "$out" "📋11" "case3: cached ready-for-agent count"
assert_contains "$out" "🆘3" "case3: cached ready-for-human count"

# ------------------------------------------------------------------
# Case 4: two live workers — diffstats and blocked counts sum, both issue
# numbers appear.
case4="$TMP_ROOT/c4"
mkdir -p "$case4"
seed_cache "$case4"
make_worker "$case4" "alive1" "$$" 17 12 3 1
make_worker "$case4" "alive2" "$$" 20 30 7 4
out="$(run_script "$case4")"
assert_contains "$out" "🤖2" "case4: 🤖2 workers"
assert_contains "$out" "+42 -10" "case4: summed diffstat"
assert_contains "$out" "#17" "case4: first issue"
assert_contains "$out" "#20" "case4: second issue"
assert_contains "$out" "🚧5" "case4: summed blocked"

# ------------------------------------------------------------------
# Case 5: dead worker (pid that no process owns) is excluded.
case5="$TMP_ROOT/c5"
mkdir -p "$case5"
seed_cache "$case5"
# Pick a pid that is almost certainly not running.
dead_pid=99999
while kill -0 "$dead_pid" 2>/dev/null; do dead_pid=$((dead_pid + 1)); done
make_worker "$case5" "alive1" "$$" 17 5 2 0
make_worker "$case5" "ghost1" "$dead_pid" 999 100 50 9
out="$(run_script "$case5")"
assert_contains "$out" "🤖1" "case5: 🤖 counts only the live worker"
assert_contains "$out" "+5 -2" "case5: diffstat excludes dead worker"
assert_contains "$out" "#17" "case5: live issue present"
assert_not_contains "$out" "#999" "case5: dead worker issue absent"
assert_not_contains "$out" "🚧9" "case5: dead worker blocked not counted"

# ------------------------------------------------------------------
# Case 6: nested afk.statusline: false opt-out.
case6="$TMP_ROOT/c6"
mkdir -p "$case6/.red"
seed_cache "$case6"
make_worker "$case6" "alive1" "$$" 17 12 3 1
cat > "$case6/.red/config.yaml" <<'YAML'
afk:
  statusline: false
YAML
out="$(run_script "$case6")"
assert_eq "$out" "" "case6: opt-out via nested afk.statusline: false"

# ------------------------------------------------------------------
# Case 7: top-level statusline: false opt-out (legacy form).
case7="$TMP_ROOT/c7"
mkdir -p "$case7/.red"
seed_cache "$case7"
make_worker "$case7" "alive1" "$$" 17 12 3 1
cat > "$case7/.red/config.yaml" <<'YAML'
statusline: false
YAML
out="$(run_script "$case7")"
assert_eq "$out" "" "case7: opt-out via top-level statusline: false"

# ------------------------------------------------------------------
# Case 8: explicit first-arg root overrides the cwd. Running from $TMP_ROOT
# (which has no workers) but passing case8's root must render case8's worker.
case8="$TMP_ROOT/c8"
mkdir -p "$case8"
seed_cache "$case8"
make_worker "$case8" "alive1" "$$" 42 7 1 0
out="$(run_script_arg "$case8")"
assert_contains "$out" "🤖1" "case8: first-arg root is read for workers"
assert_contains "$out" "#42" "case8: first-arg root's issue number"
assert_contains "$out" "c8" "case8: project-name block from first-arg root"

# A blank first arg must fall through to the cwd resolution, not break.
out="$(( cd "$case3" && bash "$SCRIPT" "" ) | plain)"
assert_contains "$out" "#17" "case8: empty first arg falls back to cwd"

echo "statusline.test.sh: $assertions assertions passed"
