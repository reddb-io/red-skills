#!/usr/bin/env bash
# lib/pin-reader.sh — read the branch a work item is pinned to.
#
# A PRD or issue body may carry a canonical `branch:` line declaring the branch
# `/afk` should base its worktree on and merge back into. The rule is a small
# inheritance chain:
#
#   1. the issue's own `branch:` line wins;
#   2. else the parent PRD's `branch:` line (the issue inherits it);
#   3. else `main` (today's behaviour — no pin anywhere).
#
# These functions are pure text predicates: no `gh`, no git, no network. The
# orchestrator (afk.sh) handles fetching the parent PRD body over `gh` and
# passes both bodies in, so the inheritance precedence itself stays unit-testable
# against fixed strings (scripts/tests/pin-reader.test.sh).
#
# Public surface:
#   pin_parse_branch <body>
#     Echo the branch from the first canonical `branch:` line in <body>, or
#     nothing. Returns 0 iff a line was found. A canonical line is one whose
#     first non-blank content is exactly `branch:` (lowercase) followed by
#     whitespace and a single branch token; surrounding `backticks` and matched
#     quotes around the token are stripped. Prose like "this branch: foo" does
#     not match (the key must start the line).
#
#   pin_parse_parent_prd <body>
#     Echo the number from the first `PRD #<n>` reference in <body> (the
#     `## Parent` convention written by /to-issues), or nothing. Returns 0 iff
#     a reference was found.
#
#   pin_resolve <issue_body> [<prd_body>]
#     Apply the inheritance chain and always echo a branch: the issue's pin,
#     else the PRD's pin (when <prd_body> is given), else `main`. Always
#     returns 0.

# pin_parse_branch <body>
pin_parse_branch() {
  local body="$1" line value
  while IFS= read -r line; do
    # Allow an optional markdown list marker before the key, but the `branch:`
    # key must still start the (post-marker) line so prose like "this branch: x"
    # never matches.
    if [[ "$line" =~ ^[[:space:]]*([-*][[:space:]]+)?branch:[[:space:]]+([^[:space:]]+) ]]; then
      value="${BASH_REMATCH[2]}"
      # Strip a single layer of wrapping backticks or matched quotes.
      value="${value#\`}"; value="${value%\`}"
      value="${value#\"}"; value="${value%\"}"
      value="${value#\'}"; value="${value%\'}"
      [[ -n "$value" ]] || continue
      printf '%s\n' "$value"
      return 0
    fi
  done <<< "$body"
  return 1
}

# pin_parse_parent_prd <body>
pin_parse_parent_prd() {
  local body="$1" line
  while IFS= read -r line; do
    if [[ "$line" =~ PRD[[:space:]]*#[[:space:]]*([0-9]+) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <<< "$body"
  return 1
}

# pin_resolve <issue_body> [<prd_body>]
pin_resolve() {
  local issue_body="$1" prd_body="${2:-}" b
  if b="$(pin_parse_branch "$issue_body")" && [[ -n "$b" ]]; then
    printf '%s\n' "$b"; return 0
  fi
  if [[ -n "$prd_body" ]] && b="$(pin_parse_branch "$prd_body")" && [[ -n "$b" ]]; then
    printf '%s\n' "$b"; return 0
  fi
  printf 'main\n'
  return 0
}
