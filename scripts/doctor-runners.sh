#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO"

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

need_command() {
  command -v "$1" >/dev/null || fail "$1 is not on PATH"
}

need_text() {
  local haystack="$1" needle="$2" label="$3"
  grep -Fq -- "$needle" <<<"$haystack" || fail "$label missing expected text: $needle"
}

need_command bash
need_command jq
need_command git
need_command claude
need_command codex

tmp_root="$(mktemp -d)"
trap 'rm -rf "$tmp_root"' EXIT

"$REPO/scripts/validate-install-metadata.sh"

bash -n \
  scripts/link-skills.sh \
  scripts/list-skills.sh \
  scripts/validate-install-metadata.sh \
  scripts/doctor-runners.sh \
  plugins/dev/skills/engineering/afk/scripts/afk.sh \
  plugins/dev/skills/engineering/afk/scripts/once.sh \
  plugins/dev/skills/engineering/afk/scripts/monitor.sh

claude_help="$(claude --help 2>&1 || true)"
need_text "$claude_help" "--print" "claude --help"
need_text "$claude_help" "--output-format" "claude --help"
need_text "$claude_help" "stream-json" "claude --help"
need_text "$claude_help" "--permission-mode" "claude --help"
need_text "$claude_help" "bypassPermissions" "claude --help"
need_text "$claude_help" "--effort" "claude --help"

codex_help="$(codex exec --help 2>&1 || true)"
need_text "$codex_help" "--json" "codex exec --help"
need_text "$codex_help" "--cd" "codex exec --help"
need_text "$codex_help" "--sandbox" "codex exec --help"
need_text "$codex_help" "--dangerously-bypass-approvals-and-sandbox" "codex exec --help"
need_text "$codex_help" "--output-last-message" "codex exec --help"

tmp_home="$tmp_root/codex-home"
mkdir -p "$tmp_home"
HOME="$tmp_home" codex plugin marketplace add "$REPO" >/dev/null 2>&1 \
  || fail "codex could not add this repo as a marketplace"
grep -Fq '[marketplaces.red-skills]' "$tmp_home/.codex/config.toml" \
  || fail "codex marketplace add did not register red-skills"

tmp_home="$tmp_root/link-home"
mkdir -p "$tmp_home"
HOME="$tmp_home" "$REPO/scripts/link-skills.sh" >/dev/null
for base in "$tmp_home/.claude/skills" "$tmp_home/.agents/skills" "$tmp_home/.codex/skills"; do
  [[ -L "$base/afk" ]] || fail "link-skills did not create $base/afk"
  [[ -f "$base/afk/SKILL.md" ]] || fail "$base/afk/SKILL.md is missing"
done

echo "runner doctor ok"
