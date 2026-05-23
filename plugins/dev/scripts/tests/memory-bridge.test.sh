#!/usr/bin/env bash
# Tests for plugins/dev/scripts/memory-bridge.sh (issue #57, PRD #49).
#
# The bridge is dev's SOFT, one-directional hook into the memory plugin. The
# acceptance criteria it must satisfy:
#   - memory installed + initialized  → recall runs and its output is returned;
#   - graph memory with neighbors/path → focused graph reads are returned;
#   - memory absent / uninitialized   → behaves exactly as before: silent no-op,
#                                        exit 0, no output, no error;
#   - detection has two gates (config opt-in AND a resolvable CLI), and the CLI
#     resolution cascade prefers $RED_MEMORY_CLI, then a `memory` bin on PATH,
#     then a built sibling/in-repo dist.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/memory-bridge.sh"

# shellcheck source=../memory-bridge.sh
source "$LIB"

pass=0
fail=0

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      expected: %q\n      actual:   %q\n' "$label" "$expected" "$actual"
    fail=$((fail + 1))
  fi
}

expect_ok() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (command failed: $*)"
    fail=$((fail + 1))
  fi
}

expect_fail() {
  local label="$1"; shift
  if "$@"; then
    echo "FAIL  $label (expected non-zero, got success)"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

# ---------- fixtures ----------

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# A repo that has opted into memory (config present).
INIT_ROOT="$TMP/init-repo"
mkdir -p "$INIT_ROOT/.red/memory"
echo '{"version":1,"mode":"markdown-only"}' > "$INIT_ROOT/.red/memory/config.json"

GRAPH_ROOT="$TMP/graph-repo"
mkdir -p "$GRAPH_ROOT/.red/memory"
echo '{"version":1,"mode":"graph","storePath":".red/memory/graph.rdb"}' > "$GRAPH_ROOT/.red/memory/config.json"

# A repo that never ran memory init (no config).
BARE_ROOT="$TMP/bare-repo"
mkdir -p "$BARE_ROOT"

# A fake `memory` CLI on PATH that echoes a recognisable block and the query it got.
FAKE_BIN="$TMP/bin"
mkdir -p "$FAKE_BIN"
cat > "$FAKE_BIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  recall)
    shift   # drop the "recall" verb
    echo "memory: 1 match for \"$*\""
    echo "  [1.0] note-1"
    ;;
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  neighbors)
    label="$2"
    echo "memory: 2 neighbor(s) of \"$label\""
    echo "  d1 node-auth (module) auth-service"
    echo "  d1 node-cache (concept) cache-ttl"
    ;;
  path)
    from="$2"
    to="$3"
    echo "memory: path \"$from\" -> \"$to\": 2 hop(s), weight 2"
    ;;
  structural-impact)
    file=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--file" ]; then file="$2"; fi
      shift || true
    done
    echo "memory: structural impact for file $file"
    echo "  /repo/src/app.ts imports node:path"
    echo "  /repo/src/consumer.ts imports this target through ./app.js"
    ;;
  attempt)
    if [[ "$2" != "record" ]]; then
      echo "unexpected attempt command: $*" >&2
      exit 1
    fi
    cat > "${FAKE_ATTEMPT_OUT:?}"
    echo "memory: recorded attempt"
    ;;
  *)
    echo "unexpected command: $*" >&2
    exit 1
    ;;
esac
EOF
chmod +x "$FAKE_BIN/memory"

# A clean environment helper: clear every override the bridge consults.
clear_env() { unset RED_MEMORY_CLI CLAUDE_PLUGIN_ROOT MEMORY_REPO_ROOT; }

# ---------- _memory_resolve_cli cascade ----------

# RED_MEMORY_CLI override (does not need node to *resolve*).
clear_env
override="$TMP/custom-cli.js"
echo '// fake' > "$override"
RED_MEMORY_CLI="$override" _memory_resolve_cli
expect_eq "resolve: \$RED_MEMORY_CLI -> node <path>" "node $override" "${MEMORY_CLI[*]}"

# RED_MEMORY_CLI set but file missing → no resolution.
clear_env
expect_fail "resolve: \$RED_MEMORY_CLI missing file fails" \
  bash -c 'source "'"$LIB"'"; RED_MEMORY_CLI=/nope/cli.js _memory_resolve_cli'

# `memory` on PATH.
clear_env
PATH="$FAKE_BIN:$PATH" _memory_resolve_cli
expect_eq "resolve: memory on PATH -> (memory)" "memory" "${MEMORY_CLI[*]}"

# in-repo dist via MEMORY_REPO_ROOT.
clear_env
REPO="$TMP/monorepo"
mkdir -p "$REPO/plugins/memory/dist"
echo '// fake' > "$REPO/plugins/memory/dist/cli.js"
MEMORY_REPO_ROOT="$REPO" _memory_resolve_cli
expect_eq "resolve: MEMORY_REPO_ROOT in-repo dist -> node <path>" \
  "node $REPO/plugins/memory/dist/cli.js" "${MEMORY_CLI[*]}"

# sibling dist via CLAUDE_PLUGIN_ROOT (dev plugin root; memory is its sibling).
clear_env
DEVROOT="$TMP/plugins/dev"
mkdir -p "$DEVROOT" "$TMP/plugins/memory/dist"
echo '// fake' > "$TMP/plugins/memory/dist/cli.js"
CLAUDE_PLUGIN_ROOT="$DEVROOT" _memory_resolve_cli
expect_eq "resolve: CLAUDE_PLUGIN_ROOT sibling dist -> node <path>" \
  "node $DEVROOT/../memory/dist/cli.js" "${MEMORY_CLI[*]}"

# nothing resolvable (empty env, no PATH bin) → fails, MEMORY_CLI empty.
clear_env
expect_fail "resolve: nothing available fails" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin _memory_resolve_cli'

# ---------- memory_available (two gates) ----------

clear_env
expect_fail "available: no config -> unavailable (even with CLI on PATH)" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_available "'"$BARE_ROOT"'"'

clear_env
expect_fail "available: config present but no CLI -> unavailable" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin memory_available "'"$INIT_ROOT"'"'

clear_env
expect_ok "available: config present AND CLI on PATH -> available" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_available "'"$INIT_ROOT"'"'

# ---------- Memory mode + graph readiness ----------

clear_env
expect_eq "mode: absent config -> unavailable" "unavailable" \
  "$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_mode "'"$BARE_ROOT"'"')"

clear_env
expect_eq "mode: markdown-only config -> markdown-only" "markdown-only" \
  "$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_mode "'"$INIT_ROOT"'"')"

clear_env
expect_eq "mode: graph config -> graph" "graph" \
  "$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_mode "'"$GRAPH_ROOT"'"')"

clear_env
expect_ok "graph-ready: graph config + stats with nodes -> ready" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_graph_ready "'"$GRAPH_ROOT"'"'

clear_env
expect_fail "graph-ready: absent config -> not ready" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_graph_ready "'"$BARE_ROOT"'"'

clear_env
expect_fail "graph-ready: markdown-only config -> not ready" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_graph_ready "'"$INIT_ROOT"'"'

clear_env
EMPTYBIN="$TMP/emptybin"
mkdir -p "$EMPTYBIN"
cat > "$EMPTYBIN/memory" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "stats" ]]; then
  echo "memory: 0 node(s), 0 edge(s)"
else
  exit 1
fi
EOF
chmod +x "$EMPTYBIN/memory"
expect_fail "graph-ready: graph stats with zero nodes -> not ready" \
  bash -c 'source "'"$LIB"'"; PATH="'"$EMPTYBIN"':/usr/bin:/bin" memory_graph_ready "'"$GRAPH_ROOT"'"'

clear_env
STATERRBIN="$TMP/staterrbin"
mkdir -p "$STATERRBIN"
cat > "$STATERRBIN/memory" <<'EOF'
#!/usr/bin/env bash
if [[ "$1" == "stats" ]]; then
  echo "stats boom" >&2
  exit 1
fi
exit 1
EOF
chmod +x "$STATERRBIN/memory"
out="$(PATH="$STATERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_graph_ready "'"$GRAPH_ROOT"'"' 2>/dev/null)"
expect_eq "graph-ready: failing stats command -> no stdout" "" "$out"
expect_fail "graph-ready: failing stats command -> not ready" \
  bash -c 'source "'"$LIB"'"; PATH="'"$STATERRBIN"':/usr/bin:/bin" memory_graph_ready "'"$GRAPH_ROOT"'"'

# ---------- memory_neighbors (graph-only, graceful) ----------

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both')"
expect_eq "neighbors: graph ready -> returns CLI output" \
  $'memory: 2 neighbor(s) of "zoom-out"\n  d1 node-auth (module) auth-service\n  d1 node-cache (concept) cache-ttl' "$out"
clear_env
expect_ok "neighbors: graph ready -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both'

clear_env
out="$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both')"
expect_eq "neighbors: graph config but no CLI -> no output" "" "$out"
clear_env
expect_ok "neighbors: graph config but no CLI -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both'

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_neighbors "'"$INIT_ROOT"'" zoom-out 1 both')"
expect_eq "neighbors: markdown-only config -> no output" "" "$out"

clear_env
ZERONEIGHBORBIN="$TMP/zeroneighborbin"
mkdir -p "$ZERONEIGHBORBIN"
cat > "$ZERONEIGHBORBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  neighbors)
    echo "memory: 0 neighbor(s) of \"$2\""
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$ZERONEIGHBORBIN/memory"
out="$(PATH="$ZERONEIGHBORBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both')"
expect_eq "neighbors: zero neighbors -> no output" "" "$out"

clear_env
NEIGHBORERRBIN="$TMP/neighborerrbin"
mkdir -p "$NEIGHBORERRBIN"
cat > "$NEIGHBORERRBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  neighbors)
    echo "neighbors boom" >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$NEIGHBORERRBIN/memory"
out="$(PATH="$NEIGHBORERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both' 2>/dev/null)"
expect_eq "neighbors: failing command -> swallowed, no stdout" "" "$out"
clear_env
expect_ok "neighbors: failing command -> still exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$NEIGHBORERRBIN"':/usr/bin:/bin" memory_neighbors "'"$GRAPH_ROOT"'" zoom-out 1 both'

# ---------- memory_structural_impact (graph-only, graceful) ----------

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_structural_impact "'"$GRAPH_ROOT"'" /repo/src/app.ts render')"
expect_eq "structural-impact: graph ready -> returns CLI output" \
  $'memory: structural impact for file /repo/src/app.ts\n  /repo/src/app.ts imports node:path\n  /repo/src/consumer.ts imports this target through ./app.js' "$out"

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_structural_impact "'"$INIT_ROOT"'" /repo/src/app.ts render')"
expect_eq "structural-impact: markdown-only config -> no output" "" "$out"

clear_env
NOIMPACTBIN="$TMP/noimpactbin"
mkdir -p "$NOIMPACTBIN"
cat > "$NOIMPACTBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  structural-impact)
    file=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--file" ]; then file="$2"; fi
      shift || true
    done
    echo "memory: no structural impact for file $file"
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$NOIMPACTBIN/memory"
out="$(PATH="$NOIMPACTBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_structural_impact "'"$GRAPH_ROOT"'" /repo/src/missing.ts missing')"
expect_eq "structural-impact: no graph data -> no output" "" "$out"

clear_env
IMPACTERRBIN="$TMP/impacterrbin"
mkdir -p "$IMPACTERRBIN"
cat > "$IMPACTERRBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  structural-impact)
    echo "impact boom" >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$IMPACTERRBIN/memory"
out="$(PATH="$IMPACTERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_structural_impact "'"$GRAPH_ROOT"'" /repo/src/app.ts render' 2>/dev/null)"
expect_eq "structural-impact: failing command -> swallowed, no stdout" "" "$out"
clear_env
expect_ok "structural-impact: failing command -> still exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$IMPACTERRBIN"':/usr/bin:/bin" memory_structural_impact "'"$GRAPH_ROOT"'" /repo/src/app.ts render'

# ---------- memory_path (graph-only, graceful) ----------

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs')"
expect_eq "path: graph ready -> returns CLI output" \
  'memory: path "zoom-out" -> "memory-bridge": 2 hop(s), weight 2' "$out"
clear_env
expect_ok "path: graph ready -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs'

clear_env
out="$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs')"
expect_eq "path: graph config but no CLI -> no output" "" "$out"
clear_env
expect_ok "path: graph config but no CLI -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs'

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_path "'"$INIT_ROOT"'" zoom-out memory-bridge bfs')"
expect_eq "path: markdown-only config -> no output" "" "$out"

clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out')"
expect_eq "path: missing destination label -> no output" "" "$out"

clear_env
NOPATHBIN="$TMP/nopathbin"
mkdir -p "$NOPATHBIN"
cat > "$NOPATHBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  path)
    echo "memory: no path from \"$2\" to \"$3\""
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$NOPATHBIN/memory"
out="$(PATH="$NOPATHBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs')"
expect_eq "path: no path result -> no output" "" "$out"

clear_env
EMPTYPATHBIN="$TMP/emptypathbin"
mkdir -p "$EMPTYPATHBIN"
cat > "$EMPTYPATHBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  path)
    exit 0
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$EMPTYPATHBIN/memory"
out="$(PATH="$EMPTYPATHBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs')"
expect_eq "path: empty command output -> no output" "" "$out"

clear_env
PATHERRBIN="$TMP/patherrbin"
mkdir -p "$PATHERRBIN"
cat > "$PATHERRBIN/memory" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  stats)
    echo "memory: 17 node(s), 3 edge(s)"
    ;;
  path)
    echo "path boom" >&2
    exit 1
    ;;
  *)
    exit 1
    ;;
esac
EOF
chmod +x "$PATHERRBIN/memory"
out="$(PATH="$PATHERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs' 2>/dev/null)"
expect_eq "path: failing command -> swallowed, no stdout" "" "$out"
clear_env
expect_ok "path: failing command -> still exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$PATHERRBIN"':/usr/bin:/bin" memory_path "'"$GRAPH_ROOT"'" zoom-out memory-bridge bfs'

# ---------- memory_recall (graceful, query passthrough) ----------

# Absent memory: silent no-op, exit 0, no output.
clear_env
out="$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_recall "'"$BARE_ROOT"'" cache ttl')"
expect_eq "recall: absent memory -> no output" "" "$out"
clear_env
expect_ok "recall: absent memory -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin memory_recall "'"$BARE_ROOT"'" cache ttl'

# Config present but no CLI: still silent no-op, exit 0.
clear_env
out="$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_recall "'"$INIT_ROOT"'" cache ttl')"
expect_eq "recall: opted-in but no CLI -> no output" "" "$out"

# No query terms: no-op even when memory is fully available.
clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_recall "'"$INIT_ROOT"'"')"
expect_eq "recall: no query terms -> no output" "" "$out"

# Available memory: recall runs, output returned, query passed through verbatim.
clear_env
out="$(PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_recall "'"$INIT_ROOT"'" cache ttl regression')"
expect_eq "recall: available -> returns CLI output" \
  $'memory: 1 match for "cache ttl regression"\n  [1.0] note-1' "$out"
clear_env
expect_ok "recall: available -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$FAKE_BIN"':$PATH" memory_recall "'"$INIT_ROOT"'" cache ttl'

# A CLI that errors (exit 1) must not propagate failure to the dev process.
clear_env
ERRBIN="$TMP/errbin"
mkdir -p "$ERRBIN"
cat > "$ERRBIN/memory" <<'EOF'
#!/usr/bin/env bash
echo "boom" >&2
exit 1
EOF
chmod +x "$ERRBIN/memory"
out="$(PATH="$ERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_recall "'"$INIT_ROOT"'" q' 2>/dev/null)"
expect_eq "recall: erroring CLI -> swallowed, no stdout" "" "$out"
clear_env
expect_ok "recall: erroring CLI -> still exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$ERRBIN"':/usr/bin:/bin" memory_recall "'"$INIT_ROOT"'" q'

# ---------- memory_record_attempt (graph-only write, graceful) ----------

payload="$TMP/attempt-payload.json"
cat > "$payload" <<'EOF'
{"repository":"reddb-io/red-skills","issueNumber":99,"attemptNumber":1,"status":"done"}
EOF

clear_env
FAKE_ATTEMPT_OUT="$TMP/attempt-out.json"
out="$(FAKE_ATTEMPT_OUT="$FAKE_ATTEMPT_OUT" PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"')"
expect_eq "record-attempt: graph ready -> no stdout" "" "$out"
expect_eq "record-attempt: graph ready -> forwards JSON payload" \
  "$(cat "$payload")" "$(cat "$FAKE_ATTEMPT_OUT")"
clear_env
expect_ok "record-attempt: graph ready -> exit 0" \
  bash -c 'source "'"$LIB"'"; FAKE_ATTEMPT_OUT="'"$TMP/attempt-ok.json"'" PATH="'"$FAKE_BIN"':$PATH" memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"'

clear_env
rm -f "$TMP/attempt-markdown.json"
out="$(FAKE_ATTEMPT_OUT="$TMP/attempt-markdown.json" PATH="$FAKE_BIN:$PATH" bash -c 'source "'"$LIB"'"; memory_record_attempt "'"$INIT_ROOT"'" "'"$payload"'"')"
expect_eq "record-attempt: markdown-only -> no output" "" "$out"
if [[ ! -e "$TMP/attempt-markdown.json" ]]; then
  echo "PASS  record-attempt: markdown-only -> does not call CLI"; pass=$((pass + 1))
else
  echo "FAIL  record-attempt: markdown-only -> unexpectedly called CLI"; fail=$((fail + 1))
fi

clear_env
out="$(PATH=/usr/bin:/bin bash -c 'source "'"$LIB"'"; memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"')"
expect_eq "record-attempt: graph config but no CLI -> no output" "" "$out"
clear_env
expect_ok "record-attempt: graph config but no CLI -> exit 0" \
  bash -c 'source "'"$LIB"'"; PATH=/usr/bin:/bin memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"'

clear_env
out="$(PATH="$ERRBIN:/usr/bin:/bin" bash -c 'source "'"$LIB"'"; memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"' 2>/dev/null)"
expect_eq "record-attempt: erroring CLI -> swallowed, no stdout" "" "$out"
clear_env
expect_ok "record-attempt: erroring CLI -> still exit 0" \
  bash -c 'source "'"$LIB"'"; PATH="'"$ERRBIN"':/usr/bin:/bin" memory_record_attempt "'"$GRAPH_ROOT"'" "'"$payload"'"'

# ---------- summary ----------
echo
echo "memory-bridge: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
