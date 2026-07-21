#!/usr/bin/env bash
# Contract tests for the release manifest-bump push (scripts/release-push-bump.sh).
#
# The v2.77.0 release published npm packages and then died on
# `git push origin HEAD:main` — branch protection on main requires the `test`
# and `typecheck` contexts, which a freshly created bump commit can never carry
# at push time, so the push is declined with GH006. The old retry loop then
# rebased, hit "cannot rebase: You have unstaged changes" (the release build
# leaves generated files dirty), and aborted the job BEFORE the tag and the
# GitHub Release — a partial release.
#
# These tests drive the real helper against a real local remote, including a
# pre-receive hook that reproduces the GH006 rejection.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

WORKFLOW=".github/workflows/red-release.yml"
HELPER="$ROOT/scripts/release-push-bump.sh"
failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

pass() {
  printf 'PASS: %s\n' "$*"
}

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# --- static contract -------------------------------------------------------

if grep -qF 'scripts/release-push-bump.sh' "$WORKFLOW"; then
  pass "release workflow delegates the bump push to the helper"
else
  fail "release workflow must push the bump commit via scripts/release-push-bump.sh"
fi

if grep -qF 'RED_RELEASE_TOKEN: ${{ secrets.RED_RELEASE_TOKEN }}' "$WORKFLOW"; then
  pass "release workflow passes the optional bypass-capable token"
else
  fail "release workflow must pass RED_RELEASE_TOKEN to the bump push"
fi

if grep -qF 'x-access-token:${RED_RELEASE_TOKEN}' "$HELPER"; then
  pass "helper prefers RED_RELEASE_TOKEN credentials when the secret is set"
else
  fail "helper must push with RED_RELEASE_TOKEN when it is available"
fi

if grep -qF 'rebase --autostash' "$HELPER"; then
  pass "helper rebases with --autostash so a dirty worktree cannot wedge the retry"
else
  fail "helper must rebase with --autostash"
fi

if grep -qF 'HEAD:main' "$WORKFLOW"; then
  fail "release workflow must not push the bump commit to main inline"
else
  pass "no inline bump push to main survives in the workflow"
fi

# --- behavioural harness ---------------------------------------------------

seed_repo() {
  # $1 = case dir name, $2 = protected|open
  local name="$1" mode="$2"
  local remote="$TMP/$name-remote.git" work="$TMP/$name"
  rm -rf "$remote" "$work"
  git init -q --bare "$remote"
  # The bare remote's HEAD must name main explicitly: on a runner with no
  # init.defaultBranch the bare init points HEAD at master, so a later clone
  # of this remote checks out nothing and its pushes fail with
  # "src refspec main does not match any" (first seen killing the release
  # workflow itself, 2026-07-21).
  git -C "$remote" symbolic-ref HEAD refs/heads/main
  git init -q -b main "$work"
  git -C "$work" config user.email release@example.test
  git -C "$work" config user.name 'release bot'
  git -C "$work" config commit.gpgsign false
  printf 'seed\n' > "$work/seed.txt"
  git -C "$work" add seed.txt
  git -C "$work" commit -q -m 'seed'
  git -C "$work" remote add origin "$remote"
  git -C "$work" push -q -u origin main
  if [ "$mode" = protected ]; then
    cat > "$remote/hooks/pre-receive" <<'HOOK'
#!/usr/bin/env bash
while read -r _old _new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    echo "remote: error: GH006: Protected branch update failed for refs/heads/main." >&2
    echo "remote: - 2 of 2 required status checks are expected." >&2
    exit 1
  fi
done
exit 0
HOOK
    chmod +x "$remote/hooks/pre-receive"
  fi
  printf '%s\n' "$work"
}

make_bump_commit() {
  local work="$1"
  printf '{"version":"9.9.9"}\n' > "$work/manifest.json"
  git -C "$work" add manifest.json
  git -C "$work" commit -q -m 'chore(release): v9.9.9 [skip release]'
  # the release build leaves generated files dirty in the workspace
  printf 'stale build output\n' > "$work/dirty-build-artifact.txt"
  git -C "$work" add dirty-build-artifact.txt
  git -C "$work" commit -q -m 'tracked artifact'
  printf 'rebuilt output\n' > "$work/dirty-build-artifact.txt"
}

run_helper() {
  local work="$1"
  shift
  ( cd "$work" && NEXT=v9.9.9 BUMP_PUSH_ATTEMPTS=3 "$@" bash "$HELPER" ) 2>&1
}

remote_of() {
  printf '%s\n' "$TMP/$1-remote.git"
}

# case 1: a clean protected-free remote — the direct push just works.
work="$(seed_repo happy open)"
make_bump_commit "$work"
if out="$(run_helper "$work")"; then
  remote_main="$(git -C "$(remote_of happy)" rev-parse refs/heads/main)"
  local_head="$(git -C "$work" rev-parse HEAD)"
  if [ "$remote_main" = "$local_head" ]; then
    pass "direct push lands the bump commit on main"
  else
    fail "direct push did not update main (remote=$remote_main head=$local_head)"
  fi
  if [ "$(cat "$work/dirty-build-artifact.txt")" = "rebuilt output" ]; then
    pass "direct push leaves the dirty worktree untouched"
  else
    fail "direct push must not discard uncommitted build output"
  fi
else
  fail "direct push helper exited non-zero: $out"
fi

# case 2: another workflow pushed to main first — rebase-and-retry must win
# even though the worktree carries unstaged build output.
work="$(seed_repo race open)"
make_bump_commit "$work"
other="$TMP/race-other"
git clone -q "$(remote_of race)" "$other"
git -C "$other" config user.email other@example.test
git -C "$other" config user.name 'other bot'
printf 'concurrent\n' > "$other/concurrent.txt"
git -C "$other" add concurrent.txt
git -C "$other" commit -q -m 'concurrent push'
git -C "$other" push -q origin main
if out="$(run_helper "$work")"; then
  remote_main="$(git -C "$(remote_of race)" rev-parse refs/heads/main)"
  local_head="$(git -C "$work" rev-parse HEAD)"
  if [ "$remote_main" = "$local_head" ] &&
     git -C "$work" show --stat --oneline HEAD >/dev/null &&
     git -C "$work" cat-file -e HEAD:concurrent.txt 2>/dev/null; then
    pass "lost push race is recovered by a rebase onto the concurrent commit"
  else
    fail "rebase retry did not land the bump commit on top of main"
  fi
  if [ "$(cat "$work/dirty-build-artifact.txt")" = "rebuilt output" ]; then
    pass "rebase retry preserves unstaged build output (--autostash)"
  else
    fail "rebase retry lost the unstaged build output"
  fi
  case "$out" in
    *"cannot rebase"*) fail "rebase retry still aborts on unstaged changes" ;;
    *) pass "rebase retry never reports 'cannot rebase: You have unstaged changes'" ;;
  esac
else
  fail "rebase retry helper exited non-zero: $out"
fi

# case 3: branch protection declines the bump commit (GH006). The release must
# NOT die there — the helper parks the bump on a side branch, opens a PR and
# returns success so the tag and the GitHub Release still get cut.
work="$(seed_repo protected protected)"
make_bump_commit "$work"
stub="$TMP/stub-bin"
mkdir -p "$stub"
cat > "$stub/gh" <<STUB
#!/usr/bin/env bash
printf '%s\n' "\$*" >> "$TMP/gh-calls.log"
exit 0
STUB
chmod +x "$stub/gh"
if out="$(PATH="$stub:$PATH" run_helper "$work")"; then
  if git -C "$(remote_of protected)" rev-parse --verify -q refs/heads/release/bump-v9.9.9 >/dev/null; then
    pass "protected push falls back to the release/bump-v9.9.9 branch"
  else
    fail "protected push must park the bump commit on a side branch"
  fi
  if grep -q 'pr create' "$TMP/gh-calls.log" 2>/dev/null; then
    pass "protected push opens a PR for the parked bump commit"
  else
    fail "protected push must open a PR so main still gets bumped"
  fi
  case "$out" in
    *'::warning::'*) pass "protected push is reported as a warning, not a silent success" ;;
    *) fail "protected push must emit a ::warning:: annotation" ;;
  esac
  attempts="$(grep -c 'push rejected' <<<"$out" || true)"
  if [ "$attempts" -eq 0 ]; then
    pass "a protection rejection is not retried with pointless rebases"
  else
    fail "a protection rejection must not be retried ($attempts rebase attempts)"
  fi
else
  fail "protected push must exit 0 so the release still tags and publishes: $out"
fi

# case 4: an unclassified push failure is still a hard error.
work="$(seed_repo broken open)"
make_bump_commit "$work"
git -C "$work" remote set-url origin "$TMP/does-not-exist.git"
if out="$(run_helper "$work" 2>&1)"; then
  fail "an unrecoverable push failure must fail the step"
else
  case "$out" in
    *'::error::'*) pass "an unrecoverable push failure fails with ::error::" ;;
    *) fail "an unrecoverable push failure must emit ::error::" ;;
  esac
fi

if [ "$failures" -gt 0 ]; then
  printf '\n%d contract check(s) failed\n' "$failures" >&2
  exit 1
fi

printf '\nall release bump-push contract checks passed\n'
