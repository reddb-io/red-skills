#!/usr/bin/env bash
# Package-aware feedback tests for /afk. These fixtures exercise feedback()
# through git worktrees with root-only and nested-package layouts.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# shellcheck disable=SC1090
source "$AFK_SH"

pass=0
fail=0

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label — missing: $needle"
    echo "----- haystack -----"
    echo "$haystack"
    echo "--------------------"
    fail=$((fail + 1))
  fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if grep -qF -- "$needle" <<<"$haystack"; then
    echo "FAIL  $label — unexpectedly found: $needle"
    fail=$((fail + 1))
  else
    echo "PASS  $label"
    pass=$((pass + 1))
  fi
}

expect_eq() {
  local label="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label — expected $expected got $actual"
    fail=$((fail + 1))
  fi
}

make_pnpm_stub() {
  local dir="$1"
  mkdir -p "$dir"
  cat > "$dir/pnpm" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

scope="."
if [[ "${1:-}" == "-C" ]]; then
  target="$2"
  shift 2
  scope="${target#"$FEEDBACK_REPO"/}"
  [[ "$scope" == "$target" ]] && scope="."
fi

script="${1:-}"
printf '%s|%s\n' "$scope" "$script" >> "$PNPM_CALLS"

if [[ "${PNPM_FAIL_SCOPE:-}" == "$scope" && "${PNPM_FAIL_SCRIPT:-}" == "$script" ]]; then
  echo "forced failure for $scope $script"
  exit 42
fi
SH
  chmod +x "$dir/pnpm"
}

init_repo() {
  local repo="$1"
  git -C "$repo" init -q
  git -C "$repo" config user.email "afk-test@example.test"
  git -C "$repo" config user.name "AFK Test"
  git -C "$repo" checkout -q -b main
}

commit_all() {
  local repo="$1" msg="$2"
  git -C "$repo" add -A
  git -C "$repo" commit -q -m "$msg"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

stub="$tmp/bin"
make_pnpm_stub "$stub"

# ---------- nested package touched ----------
repo="$tmp/nested"
mkdir -p "$repo/plugins/memory/src"
init_repo "$repo"
cat > "$repo/plugins/memory/package.json" <<'JSON'
{"scripts":{"test":"vitest run","typecheck":"tsc --noEmit","build":"tsc -p tsconfig.build.json"}}
JSON
printf 'export const value = 1;\n' > "$repo/plugins/memory/src/index.ts"
commit_all "$repo" "base"
git -C "$repo" update-ref refs/remotes/origin/main HEAD
printf 'export const value = 2;\n' > "$repo/plugins/memory/src/index.ts"
commit_all "$repo" "touch nested package"

calls="$tmp/nested.calls"
out="$(FEEDBACK_REPO="$repo" PNPM_CALLS="$calls" PATH="$stub:$PATH" feedback "$repo" origin/main)"
rc=$?

expect_eq "nested feedback succeeds" "0" "$rc"
expect_contains "nested test ran package" "$out" "test:plugins/memory:✓"
expect_contains "nested typecheck ran package" "$out" "typecheck:plugins/memory:✓"
expect_contains "nested lint reports explicit package skip" "$out" "lint:plugins/memory:skip"
expect_contains "nested build ran package" "$out" "build:plugins/memory:✓"
nested_calls="$(cat "$calls" 2>/dev/null || true)"
expect_contains "nested pnpm called test in package" "$nested_calls" "plugins/memory|test"
expect_not_contains "nested pnpm did not run root" "$nested_calls" ".|test"

# ---------- root-only repo keeps root validation ----------
repo="$tmp/root-only"
mkdir -p "$repo/src"
init_repo "$repo"
cat > "$repo/package.json" <<'JSON'
{"scripts":{"test":"node test.js"}}
JSON
printf 'console.log(1)\n' > "$repo/src/index.js"
commit_all "$repo" "base"
git -C "$repo" update-ref refs/remotes/origin/main HEAD
printf 'console.log(2)\n' > "$repo/src/index.js"
commit_all "$repo" "touch root"

calls="$tmp/root.calls"
out="$(FEEDBACK_REPO="$repo" PNPM_CALLS="$calls" PATH="$stub:$PATH" feedback "$repo" origin/main)"
rc=$?

expect_eq "root-only feedback succeeds" "0" "$rc"
expect_contains "root-only test ran root" "$out" "test:root:✓"
expect_contains "root-only missing typecheck is explicit" "$out" "typecheck:root:skip"
expect_contains "root-only pnpm called root test" "$(<"$calls")" ".|test"

# ---------- package failure returns non-zero ----------
repo="$tmp/failing"
mkdir -p "$repo/plugins/memory/src"
init_repo "$repo"
cat > "$repo/plugins/memory/package.json" <<'JSON'
{"scripts":{"test":"vitest run"}}
JSON
printf 'export const value = 1;\n' > "$repo/plugins/memory/src/index.ts"
commit_all "$repo" "base"
git -C "$repo" update-ref refs/remotes/origin/main HEAD
printf 'export const value = 2;\n' > "$repo/plugins/memory/src/index.ts"
commit_all "$repo" "touch nested package"

calls="$tmp/failing.calls"
set +e
out="$(FEEDBACK_REPO="$repo" PNPM_CALLS="$calls" PNPM_FAIL_SCOPE="plugins/memory" PNPM_FAIL_SCRIPT="test" PATH="$stub:$PATH" feedback "$repo" origin/main)"
rc=$?
set -e

expect_eq "failing package feedback returns non-zero" "1" "$rc"
expect_contains "failing package reported failed script" "$out" "test:plugins/memory:✗"
expect_contains "failing package still reports missing build" "$out" "build:plugins/memory:skip"

echo
echo "summary: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
