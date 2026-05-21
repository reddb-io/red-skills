#!/usr/bin/env bash
# lib/git-command-classifier.sh — the Git Command Classifier: given the locked
# branch and a shell command string, decides whether the command would lose the
# agent's work while a lock is active and must be blocked. Pure / explicit-args,
# like the sibling lib/ modules. Self-contained: it carries its own small
# command matcher so the branch-lock hook needs no dependency on the
# git-guardrails skill.
#
# It blocks two families of command:
#   1. Branch-leaving `git checkout <branch>` / `git switch <branch>` (the
#      original slice) — unless the target is the lock branch itself.
#   2. The work-loss family (issue #61): commands that throw away the working
#      tree or the stash —
#        - `git stash` / `git stash push` / `git stash save`  (bare stash defaults to push)
#        - `git clean` with any force flag (`-f`, `-fd`, `-xfd`, `--force`)
#        - `git reset --hard`
#        - whole-tree restore: `git checkout .`, `git checkout -- .`, `git restore .`
#
# Everything else is allowed — switching back to the lock branch, targeted
# single-file restore (`git checkout -- <path>`, `git restore <path>`), a bare
# `git checkout`, read-only stash (`list`/`show`), a dry-run clean (`-n`), a
# soft/mixed reset, an unstage (`git restore --staged`), `git worktree add`
# (worktrees are how /afk works and are exempt by scope), and any other command.
#
# Recognition is intentionally conservative: it scans the token stream for a
# `git` token immediately followed by a recognised subcommand, so a compound
# command (`cd x && git reset --hard`) is still classified.
#
# Public surface:
#   classify_git_command <lock_branch> <command>
#     Echoes exactly "block" or "allow" and returns 0.

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
      stash)
        # bare `git stash` defaults to push; push/save discard the working tree.
        local op="${toks[i + 2]:-}"
        if [[ -z "$op" || "$op" == "push" || "$op" == "save" ]]; then
          echo "block"; return 0
        fi
        echo "allow"; return 0   # list / show / pop / apply / drop …
        ;;
      clean)
        # any force flag makes clean destructive; -n/--dry-run is safe.
        for ((j = i + 2; j < n; j++)); do
          local t="${toks[j]}"
          [[ "$t" == "--force" ]] && { echo "block"; return 0; }
          # short flag bundle containing 'f' (-f, -fd, -xfd, …) but not -n.
          if [[ "$t" == -[^-]* && "$t" == *f* ]]; then echo "block"; return 0; fi
        done
        echo "allow"; return 0
        ;;
      reset)
        for ((j = i + 2; j < n; j++)); do
          [[ "${toks[j]}" == "--hard" ]] && { echo "block"; return 0; }
        done
        echo "allow"; return 0
        ;;
      restore)
        # whole-tree restore (`git restore .`) loses work; a targeted path or an
        # unstage (`--staged <path>`) is allowed, mirroring `checkout -- <path>`.
        for ((j = i + 2; j < n; j++)); do
          local t="${toks[j]}"
          [[ "$t" == -* ]] && continue   # skip flags (--staged, --source=…, …)
          if [[ "$t" == "." ]]; then echo "block"; return 0; fi
          break                          # a named path: allowed
        done
        echo "allow"; return 0
        ;;
      checkout|switch)
        local target="" sawdoubledash=0
        for ((j = i + 2; j < n; j++)); do
          local t="${toks[j]}"
          if [[ "$t" == "--" ]]; then sawdoubledash=1; continue; fi
          if [[ "$t" == "-" ]]; then target="-"; break; fi  # `switch -` = previous branch
          [[ "$t" == -* ]] && continue   # skip flags (-b, -c, -q, --track, …)
          target="$t"; break
        done
        # whole-tree restore via checkout (`git checkout .`, `git checkout -- .`).
        if [[ "$target" == "." ]]; then echo "block"; return 0; fi
        if (( sawdoubledash )); then echo "allow"; return 0; fi   # file restore
        if [[ -z "$target" ]]; then echo "allow"; return 0; fi    # bare checkout
        if [[ "$target" == "$_lock" ]]; then echo "allow"; return 0; fi # back to lock
        echo "block"; return 0
        ;;
    esac
  done

  echo "allow"; return 0
}
