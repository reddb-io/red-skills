#!/usr/bin/env bash
# lib/scope-resolver.sh — the Scope Resolver: decides whether the branch lock is
# enforced for a given git checkout, by toplevel location alone. Pure /
# explicit-args, like lib/lock-store.sh.
#
# The lock is defined as "the primary checkout's branch". /afk does its work in
# isolated worktrees under .red/tmp/work-*/, which must never be strangled by an
# interactive session's lock. The robust discriminator is *where the checkout
# lives*, not its branch name or an env flag (a branch can be named anything; an
# env flag relies on every caller setting it). So: a toplevel under
# .red/tmp/work-*/ is a worktree (exempt); anything else is the primary checkout
# (enforced).
#
# Public surface:
#   scope_is_worktree <toplevel>
#     Returns 0 when <toplevel> is (or is nested under) a .red/tmp/work-*/
#     directory — an /afk worktree. Returns 1 otherwise. No output.
#
#   scope_should_enforce <toplevel>
#     The verdict the hook wants: returns 0 (enforce the lock) for the primary
#     checkout, 1 (exempt) for a worktree. The exact inverse of
#     scope_is_worktree. No output.

# scope_is_worktree <toplevel>
scope_is_worktree() {
  local _top="$1"
  case "$_top" in
    */.red/tmp/work-*) return 0 ;;   # the worktree root itself
    */.red/tmp/work-*/*) return 0 ;; # nested below a worktree root
    *) return 1 ;;
  esac
}

# scope_should_enforce <toplevel>
scope_should_enforce() {
  if scope_is_worktree "$1"; then
    return 1
  fi
  return 0
}
