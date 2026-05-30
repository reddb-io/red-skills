#!/usr/bin/env bash
# Tests for issue #273 (PRD #244): boot-time cleanup of stale remote afk/*
# live-worker branches after their issues have closed.
#
#   prune_completed_remote_live_branches [repo-dir]
#     Lists remote afk/{wid}/{n}-{slug} live branches, plans keep/reap decisions
#     through the shared S1 decider, deletes CLOSED issue branches, and keeps
#     OPEN/unclassified issue branches. Best-effort, always rc 0, boot-time only.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS="$(dirname "$HERE")"
LIB="$SCRIPTS/lib/remote-branch.sh"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

GIT_LOG="$TMP/git.calls"
LSREMOTE_FILE="$TMP/ls-remote.out"
LSREMOTE_FAIL_FILE="$TMP/ls-remote.fail"
GH_DIR="$TMP/gh-meta"
SHIM_DIR="$TMP/shim"
mkdir -p "$SHIM_DIR" "$GH_DIR"
: >"$GIT_LOG"

REAL_GIT="$(command -v git)"

cat >"$SHIM_DIR/git" <<SHIM
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$GIT_LOG"
verb=""; i=1
while (( i <= \$# )); do
  a="\${!i}"
  if [[ "\$a" == "-C" ]]; then i=\$((i+2)); continue; fi
  verb="\$a"; break
done
case "\$verb" in
  ls-remote)
    if [[ -f "$LSREMOTE_FAIL_FILE" ]]; then exit 1; fi
    cat "$LSREMOTE_FILE" 2>/dev/null
    exit 0
    ;;
  push) exit 0 ;;
  *) exec "$REAL_GIT" "\$@" ;;
esac
SHIM
chmod 0755 "$SHIM_DIR/git"

cat >"$SHIM_DIR/gh" <<SHIM
#!/usr/bin/env bash
printf 'gh %s\n' "\$*" >>"$GIT_LOG"
n=""; want_view=0; i=1
while (( i <= \$# )); do
  a="\${!i}"
  [[ "\$a" == "view" ]] && want_view=1
  if [[ "\$want_view" == 1 && "\$a" =~ ^[0-9]+\$ ]]; then n="\$a"; break; fi
  i=\$((i+1))
done
f="$GH_DIR/\$n.json"
if [[ -n "\$n" && -f "\$f" ]]; then cat "\$f"; exit 0; fi
if [[ -n "\$n" && -f "$GH_DIR/\$n.error" ]]; then cat "$GH_DIR/\$n.error" >&2; exit 1; fi
echo "HTTP 500: transient failure" >&2
exit 1
SHIM
chmod 0755 "$SHIM_DIR/gh"

export PATH="$SHIM_DIR:$PATH"

gh_repo() { echo "owner/repo"; }

pass=0
fail=0

reset_calls() { : >"$GIT_LOG"; rm -f "$LSREMOTE_FAIL_FILE"; }
calls() { cat "$GIT_LOG"; }

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

gh_fixture() {
  local n="$1" state="$2" closed="$3"
  printf '{"state":"%s","closedAt":"%s"}\n' "$state" "$closed" >"$GH_DIR/$n.json"
}
gh_error() {
  rm -f "$GH_DIR/$1.json"
  printf '%s\n' "${2:-rate limit}" >"$GH_DIR/$1.error"
}

PROJECT_ROOT="$TMP"

# shellcheck source=../lib/remote-branch.sh
source "$LIB"

# ---------- pure decider: live namespace policy ----------
declare -A DECIDER_CLASS=(
  [500]=closed-within-grace
  [501]=open
  [502]=unresolved-transient
  [503]=not-found
)
decider_classifier() { printf '%s\n' "${DECIDER_CLASS[$1]:-unresolved-transient}"; }

decider_refs="$(cat <<EOF
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	refs/heads/afk/wAAA/500-closed
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	refs/heads/afk/wBBB/501-open
cccccccccccccccccccccccccccccccccccccccc	refs/heads/afk/wCCC/502-rate-limited
dddddddddddddddddddddddddddddddddddddddd	refs/heads/afk/wDDD/503-missing
eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee	refs/heads/afk-attempts/wEEE/500-snapshot
EOF
)"
plan="$(live_branch_cleanup_plan "$decider_refs" decider_classifier)"
expect_contains "decider: reaps closed live branch" "$plan" $'reap	afk/wAAA/500-closed	500	closed-within-grace'
expect_contains "decider: keeps open live branch" "$plan" $'keep	afk/wBBB/501-open	501	open'
expect_contains "decider: keeps transient live branch" "$plan" $'keep	afk/wCCC/502-rate-limited	502	unresolved-transient'
expect_contains "decider: keeps missing live branch" "$plan" $'keep	afk/wDDD/503-missing	503	not-found'
expect_not_contains "decider: ignores snapshot namespace" "$plan" "afk-attempts/wEEE/500-snapshot"

cat >"$LSREMOTE_FILE" <<EOF
aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa	refs/heads/afk/wAAA/500-closed
bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb	refs/heads/afk/wBBB/501-open
cccccccccccccccccccccccccccccccccccccccc	refs/heads/afk/wCCC/502-rate-limited
EOF

gh_fixture 500 CLOSED "2026-05-01T00:00:00Z"
gh_fixture 501 OPEN ""
gh_error 502 "rate limit"

# ---------- closed issue live branch is deleted ----------
reset_calls
expect_rc0 "remote live prune: returns 0" prune_completed_remote_live_branches
log_out="$(calls)"
expect_contains "remote live prune: lists only remote live branches" "$log_out" "ls-remote --heads origin refs/heads/afk/*"
expect_contains "remote live prune: deletes closed issue branch" "$log_out" "push origin --delete afk/wAAA/500-closed"

# ---------- open and transient issue branches survive ----------
expect_not_contains "remote live prune: keeps open issue branch" "$log_out" "--delete afk/wBBB/501-open"
expect_not_contains "remote live prune: keeps transient issue branch" "$log_out" "--delete afk/wCCC/502-rate-limited"

# ---------- transient git listing failure is safe and best-effort ----------
reset_calls
: >"$LSREMOTE_FAIL_FILE"
expect_rc0 "remote live prune: ls-remote failure returns 0" prune_completed_remote_live_branches
expect_not_contains "remote live prune: ls-remote failure deletes nothing" "$(calls)" "--delete"

# ---------- static guard: boot wires the prune after snapshot cleanup ----------
expect_rc0 "guard: afk.sh boot calls prune_completed_remote_live_branches" \
  grep -q 'prune_completed_remote_live_branches' "$SCRIPTS/afk.sh"

echo
echo "remote-live-branch-cleanup: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
