#!/usr/bin/env bash
# lib/envelope.sh — the Envelope Module: owns the structured-comment schema end
# to end, following the pure / explicit-args contract of lib/state.sh and
# lib/merge.sh.
#
# Reads no orchestrator globals. Every input is a parameter, including the
# poster — the `gh issue comment` call is injected as a callback, not hard-wired
# — so the Module never touches the network itself and stays unit-testable by
# sourcing it directly. It never writes `envelope.posted`; the orchestrator
# (the sole caller holding iteration state) owns that signal after a successful
# post.
#
# The `<details data-attempt-status="…">` wire schema is defined exactly once,
# in envelope_build_body. Both the worker failure family and the supervisor's
# discard Envelope compose through it.
#
# Public surface:
#   envelope_fmt_duration <seconds>
#     Render N seconds as `<m>m<s>s`.
#
#   envelope_build_summary <worker_id> <status> <duration_s> <diff_or_merged> \
#                          <attempt> [merge_sha]
#     The deterministic summary line for worker Envelopes. Centralised so every
#     callsite renders the same shape.
#
#   envelope_build_body <status> <summary> [<section_name> <section_file>]...
#     The single schema definition. Writes the full Envelope body to stdout:
#     a `<details data-attempt-status="…">` wrapper around `<details
#     data-section="…">` blocks. Section bodies come from files so multi-KB log
#     tails are not shell-escaped through arguments. `log` sections are wrapped
#     in a fenced code block; everything else is rendered raw.
#
#   envelope_build_diff_section <repo> <remote_branch> <worktree_rel> <diffstat>
#     Body of the `data-section="diff"` block. When the attempt branch was
#     pushed (<remote_branch> non-empty) the content is a compare-link to the
#     pushed ref; otherwise it embeds the local worktree path so a human can
#     still find the work. The diffstat line is always appended.
#
#   envelope_extract_notes <handoff>
#     Extract the body inside `<agent-notes>…</agent-notes>`, dropping the
#     placeholder comment and trimming blank edges. Empty string when nothing
#     was appended.
#
#   envelope_push_attempt <repo_dir> <branch> <remote_name>
#     Push <branch> to refs/heads/<remote_name> on origin. Echoes <remote_name>
#     and returns 0 on success; emits nothing and returns non-zero on failure.
#     The only network side effect in the Module; stubbable in tests.
#
#   envelope_emit_attempt poster=FN status=S issue=N summary=STR [k=v]...
#     The failure family (blocked, no-sentinel, merge-conflict) and the
#     supervisor's discarded Envelope. Builds the per-status sections, on the
#     failure path pushes the afk-attempts branch before composing the diff
#     section, then posts via the injected poster. Returns the poster's exit
#     status. Does NOT write envelope.posted.
#
#     Accepted key=value args (order-independent):
#       poster        function name; invoked as `poster <issue> <body>`
#       status        blocked | no-sentinel | merge-conflict | discarded
#       issue         issue number passed to the poster
#       summary       the pre-built summary line
#       repo          owner/name, for the diff compare-link (failure family)
#       repo_dir      git repo dir to push from (failure family)
#       branch        local worker branch to push (failure family)
#       remote_name   afk-attempts/{worker}/{issue}-{slug} target ref
#       worktree_rel  worktree path for the push-failed fallback line
#       diffstat      `+N -M files=K` for the diff section body
#       notes_file    path to the notes section body (blocked, no-sentinel)
#       log_file      path to the log section body (no-sentinel, merge-conflict)
#       section_file  path to the discard summary section body (discarded)
#
#   envelope_emit_done poster=FN issue=N summary=STR
#     The section-less success Envelope. No afk-attempts push. Returns the
#     poster's exit status. Does NOT write envelope.posted.

envelope_fmt_duration() {
  local s="${1:-0}"
  printf '%dm%ds' $((s/60)) $((s%60))
}

# envelope_build_summary <worker_id> <status> <duration_s> <diff_or_merged> <attempt> [merge_sha]
envelope_build_summary() {
  local worker_id="$1" status="$2" dur="$3" diff_or_merged="$4" attempt="$5" merge_sha="${6:-}"
  local merge_part=""
  [[ -n "$merge_sha" ]] && merge_part=" · merge: \`$merge_sha\`"
  printf 'worker `%s` · status: %s · duration: %s · diff: %s · attempt: %d%s' \
    "$worker_id" "$status" "$(envelope_fmt_duration "$dur")" "$diff_or_merged" "$attempt" "$merge_part"
}

# envelope_build_body <status> <summary> [<section_name> <section_file>]...
envelope_build_body() {
  local status="$1" summary="$2"
  shift 2
  printf '<details data-attempt-status="%s"><summary>%s</summary>\n\n' "$status" "$summary"
  while [[ $# -ge 2 ]]; do
    local section="$1" body_file="$2"
    shift 2
    printf '<details data-section="%s"><summary>%s</summary>\n\n' "$section" "$section"
    if [[ "$section" == "log" ]]; then
      printf '```\n'
      cat "$body_file"
      printf '\n```\n\n'
    else
      cat "$body_file"
      printf '\n\n'
    fi
    printf '</details>\n\n'
  done
  printf '</details>\n'
}

# envelope_build_diff_section <repo> <remote_branch> <worktree_rel> <diffstat>
envelope_build_diff_section() {
  local repo="$1" remote_branch="$2" worktree_rel="$3" stat="$4"
  if [[ -n "$remote_branch" ]]; then
    local url="https://github.com/${repo}/compare/main...${remote_branch}"
    printf '<a href="%s">compare/main...%s</a>\n\n%s\n' "$url" "$remote_branch" "$stat"
  else
    printf 'push to `afk-attempts/` failed — local worktree: `%s`\n\n%s\n' "$worktree_rel" "$stat"
  fi
}

# envelope_extract_notes <handoff>
envelope_extract_notes() {
  local handoff="$1"
  [[ -f "$handoff" ]] || { echo ""; return; }
  awk '
    /^<agent-notes>[[:space:]]*$/ { flag=1; next }
    /^<\/agent-notes>[[:space:]]*$/ { flag=0; next }
    flag { print }
  ' "$handoff" \
    | grep -v '^<!-- inner agent appends progress/blockers here across attempts -->$' \
    | sed -e '/./,$!d' -e ':a' -e '/^\n*$/{$d;N;ba' -e '}'
}

# envelope_push_attempt <repo_dir> <branch> <remote_name>
envelope_push_attempt() {
  local repo_dir="$1" branch="$2" remote_name="$3"
  if git -C "$repo_dir" push origin "${branch}:refs/heads/${remote_name}" >/dev/null 2>&1; then
    printf '%s' "$remote_name"
    return 0
  fi
  return 1
}

# envelope_emit_attempt poster=FN status=S issue=N summary=STR [k=v]...
# k=v args are order-independent; values may contain `=` (the summary line
# does), so each is split on the first `=` only.
envelope_emit_attempt() {
  local poster="" status="" issue="" summary=""
  local repo="" repo_dir="" branch="" remote_name="" worktree_rel="" diffstat=""
  local notes_file="" log_file="" section_file=""
  local arg key val
  for arg in "$@"; do
    key="${arg%%=*}"
    val="${arg#*=}"
    case "$key" in
      poster)       poster="$val" ;;
      status)       status="$val" ;;
      issue)        issue="$val" ;;
      summary)      summary="$val" ;;
      repo)         repo="$val" ;;
      repo_dir)     repo_dir="$val" ;;
      branch)       branch="$val" ;;
      remote_name)  remote_name="$val" ;;
      worktree_rel) worktree_rel="$val" ;;
      diffstat)     diffstat="$val" ;;
      notes_file)   notes_file="$val" ;;
      log_file)     log_file="$val" ;;
      section_file) section_file="$val" ;;
      *) printf '[envelope] envelope_emit_attempt: unknown arg %q\n' "$arg" >&2 ;;
    esac
  done

  local -a sections=()
  local diff_tmp=""
  if [[ "$status" == "discarded" ]]; then
    # Supervisor adapter: a single pre-built summary section, no push.
    sections=( summary "$section_file" )
  else
    # Worker failure family: push the attempt branch, then synthesize the diff
    # section from the push result. A failed push degrades to the fallback body.
    local pushed=""
    if [[ -n "$repo_dir" && -n "$branch" && -n "$remote_name" ]]; then
      pushed="$(envelope_push_attempt "$repo_dir" "$branch" "$remote_name" || true)"
    fi
    diff_tmp="$(mktemp)"
    envelope_build_diff_section "$repo" "$pushed" "$worktree_rel" "$diffstat" > "$diff_tmp"
    case "$status" in
      blocked)        sections=( notes "$notes_file" diff "$diff_tmp" ) ;;
      no-sentinel)    sections=( notes "$notes_file" diff "$diff_tmp" log "$log_file" ) ;;
      merge-conflict) sections=( diff "$diff_tmp" log "$log_file" ) ;;
      *) printf '[envelope] envelope_emit_attempt: unknown status %q\n' "$status" >&2 ;;
    esac
  fi

  local body; body="$(envelope_build_body "$status" "$summary" "${sections[@]}")"
  ENVELOPE_LAST_BODY="$body"
  [[ -n "$diff_tmp" ]] && rm -f "$diff_tmp"

  "$poster" "$issue" "$body"
}

# envelope_emit_done poster=FN issue=N summary=STR [validation_file=PATH]
envelope_emit_done() {
  local poster="" issue="" summary="" validation_file=""
  local arg key val
  for arg in "$@"; do
    key="${arg%%=*}"
    val="${arg#*=}"
    case "$key" in
      poster)          poster="$val" ;;
      issue)           issue="$val" ;;
      summary)         summary="$val" ;;
      validation_file) validation_file="$val" ;;
      *) printf '[envelope] envelope_emit_done: unknown arg %q\n' "$arg" >&2 ;;
    esac
  done
  local -a sections=()
  [[ -n "$validation_file" ]] && sections=( validation "$validation_file" )
  local body; body="$(envelope_build_body "done" "$summary" "${sections[@]}")"
  ENVELOPE_LAST_BODY="$body"
  "$poster" "$issue" "$body"
}
