#!/usr/bin/env bash
# Greppable audit for the shipped RedSkills hook hardening contract.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail=0
fixture_fail=0
fixture_mode=0

report() {
  local file="$1" line="$2" rule="$3" text="$4"
  if [[ "$fixture_mode" -eq 1 ]]; then
    printf 'FIXTURE %s:%s [%s] %s\n' "$file" "$line" "$rule" "$text"
    fixture_fail=$((fixture_fail + 1))
  else
    printf 'FAIL %s:%s [%s] %s\n' "$file" "$line" "$rule" "$text"
    fail=$((fail + 1))
  fi
}

scan_text_file() {
  local path="$1"
  local rel="${path#$ROOT/}"
  local line_no=0 line trimmed
  while IFS= read -r line || [[ -n "$line" ]]; do
    line_no=$((line_no + 1))
    trimmed="${line#"${line%%[![:space:]]*}"}"
    [[ "$trimmed" == \#* ]] && continue
    [[ "$trimmed" == '//'* ]] && continue
    [[ "$trimmed" == '*'* ]] && continue

    if grep -Eq '(^|[[:space:];|&({])exit[[:space:]]+[1-9][0-9]*($|[[:space:];|&)])' <<<"$line"; then
      report "$rel" "$line_no" "nonzero-exit" "$trimmed"
    fi
    if [[ "$line" =~ process\.exit\([[:space:]]*[1-9] ]]; then
      report "$rel" "$line_no" "nonzero-process-exit" "$trimmed"
    fi
    if [[ "$line" == *"readFileSync(0"* ]]; then
      report "$rel" "$line_no" "sync-stdin" "$trimmed"
    fi
    case "$line" in
      *'$('*cat*|*" cat >"*|"cat "*|"cat")
        if [[ "$line" != *"timeout "* && "$line" != *"cat <<"* ]]; then
          report "$rel" "$line_no" "unbounded-stdin" "$trimmed"
        fi
        ;;
    esac
    if grep -Eq 'sh[[:space:]]+-c[[:space:]]+.*(\$COMMAND|\$raw|tool_input)' <<<"$line"; then
      report "$rel" "$line_no" "raw-shell-interpolation" "$trimmed"
    fi
  done <"$path"
}

scan_manifest() {
  local path="$1"
  local rel="${path#$ROOT/}"
  local commands command
  if ! commands="$(jq -r '.. | objects | .command? // empty' "$path" 2>/dev/null)"; then
    report "$rel" 1 "invalid-json" "manifest is not valid JSON"
    return
  fi
  while IFS= read -r command || [[ -n "$command" ]]; do
    [[ -z "$command" ]] && continue
    if [[ "$command" == *'cat >"$tmp"'* && "$command" != *'timeout "${RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat >"$tmp"'* ]]; then
      report "$rel" "?" "manifest-unbounded-stdin" "$command"
    fi
    if [[ "$command" == *" node "* && "$command" != *'timeout "${RED_SKILLS_HOOK_TIMEOUT_S:-3s}" node '* ]]; then
      report "$rel" "?" "manifest-unbounded-node" "$command"
    fi
    if [[ "$command" == *'RED_SKILLS_HOOK_TIMEOUT_S:-30s'* ]]; then
      report "$rel" "?" "manifest-slow-hook-timeout" "$command"
    fi
    if [[ "$command" == *'branch-lock'* || "$command" == *'command-guard.sh'* ]]; then
      if [[ "$command" == *'<"$tmp"'* && "$command" != *'|| printf "{}"'* ]]; then
        report "$rel" "?" "manifest-hook-crash-not-open" "$command"
      fi
      if [[ "$command" == *'<"$tmp"'* && "$command" != *'timeout "${RED_SKILLS_HOOK_TIMEOUT_S:-3s}"'* ]]; then
        report "$rel" "?" "manifest-hook-unbounded-runtime" "$command"
      fi
    fi
  done <<<"$commands"
}

collect_targets() {
  find "$ROOT/plugins/dev/hooks" "$ROOT/plugins/memory/hooks" "$ROOT/plugins/brain/hooks" -type f \
    ! -path '*/tests/*' \
    ! -name 'red-fetch.mjs' | sort
  find "$ROOT/plugins/dev/skills/engineering/afk/defaults" "$ROOT/plugins/dev/skills/engineering/afk/hooks" -type f | sort
  printf '%s\n' \
    "$ROOT/plugins/dev/skills/misc/branch-lock/scripts/branch-lock-hook.sh" \
    "$ROOT/apps/host-opencode/src/hooks-to-events.ts"
}

fixture="$ROOT/scripts/fixtures/hook-hardening/violating-hook.sh"
fixture_mode=1
scan_text_file "$fixture"
fixture_mode=0
if [[ "$fixture_fail" -eq 0 ]]; then
  report "${fixture#$ROOT/}" 1 "fixture-not-caught" "violating fixture did not trigger the audit"
fi

while IFS= read -r target; do
  case "$target" in
    *.json) scan_manifest "$target" ;;
    *) scan_text_file "$target" ;;
  esac
done < <(collect_targets)

if [[ "$fail" -gt 0 ]]; then
  printf 'hook hardening audit failed: %d finding(s)\n' "$fail" >&2
  exit 1
fi

printf 'hook hardening audit passed\n'
