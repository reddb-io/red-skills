#!/usr/bin/env bash
# Validate Claude Code and Codex marketplace manifests against the plugin tree.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  cat <<'EOF'
usage: scripts/validate-marketplace-manifests.sh [--root PATH]

Validates:
  - Claude and Codex marketplace JSON is well-formed.
  - Both marketplaces list the same plugin names.
  - Every marketplace entry resolves to an existing plugin directory.
  - Every listed plugin has well-formed Claude and Codex plugin manifests.
  - Required plugin manifest fields are present.
  - Every skills/<bucket>/<skill>/ directory contains SKILL.md.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --root)
      [ "$#" -ge 2 ] || fail "--root requires a path"
      ROOT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

ROOT="$(cd "$ROOT" && pwd)"
cd "$ROOT"

command -v jq >/dev/null || fail "jq is required"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

CLAUDE_MARKETPLACE=".claude-plugin/marketplace.json"
CODEX_MARKETPLACE=".agents/plugins/marketplace.json"
GEMINI_MARKETPLACE=".gemini-plugin/marketplace.json"

validate_json_object() {
  local label="$1"
  local file="$2"

  [ -f "$file" ] || fail "$label not found: $file"
  jq -e 'type == "object"' "$file" >/dev/null 2>&1 \
    || fail "malformed $label: $file"
}

marketplace_names() {
  local file="$1"
  jq -r '
    if (.plugins | type) != "array" then
      error("plugins must be an array")
    else
      .plugins[] | .name
    end
  ' "$file"
}

validate_json_object "Claude marketplace manifest" "$CLAUDE_MARKETPLACE"
validate_json_object "Codex marketplace manifest" "$CODEX_MARKETPLACE"
validate_json_object "Gemini marketplace manifest" "$GEMINI_MARKETPLACE"

marketplace_names "$CLAUDE_MARKETPLACE" | sort -u > "$tmp/claude-names" \
  || fail "malformed Claude marketplace manifest: $CLAUDE_MARKETPLACE"
marketplace_names "$CODEX_MARKETPLACE" | sort -u > "$tmp/codex-names" \
  || fail "malformed Codex marketplace manifest: $CODEX_MARKETPLACE"
marketplace_names "$GEMINI_MARKETPLACE" | sort -u > "$tmp/gemini-names" \
  || fail "malformed Gemini marketplace manifest: $GEMINI_MARKETPLACE"

if ! diff -u "$tmp/claude-names" "$tmp/codex-names" > "$tmp/name-diff"; then
  sed 's/^/  /' "$tmp/name-diff" >&2
  fail "marketplace plugin set mismatch between Claude and Codex manifests"
fi

if ! diff -u "$tmp/claude-names" "$tmp/gemini-names" > "$tmp/name-diff-gemini"; then
  sed 's/^/  /' "$tmp/name-diff-gemini" >&2
  fail "marketplace plugin set mismatch between Claude and Gemini manifests"
fi

validate_plugin_manifest() {
  local plugin="$1"
  local host="$2"
  local file="$3"

  [ -f "$file" ] || fail "$plugin: $host plugin manifest not found: $file"
  jq -e 'type == "object"' "$file" >/dev/null 2>&1 \
    || fail "$plugin: malformed plugin manifest: $file"

  local field
  for field in name version description skills; do
    jq -e --arg field "$field" '
      has($field)
      and (
        if $field == "skills" then
          ((.[$field] | type) == "string" and (.[$field] | length) > 0)
          or ((.[$field] | type) == "array"
              and (.[$field] | length) > 0
              and ([.[$field][] | type == "string" and length > 0] | all))
        else
          (.[$field] | type) == "string" and (.[$field] | length) > 0
        end
      )
    ' "$file" >/dev/null \
      || fail "$plugin: $host plugin manifest missing required field '$field': $file"
  done

  jq -e --arg plugin "$plugin" '.name == $plugin' "$file" >/dev/null \
    || fail "$plugin: $host plugin manifest name must match marketplace entry: $file"
}

validate_skill_dirs() {
  local plugin="$1"
  local dir="$2"
  local skills_dir="$dir/skills"

  [ -d "$skills_dir" ] || fail "$plugin: skills directory not found: $skills_dir"

  while IFS= read -r -d '' skill_dir; do
    [ -f "$skill_dir/SKILL.md" ] \
      || fail "$plugin: skill directory missing SKILL.md: $skill_dir"
  done < <(find "$skills_dir" -mindepth 2 -maxdepth 2 -type d \
    -not -path '*/_*' \
    -print0 | sort -z)
}

validate_marketplace_entry_paths() {
  local host="$1"
  local marketplace="$2"
  local extractor="$3"

  while IFS=$'\t' read -r plugin path; do
    [ -n "$plugin" ] || fail "$host marketplace contains a plugin entry without a name"
    [ -n "$path" ] || fail "$plugin: $host marketplace entry is missing a source path"
    [ -d "$path" ] || fail "$plugin: plugin directory not found from $host marketplace: $path"
  done < <(jq -r "$extractor" "$marketplace")
}

validate_marketplace_entry_paths \
  "Claude" \
  "$CLAUDE_MARKETPLACE" \
  '.plugins[] | [.name, .source] | @tsv'
validate_marketplace_entry_paths \
  "Codex" \
  "$CODEX_MARKETPLACE" \
  '.plugins[] | [.name, .source.path] | @tsv'
validate_marketplace_entry_paths \
  "Gemini" \
  "$GEMINI_MARKETPLACE" \
  '.plugins[] | [.name, .source.path] | @tsv'

while IFS= read -r plugin; do
  [ -n "$plugin" ] || continue
  claude_path="$(jq -r --arg plugin "$plugin" '.plugins[] | select(.name == $plugin) | .source' "$CLAUDE_MARKETPLACE")"
  codex_path="$(jq -r --arg plugin "$plugin" '.plugins[] | select(.name == $plugin) | .source.path' "$CODEX_MARKETPLACE")"
  gemini_path="$(jq -r --arg plugin "$plugin" '.plugins[] | select(.name == $plugin) | .source.path' "$GEMINI_MARKETPLACE")"

  [ "$claude_path" = "$codex_path" ] \
    || fail "$plugin: marketplace source path mismatch: Claude=$claude_path Codex=$codex_path"

  [ "$claude_path" = "$gemini_path" ] \
    || fail "$plugin: marketplace source path mismatch: Claude=$claude_path Gemini=$gemini_path"

  validate_plugin_manifest "$plugin" "Claude" "$claude_path/.claude-plugin/plugin.json"
  validate_plugin_manifest "$plugin" "Codex" "$codex_path/.codex-plugin/plugin.json"
  validate_plugin_manifest "$plugin" "Gemini" "$gemini_path/.gemini-plugin/plugin.json"
  validate_skill_dirs "$plugin" "$claude_path"
done < "$tmp/claude-names"

printf 'marketplace manifests ok\n'
