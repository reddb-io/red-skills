#!/usr/bin/env bash
# Tests for plugins/.../afk/scripts/lib/remote-branch.sh (issue #191).
#
# Covers the three functions the acceptance criteria name:
#   - push_initial: invokes `git push` with --force-with-lease and the right
#     refspec, tolerates a non-zero exit from git.
#   - install_post_commit_hook: writes an executable file at
#     $worktree/.git/hooks/post-commit containing both the `git push` line and
#     the `|| true` guard.
#   - delete_remote: invokes `git push origin --delete <branch>` from
#     $PROJECT_ROOT and tolerates a non-zero exit from git.
#
# git is mocked via PATH override: a shim records every call to a log file and
# can be flipped to fail mid-test.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/remote-branch.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GIT_LOG="$TMP/git.calls"
GIT_FAIL_FILE="$TMP/git.fail"
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR"

# Resolve the real git up front so the shim can still service `rev-parse
# --git-dir` for a synthetic worktree without our mock interfering.
REAL_GIT="$(command -v git)"

cat >"$SHIM_DIR/git" <<SHIM
#!/usr/bin/env bash
# Record every invocation, then either fail on demand or delegate to the real
# git for harmless plumbing the lib needs (rev-parse --git-dir).
printf '%s\n' "\$*" >>"$GIT_LOG"
# Walk args to find the verb after any leading "-C <dir>" pair.
verb=""
i=1
while (( i <= \$# )); do
  a="\${!i}"
  if [[ "\$a" == "-C" ]]; then
    i=\$((i+2))
    continue
  fi
  verb="\$a"
  break
done
if [[ "\$verb" == "rev-parse" ]]; then
  # Always delegate rev-parse to real git so the lib can locate .git for the
  # synthetic worktree we created below.
  exec "$REAL_GIT" "\$@"
fi
if [[ -f "$GIT_FAIL_FILE" ]]; then
  exit 1
fi
exit 0
SHIM
chmod 0755 "$SHIM_DIR/git"

export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0

reset_calls() { : >"$GIT_LOG"; rm -f "$GIT_FAIL_FILE"; }
git_fail()    { : >"$GIT_FAIL_FILE"; }
calls()       { cat "$GIT_LOG"; }

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

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    printf 'FAIL  %s\n      missing: %q\n      in:       %q\n' "$label" "$needle" "$haystack"
    fail=$((fail + 1))
  fi
}

expect_rc0() {
  local label="$1"; shift
  if "$@"; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label (command returned non-zero: $*)"
    fail=$((fail + 1))
  fi
}

# Synthetic worktree so install_post_commit_hook can locate .git/hooks.
WT="$TMP/worktree"
"$REAL_GIT" init -q "$WT"

# shellcheck source=../lib/remote-branch.sh
source "$LIB"

# ---------- push_initial ----------

reset_calls
expect_rc0 "push_initial: returns 0 on success" push_initial "$WT" "afk/wABC/42-slug"
push_calls="$(calls)"
expect_contains "push_initial: uses --force-with-lease" "$push_calls" "--force-with-lease"
expect_contains "push_initial: refspec is HEAD:refs/heads/<branch>" "$push_calls" "HEAD:refs/heads/afk/wABC/42-slug"
expect_contains "push_initial: targets origin" "$push_calls" "origin"
expect_contains "push_initial: sets upstream (-u)" "$push_calls" "-u"

reset_calls
git_fail
expect_rc0 "push_initial: tolerates non-zero git" push_initial "$WT" "afk/wABC/42-slug"

reset_calls
expect_rc0 "push_initial: empty branch returns 0 without pushing" push_initial "$WT" ""
expect_eq "push_initial: empty branch does not call git" "" "$(calls)"

# ---------- install_post_commit_hook ----------

HOOK_PATH="$WT/.git/hooks/post-commit"
rm -f "$HOOK_PATH"

reset_calls
expect_rc0 "install_post_commit_hook: returns 0" install_post_commit_hook "$WT" "afk/wABC/42-slug"

if [[ -f "$HOOK_PATH" ]]; then
  echo "PASS  install_post_commit_hook: writes the hook file"
  pass=$((pass + 1))
else
  echo "FAIL  install_post_commit_hook: hook file missing at $HOOK_PATH"
  fail=$((fail + 1))
fi

if [[ -x "$HOOK_PATH" ]]; then
  echo "PASS  install_post_commit_hook: hook is executable"
  pass=$((pass + 1))
else
  echo "FAIL  install_post_commit_hook: hook is not executable"
  fail=$((fail + 1))
fi

HOOK_BODY="$(cat "$HOOK_PATH" 2>/dev/null || true)"
expect_contains "install_post_commit_hook: body has git push line" "$HOOK_BODY" "git push origin HEAD --force-with-lease"
expect_contains "install_post_commit_hook: body has '|| true' guard" "$HOOK_BODY" "|| true"
expect_contains "install_post_commit_hook: body has shebang" "$HOOK_BODY" "#!/usr/bin/env bash"

# Idempotent rewrite.
expect_rc0 "install_post_commit_hook: idempotent rewrite returns 0" install_post_commit_hook "$WT" "afk/wABC/42-slug"

# ---------- delete_remote ----------

reset_calls
PROJECT_ROOT="$WT" expect_rc0 "delete_remote: returns 0 on success" delete_remote "afk/wABC/42-slug"
del_calls="$(calls)"
expect_contains "delete_remote: invokes git push origin --delete" "$del_calls" "push origin --delete afk/wABC/42-slug"

reset_calls
git_fail
PROJECT_ROOT="$WT" expect_rc0 "delete_remote: tolerates non-zero git" delete_remote "afk/wABC/42-slug"

reset_calls
expect_rc0 "delete_remote: empty branch returns 0 without pushing" delete_remote ""
expect_eq "delete_remote: empty branch does not call git" "" "$(calls)"

# ---------- summary ----------
echo
echo "remote-branch: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
