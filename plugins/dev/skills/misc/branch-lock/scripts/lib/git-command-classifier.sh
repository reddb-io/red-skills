#!/usr/bin/env bash
# lib/git-command-classifier.sh — the Git Command Classifier: given the locked
# branch and a shell command string, decides whether the command leaves the
# locked branch and must be blocked. Pure / explicit-args, like the sibling
# lib/ modules. Self-contained: it carries its own small command matcher so the
# branch-lock hook needs no dependency on the git-guardrails skill.
#
# This is the *minimal* classifier for the tracer-bullet slice: it recognises
# branch-leaving `git checkout <branch>` / `git switch <branch>` and blocks them
# unless the target is the lock branch itself. Everything else is allowed —
# file-level restore (`git checkout -- <path>`), a bare `git checkout`, and
# `git worktree add` (worktrees are how /afk works and are exempt by scope).
#
# Recognition is intentionally conservative: it scans the token stream for a
# `git` token immediately followed by `checkout` / `switch` / `worktree`, so a
# compound command (`cd x && git switch y`) is still classified. The first
# non-flag operand after checkout/switch is the move target; a `--` separator
# means the operands are paths (file restore), not a branch.
#
# Public surface:
#   classify_git_command <lock_branch> <command>
#     Echoes exactly "block" or "allow" and returns 0. "block" only when the
#     command switches to a branch other than <lock_branch>; "allow" for every
#     other case (including switching back to <lock_branch>, file restore,
#     worktree add, and non-checkout commands).

# classify_git_command <lock_branch> <command>
classify_git_command() {
  local _lock="$1" _cmd="$2"
  local -a toks
  read -ra toks <<<"$_cmd"
  local n=${#toks[@]} i j

  for ((i = 0; i < n; i++)); do
    [[ "${toks[i]}" == "git" ]] || continue
    local sub="${toks[i + 1]:-}"
    case "$sub" in
      worktree)
        echo "allow"; return 0
        ;;
      checkout|switch)
        local target="" sawdoubledash=0
        for ((j = i + 2; j < n; j++)); do
          local t="${toks[j]}"
          if [[ "$t" == "--" ]]; then sawdoubledash=1; break; fi
          if [[ "$t" == "-" ]]; then target="-"; break; fi  # `switch -` = previous branch
          [[ "$t" == -* ]] && continue   # skip flags (-b, -c, -q, --track, …)
          target="$t"; break
        done
        if (( sawdoubledash )); then echo "allow"; return 0; fi   # file restore
        if [[ -z "$target" ]]; then echo "allow"; return 0; fi    # bare checkout
        if [[ "$target" == "$_lock" ]]; then echo "allow"; return 0; fi # back to lock
        echo "block"; return 0
        ;;
    esac
  done

  echo "allow"; return 0
}
