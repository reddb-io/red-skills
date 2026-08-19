#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
usage: create-plugin.sh [--root REPO_ROOT] <plugin-name>

Scaffolds a RedSkills plugin and appends it to both marketplace manifests.
EOF
}

fail() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"

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
    --*)
      fail "unknown option: $1"
      ;;
    *)
      break
      ;;
  esac
done

[ "$#" -eq 1 ] || {
  usage >&2
  exit 2
}

command -v jq >/dev/null || fail "jq is required"

PLUGIN="$1"
PLUGIN="$(printf '%s' "$PLUGIN" \
  | tr '[:upper:]' '[:lower:]' \
  | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//; s/-+/-/g')"

[ -n "$PLUGIN" ] || fail "plugin name normalizes to empty"
[ "${#PLUGIN}" -le 64 ] || fail "plugin name must be 64 characters or fewer after normalization"

ROOT="$(cd "$ROOT" && pwd)"
PLUGIN_DIR="$ROOT/plugins/$PLUGIN"
SKILL_NAME="${PLUGIN}-demo"
SKILL_DIR="$PLUGIN_DIR/skills/core/$SKILL_NAME"

[ ! -e "$PLUGIN_DIR" ] || fail "plugin already exists: plugins/$PLUGIN"
[ -f "$ROOT/.claude-plugin/marketplace.json" ] || fail "missing .claude-plugin/marketplace.json"
[ -f "$ROOT/.agents/plugins/marketplace.json" ] || fail "missing .agents/plugins/marketplace.json"
[ -f "$ROOT/.gemini-plugin/marketplace.json" ] || fail "missing .gemini-plugin/marketplace.json"

mkdir -p \
  "$PLUGIN_DIR/.claude-plugin" \
  "$PLUGIN_DIR/.codex-plugin" \
  "$PLUGIN_DIR/.gemini-plugin" \
  "$SKILL_DIR" \
  "$PLUGIN_DIR/scripts"

cat > "$PLUGIN_DIR/.claude-plugin/plugin.json" <<EOF
{
  "name": "$PLUGIN",
  "version": "0.1.0",
  "description": "reddb.io $PLUGIN plugin - repository-local RedSkills extension.",
  "skills": [
    "./skills/core/$SKILL_NAME"
  ]
}
EOF

cat > "$PLUGIN_DIR/.codex-plugin/plugin.json" <<EOF
{
  "name": "$PLUGIN",
  "version": "0.1.0",
  "description": "reddb.io $PLUGIN plugin - repository-local RedSkills extension.",
  "author": {
    "name": "reddb.io",
    "url": "https://github.com/reddb-io"
  },
  "homepage": "https://github.com/reddb-io/red-skills",
  "repository": "https://github.com/reddb-io/red-skills",
  "license": "Apache-2.0",
  "keywords": [
    "codex",
    "claude-code",
    "skills",
    "agents"
  ],
  "skills": "./skills/",
  "interface": {
    "displayName": "$PLUGIN",
    "shortDescription": "Repository-local RedSkills extension.",
    "longDescription": "The $PLUGIN plugin is a repository-local RedSkills extension scaffolded with born-compliant marketplace metadata, skill structure, documentation, changelog, and structural smoke checks.",
    "developerName": "reddb.io",
    "category": "Developer Tools",
    "capabilities": [
      "Interactive",
      "Read",
      "Shell"
    ],
    "websiteURL": "https://github.com/reddb-io/red-skills",
    "defaultPrompt": [
      "Run \$$SKILL_NAME to verify the $PLUGIN plugin is available."
    ],
    "brandColor": "#2563EB"
  }
}
EOF

cat > "$PLUGIN_DIR/.gemini-plugin/plugin.json" <<EOF
{
  "name": "$PLUGIN",
  "version": "0.1.0",
  "description": "reddb.io $PLUGIN plugin - repository-local RedSkills extension.",
  "author": {
    "name": "reddb.io",
    "url": "https://github.com/reddb-io"
  },
  "homepage": "https://github.com/reddb-io/red-skills",
  "repository": "https://github.com/reddb-io/red-skills",
  "license": "Apache-2.0",
  "keywords": [
    "gemini-cli",
    "skills",
    "agents"
  ],
  "skills": [
    "./skills/core/$SKILL_NAME/"
  ],
  "interface": {
    "displayName": "$PLUGIN",
    "shortDescription": "Repository-local RedSkills extension.",
    "longDescription": "The $PLUGIN plugin is a repository-local RedSkills extension scaffolded with born-compliant marketplace metadata, skill structure, documentation, changelog, and structural smoke checks.",
    "developerName": "reddb.io",
    "category": "Developer Tools",
    "capabilities": [
      "Interactive",
      "Read",
      "Shell"
    ],
    "websiteURL": "https://github.com/reddb-io/red-skills",
    "defaultPrompt": [
      "Run \$$SKILL_NAME to verify the $PLUGIN plugin is available."
    ],
    "brandColor": "#2563EB"
  }
}
EOF

cat > "$SKILL_DIR/SKILL.md" <<EOF
---
name: $SKILL_NAME
working-mode: interactive
description: Use when verifying that the scaffolded $PLUGIN plugin is installed, discoverable, and ready for repository-specific implementation.
---

# $SKILL_NAME

**Verify the scaffold before adding domain behavior.** Keep this seed skill
small until the plugin has a real maintainer workflow.

<what-to-do>

Run the plugin smoke script from the RedSkills repository root:

\`\`\`bash
bash plugins/$PLUGIN/scripts/structural-smoke.sh
\`\`\`

Report the printed result.

</what-to-do>

<supporting-info>

This seed exists so new plugins ship with a valid skill tree on day one. Replace
it only after the replacement skill keeps the same frontmatter discipline,
two-section body structure, and marketplace-safe tool grants.

</supporting-info>
EOF

cat > "$PLUGIN_DIR/scripts/structural-smoke.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO"

node scripts/plugin-structural-smoke.mjs "plugins/$(basename "$(cd "$(dirname "$0")/.." && pwd)")"
EOF
chmod +x "$PLUGIN_DIR/scripts/structural-smoke.sh"

cat > "$PLUGIN_DIR/README.md" <<EOF
# $PLUGIN

Repository-local RedSkills plugin scaffolded by the internal create-plugin
maintainer skill.

## Install

Install through the RedSkills marketplace after this plugin has been committed
to the repository and the marketplace manifests have been published.

## Skills

- \`$SKILL_NAME\` - verifies the scaffolded plugin structure before real
  maintainer workflows are added.

## Validation

\`\`\`bash
bash scripts/validate-marketplace-manifests.sh
bash scripts/lint-skill-frontmatter.sh
bash plugins/$PLUGIN/scripts/structural-smoke.sh
\`\`\`

## Maintenance

Change the internal create-plugin scaffolder before changing this plugin
contract. Generated plugins are the contract fixture for future plugin work.
EOF

cat > "$PLUGIN_DIR/CHANGES.md" <<EOF
# CHANGES - $PLUGIN

## $PLUGIN

- **status**: added
- **upstream**: none
- **why**: new repository-local plugin scaffold.
- **what changed**: created born-compliant plugin manifests, seed skill,
  structural smoke script, README, and marketplace entries.
EOF

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

jq --arg name "$PLUGIN" --arg source "./plugins/$PLUGIN" --arg description "reddb.io $PLUGIN plugin - repository-local RedSkills extension." '
  if any(.plugins[]?; .name == $name) then
    error("Claude marketplace already contains plugin " + $name)
  else
    .plugins += [{
      "name": $name,
      "source": $source,
      "description": $description
    }]
  end
' "$ROOT/.claude-plugin/marketplace.json" > "$tmp"
mv "$tmp" "$ROOT/.claude-plugin/marketplace.json"

jq --arg name "$PLUGIN" --arg path "./plugins/$PLUGIN" --arg description "Repository-local RedSkills extension." '
  if any(.plugins[]?; .name == $name) then
    error("Codex marketplace already contains plugin " + $name)
  else
    .plugins += [{
      "name": $name,
      "description": $description,
      "source": {
        "source": "local",
        "path": $path
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "category": "Developer Tools"
    }]
  end
' "$ROOT/.agents/plugins/marketplace.json" > "$tmp"
mv "$tmp" "$ROOT/.agents/plugins/marketplace.json"

jq --arg name "$PLUGIN" --arg path "./plugins/$PLUGIN" --arg description "Repository-local RedSkills extension." '
  if any(.plugins[]?; .name == $name) then
    error("Gemini marketplace already contains plugin " + $name)
  else
    .plugins += [{
      "name": $name,
      "description": $description,
      "source": {
        "source": "local",
        "path": $path
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_USE"
      },
      "category": "Developer Tools"
    }]
  end
' "$ROOT/.gemini-plugin/marketplace.json" > "$tmp"
mv "$tmp" "$ROOT/.gemini-plugin/marketplace.json"

if ! grep -Fq "./plugins/$PLUGIN/README.md" "$ROOT/README.md"; then
  cat >> "$ROOT/README.md" <<EOF

- [\`$PLUGIN\`](./plugins/$PLUGIN/README.md) - Repository-local RedSkills extension.
EOF
fi

cat <<EOF
created plugins/$PLUGIN

validate with:
  bash scripts/validate-marketplace-manifests.sh --root "$ROOT"
  bash scripts/lint-skill-frontmatter.sh --root "$ROOT"
  bash plugins/$PLUGIN/scripts/structural-smoke.sh
EOF
