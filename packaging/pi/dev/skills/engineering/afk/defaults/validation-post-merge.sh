#!/usr/bin/env bash
# validation-post-merge.sh — built-in post_merge default (PRD #207, issue #213).
#
# Runs CI/smoke validation against the merged primary checkout so user
# post_merge hooks see the validation status already reconciled into the
# context. Migrated from the inline `feedback`-style call: the pre-merge
# `feedback()` in afk.sh stays as the mechanism-owned safety gate (ADR 0008
# — anything that must abort the merge loudly is mechanism, not a hook), and
# this default exposes a post-merge re-run hook authors can disable, observe,
# or replace.
#
# Contract:
#   stdin   — JSON object: post_merge context (issue, workspace, merge_commit).
#   stdout  — JSON object: the same context with
#             `.result = {validation_status: "passed"|"failed"|"skipped",
#                          validation_summary: <one-line string>}` merged into
#             it. Non-JSON stdin → pass-through with no validation attempt.
#   exit    — 0. Post_merge policy is `continue`; even a failing validation
#             only logs (it cannot roll back the merge — that ship has sailed
#             at this lifecycle point).
#
# Env contract (set by afk.sh before dispatch):
#   RED_AFK_WORKSPACE   — primary checkout (post-merge tip). When unset or
#                          not a directory, the default is a no-op.
#   RED_AFK_MERGE_COMMIT — full sha of the merge commit on `target`. Not
#                          consumed by this default but documented so user
#                          hooks reading env directly see a consistent view.
#
# Disable with `afk.hooks.defaults.validation: false` in `.red/config.yaml`.

set -uo pipefail

ctx="$(timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat 2>/dev/null || true)"
ws="${RED_AFK_WORKSPACE:-}"

emit_ctx() {
  local status="$1" summary="$2"
  if [[ -z "$ctx" ]]; then
    return 0
  fi
  printf '%s' "$ctx" \
    | jq --arg s "$status" --arg sum "$summary" \
        '.result = ((.result // {}) + {validation_status: $s, validation_summary: $sum})' \
        2>/dev/null \
    || printf '%s' "$ctx"
}

if [[ -z "$ws" || ! -d "$ws" ]]; then
  emit_ctx "skipped" "no workspace"
  exit 0
fi

if ! [[ -f "$ws/package.json" ]]; then
  emit_ctx "skipped" "no package.json"
  exit 0
fi

# Run pnpm test/typecheck/lint/build at the workspace root if the script
# exists. This mirrors the mechanism-owned `feedback()` step shape but
# operates on the merged tip rather than the worker's worktree.
overall="passed"
parts=""
for script in test typecheck lint build; do
  if jq -e --arg s "$script" '.scripts[$s] // empty' "$ws/package.json" >/dev/null 2>&1; then
    if ( cd "$ws" && pnpm -s "$script" >/dev/null 2>&1 ); then
      parts+="${script}:✓ "
    else
      parts+="${script}:✗ "
      overall="failed"
    fi
  else
    parts+="${script}:skip "
  fi
done

emit_ctx "$overall" "${parts% }"
exit 0
