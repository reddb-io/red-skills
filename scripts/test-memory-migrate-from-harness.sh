#!/usr/bin/env bash
# Fixture-based test for the harness-to-repo memory migration (issue #220).
#
# Covers the acceptance grid from the issue brief:
#
#   1. Fresh-repo migration moves MEMORY.md plus per-fact files into
#      <repo>/.red/memory/{MEMORY.md, memory/<slug>.md}.
#   2. Bare per-fact links inside MEMORY.md are rewritten to point at the
#      new memory/ subdirectory so the index still resolves after the move.
#   3. The original harness path becomes a symlink to <repo>/.red/memory.
#   4. Re-running the script on an already-migrated repo prints
#      "already migrated, no-op" and changes nothing on disk.
#   5. Symlink resolution works from the harness side: reading
#      <harness>/MEMORY.md returns the same bytes as <repo>/.red/memory/MEMORY.md.
#   6. Fresh-clone replay (target already populated, harness still pristine)
#      installs the symlink without touching the existing repo files.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SCRIPT="$ROOT/scripts/memory-migrate-from-harness.sh"
chmod +x "$SCRIPT"

fail_count=0
pass_count=0
pass() { printf 'PASS  %s\n' "$1"; pass_count=$((pass_count + 1)); }
fail() { printf 'FAIL  %s\n' "$1" >&2; fail_count=$((fail_count + 1)); }

assert_file_exists() {
  if [ -f "$2" ]; then pass "$1"; else fail "$1 — missing $2"; fi
}
assert_symlink() {
  if [ -L "$2" ]; then pass "$1"; else fail "$1 — not a symlink: $2"; fi
}
assert_grep() {
  if grep -qE "$2" "$3"; then pass "$1"; else fail "$1 — pattern not found: $2 in $3"; fi
}
assert_eq() {
  if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 — expected '$3', got '$2'"; fi
}

setup_fixture() {
  local sandbox="$1" slug="repo-fixture"
  rm -rf "$sandbox"
  mkdir -p "$sandbox/harness/$slug/memory"
  mkdir -p "$sandbox/repo"
  ( cd "$sandbox/repo" && git init -q && git config user.email t@t && git config user.name t )

  cat >"$sandbox/harness/$slug/memory/MEMORY.md" <<'EOF'
- [Red workflow prefix](feedback_red_workflow_prefix.md) — all workflow filenames start with red-
- [English-only](feedback_repo_english_only.md) — repo content is English
EOF

  cat >"$sandbox/harness/$slug/memory/feedback_red_workflow_prefix.md" <<'EOF'
---
name: red-workflow-prefix
type: feedback
---

Rule: GitHub Actions workflow filenames must start with `red-`.
EOF

  cat >"$sandbox/harness/$slug/memory/feedback_repo_english_only.md" <<'EOF'
---
name: repo-english-only
type: feedback
---

Rule: repo content is English; chat may stay Portuguese.
EOF
}

run_migrate() {
  local sandbox="$1"
  "$SCRIPT" \
    --harness-root "$sandbox/harness" \
    --repo-root    "$sandbox/repo" \
    --project-slug "repo-fixture"
}

SANDBOX="$(mktemp -d)"
trap 'rm -rf "$SANDBOX"' EXIT

# --- (1) fresh-repo migration ------------------------------------------------

setup_fixture "$SANDBOX"
out1="$(run_migrate "$SANDBOX")"

assert_file_exists "MEMORY.md landed at repo target"        "$SANDBOX/repo/.red/memory/MEMORY.md"
assert_file_exists "per-fact file landed under memory/"     "$SANDBOX/repo/.red/memory/memory/feedback_red_workflow_prefix.md"
assert_file_exists "per-fact file landed under memory/ (2)" "$SANDBOX/repo/.red/memory/memory/feedback_repo_english_only.md"

# (2) Link rewrite — bare slug becomes memory/<slug>.md
assert_grep "MEMORY.md link rewritten for workflow-prefix" \
  '\]\(memory/feedback_red_workflow_prefix\.md\)' \
  "$SANDBOX/repo/.red/memory/MEMORY.md"
assert_grep "MEMORY.md link rewritten for english-only" \
  '\]\(memory/feedback_repo_english_only\.md\)' \
  "$SANDBOX/repo/.red/memory/MEMORY.md"

# (3) Harness path is a symlink to the repo target
assert_symlink "harness path is a symlink"  "$SANDBOX/harness/repo-fixture/memory"
link_target="$(readlink -f "$SANDBOX/harness/repo-fixture/memory")"
expected="$(readlink -f "$SANDBOX/repo/.red/memory")"
assert_eq "symlink resolves to repo target" "$link_target" "$expected"

# (5) Reading via the harness side returns the repo content
harness_bytes="$(cat "$SANDBOX/harness/repo-fixture/memory/MEMORY.md")"
repo_bytes="$(cat "$SANDBOX/repo/.red/memory/MEMORY.md")"
assert_eq "harness-side read matches repo-side bytes" "$harness_bytes" "$repo_bytes"

# Per-fact file resolves via the rewritten link path through the symlink.
assert_file_exists "rewritten link resolves through symlink" \
  "$SANDBOX/harness/repo-fixture/memory/memory/feedback_red_workflow_prefix.md"

# --- (4) idempotent re-run ---------------------------------------------------

snapshot_before="$(find "$SANDBOX/repo/.red/memory" -type f -exec sha256sum {} \; | sort)"
out2="$(run_migrate "$SANDBOX")"

if printf '%s' "$out2" | grep -q "already migrated"; then
  pass "re-run prints already-migrated message"
else
  fail "re-run did not print already-migrated; got: $out2"
fi

snapshot_after="$(find "$SANDBOX/repo/.red/memory" -type f -exec sha256sum {} \; | sort)"
assert_eq "re-run leaves repo files byte-identical" "$snapshot_after" "$snapshot_before"

# Symlink still in place after the no-op
assert_symlink "harness symlink still present after re-run" \
  "$SANDBOX/harness/repo-fixture/memory"

# --- (6) fresh-clone replay (target populated, harness pristine real dir) ----

rm -rf "$SANDBOX/harness/repo-fixture/memory"
mkdir -p "$SANDBOX/harness/repo-fixture/memory"
# leave a stale file behind to be sure the script does NOT salvage from it
echo "stale" > "$SANDBOX/harness/repo-fixture/memory/MEMORY.md"

# Capture target snapshot before the replay — must be byte-identical after.
target_before="$(find "$SANDBOX/repo/.red/memory" -type f -exec sha256sum {} \; | sort)"
"$SCRIPT" \
  --harness-root "$SANDBOX/harness" \
  --repo-root    "$SANDBOX/repo" \
  --project-slug "repo-fixture" >/dev/null

assert_symlink "fresh-clone replay installs symlink" "$SANDBOX/harness/repo-fixture/memory"
target_after="$(find "$SANDBOX/repo/.red/memory" -type f -exec sha256sum {} \; | sort)"
assert_eq "fresh-clone replay leaves target untouched" "$target_after" "$target_before"

harness_read="$(cat "$SANDBOX/harness/repo-fixture/memory/MEMORY.md")"
if ! printf '%s' "$harness_read" | grep -q '^stale$'; then
  pass "fresh-clone replay surfaces repo content, not stale harness data"
else
  fail "fresh-clone replay surfaces stale harness content"
fi

# --- summary -----------------------------------------------------------------

printf '\n%d passed, %d failed\n' "$pass_count" "$fail_count"
[ "$fail_count" -eq 0 ]
