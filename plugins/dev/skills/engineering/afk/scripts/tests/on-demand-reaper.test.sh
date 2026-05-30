#!/usr/bin/env bash
# Tests for issue #275: one on-demand command reports AFK branch counts and runs
# the branch reapers for remote afk/*, remote afk-attempts/*, and local afk/*.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
SCRIPT="$SCRIPTS/afk-reap.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

SHIM_DIR="$TMP/shim"
GH_DIR="$TMP/gh-meta"
GIT_LOG="$TMP/git.calls"
ERR_LOG="$TMP/reaper.err"
OUT_LOG="$TMP/reaper.out"
mkdir -p "$SHIM_DIR" "$GH_DIR"
: >"$GIT_LOG"

REAL_GIT="$(command -v git)"

cat >"$SHIM_DIR/gh" <<SHIM
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >>"$GIT_LOG"
case "\$*" in
  *"repo view"*) printf '{"nameWithOwner":"owner/repo"}\n'; exit 0 ;;
esac
n=""; want_view=0; i=1
while (( i <= \$# )); do
  a="\${!i}"
  [[ "\$a" == "view" ]] && want_view=1
  if [[ "\$want_view" == 1 && "\$a" =~ ^[0-9]+\$ ]]; then n="\$a"; break; fi
  i=\$((i+1))
done
f="$GH_DIR/\$n.json"
if [[ -n "\$n" && -f "\$f" ]]; then cat "\$f"; exit 0; fi
echo "HTTP 500: transient failure" >&2
exit 1
SHIM
chmod 0755 "$SHIM_DIR/gh"

export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0

expect_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then echo "PASS  $label"; pass=$((pass + 1))
  else printf 'FAIL  %s\n      missing: %q\n      in:       %q\n' "$label" "$needle" "$haystack"; fail=$((fail + 1)); fi
}

expect_not_contains() {
  local label="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then echo "PASS  $label"; pass=$((pass + 1))
  else printf 'FAIL  %s\n      unexpected: %q\n      in:        %q\n' "$label" "$needle" "$haystack"; fail=$((fail + 1)); fi
}

expect_rc0() {
  local label="$1"; shift
  if "$@"; then echo "PASS  $label"; pass=$((pass + 1))
  else echo "FAIL  $label (returned non-zero: $*)"; fail=$((fail + 1)); fi
}

expect_not_ok() {
  local label="$1"; shift
  if "$@"; then echo "FAIL  $label (command unexpectedly succeeded: $*)"; fail=$((fail + 1))
  else echo "PASS  $label"; pass=$((pass + 1)); fi
}

gh_fixture() {
  local n="$1" state="$2" closed="$3"
  printf '{"state":"%s","closedAt":"%s"}\n' "$state" "$closed" >"$GH_DIR/$n.json"
}

branch_exists() {
  git -C "$REPO" show-ref --verify --quiet "refs/heads/$1"
}

worker_tree_exists() {
  [[ -e "$REPO/.red/tmp/workers" ]]
}

iso_ago() { date -u -d "@$(( $(date +%s) - $1 ))" +%Y-%m-%dT%H:%M:%SZ; }

REPO="$TMP/repo"
REMOTE="$TMP/origin.git"
mkdir -p "$REPO"
git -C "$REPO" init -q
git -C "$REPO" config user.email test@example.invalid
git -C "$REPO" config user.name "Test User"
printf 'base\n' >"$REPO/file.txt"
git -C "$REPO" add file.txt
git -C "$REPO" commit -qm base
git -C "$REPO" branch -M main
git -C "$REPO" init --bare -q "$REMOTE"
git -C "$REPO" remote add origin "$REMOTE"
git -C "$REPO" push -q origin main

git -C "$REPO" branch afk/wLOC/700-closed main
git -C "$REPO" branch afk/wLOP/701-open main
git -C "$REPO" push -q origin main:refs/heads/afk/wREM/702-closed
git -C "$REPO" push -q origin main:refs/heads/afk/wROP/703-open
git -C "$REPO" push -q origin main:refs/heads/afk-attempts/wATT/704-old
git -C "$REPO" push -q origin main:refs/heads/afk-attempts/wATP/705-open

DAY=86400
gh_fixture 700 CLOSED "$(iso_ago $((30*DAY)))"
gh_fixture 701 OPEN ""
gh_fixture 702 CLOSED "$(iso_ago $((30*DAY)))"
gh_fixture 703 OPEN ""
gh_fixture 704 CLOSED "$(iso_ago $((30*DAY)))"
gh_fixture 705 OPEN ""

RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) "$SCRIPT" "$REPO" >"$OUT_LOG" 2>"$ERR_LOG"
rc=$?
if [[ "$rc" -eq 0 ]]; then echo "PASS  on-demand command exits 0"; pass=$((pass + 1))
else echo "FAIL  on-demand command exits 0 (rc=$rc)"; fail=$((fail + 1)); fi

out="$(cat "$OUT_LOG")"
err="$(cat "$ERR_LOG")"

expect_contains "command reports counts in one line" "$out" "afk branch counts: remote-afk=2 remote-afk-attempts=2 local-afk=2"
expect_not_ok "command does not boot a worker tree" worker_tree_exists
expect_contains "command logs remote live deletion reason" "$err" "reaper: deleted remote live branch afk/wREM/702-closed (issue #702: closed-within-grace)"
expect_contains "command logs remote snapshot deletion reason" "$err" "reaper: deleted remote snapshot branch afk-attempts/wATT/704-old (issue #704: closed-past-grace)"
expect_contains "command logs local deletion reason" "$err" "reaper: deleted local live branch afk/wLOC/700-closed (issue #700: closed-past-grace)"

expect_not_ok "local closed branch deleted" branch_exists "afk/wLOC/700-closed"
expect_rc0    "local open branch kept" branch_exists "afk/wLOP/701-open"

refs="$(git -C "$REPO" ls-remote --heads origin)"
expect_not_contains "remote closed live branch deleted" "$refs" "refs/heads/afk/wREM/702-closed"
expect_contains     "remote open live branch kept"     "$refs" "refs/heads/afk/wROP/703-open"
expect_not_contains "remote old snapshot deleted"      "$refs" "refs/heads/afk-attempts/wATT/704-old"
expect_contains     "remote open snapshot kept"        "$refs" "refs/heads/afk-attempts/wATP/705-open"

: >"$ERR_LOG"
RED_AFK_ATTEMPT_SNAPSHOT_GRACE_S=$((7*DAY)) "$SCRIPT" "$REPO" >/dev/null 2>"$ERR_LOG"
expect_not_contains "second run is idempotent: no duplicate deletion logs" "$(cat "$ERR_LOG")" "reaper: deleted"

expect_contains "command invoked gh issue classifier" "$(cat "$GIT_LOG")" "issue view 703"

echo
echo "on-demand-reaper: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
