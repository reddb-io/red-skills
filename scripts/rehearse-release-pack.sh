#!/usr/bin/env bash
# rehearse-release-pack.sh — prove the package set is installable BEFORE a tag
# depends on it.
#
# red-publish.yml builds every bundle, stages the per-plugin and core npm
# packages, packs them, checks the tarball boundaries, publishes, and only then
# does anyone run scripts/install.sh against what came out. Four latent faults
# rode that gap into v3.19.0..v3.19.2 (a release-engine bundle nothing built, a
# runtime bundle demanded from a skills-only plugin, scripts that lost their
# executable bit in the tarball, and per-plugin packages that were a skills
# excerpt the OpenCode generator could not consume). Each one cost a burnt
# release to discover, because the pull-request checks drive fakes: a fake
# cosign, fixture tarballs, a fake npm.
#
# This script runs the real producer chain and the real consumer, hermetically:
#   1. build every runtime bundle the way the publish job does;
#   2. stage and pack the per-plugin packages and the core package at a
#      rehearsal version;
#   3. run the tarball boundary check the publish runs;
#   4. feed the tarballs to scripts/install.sh through an npm shim and install a
#      fake OpenCode host into a throwaway XDG_CONFIG_HOME and install root;
#   5. assert the host surface the generator wrote is complete.
#
# It leaves the checkout as it found it: packaging/ is regenerated with a
# rehearsal version and restored from git afterwards, so it refuses to start
# on a dirty packaging/ tree rather than lose someone's work.
#
# Usage: scripts/rehearse-release-pack.sh            (from the repo root)
# Env:   REHEARSAL_VERSION (default 0.0.0-rehearsal.0)
#        REHEARSAL_SKIP_BUNDLE=1 to reuse an existing dist/ (local iteration)

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${REHEARSAL_VERSION:-0.0.0-rehearsal.0}"
work="$(mktemp -d)"
step() { printf '\nrehearsal: == %s\n' "$*"; }
fail() { printf 'rehearsal: FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'rehearsal: PASS: %s\n' "$*"; }

if [ -n "$(git status --porcelain -- packaging)" ]; then
  fail "packaging/ has uncommitted changes; the rehearsal regenerates and restores it from git — commit or stash first"
fi
cleanup() {
  git checkout -q -- packaging 2>/dev/null || true
  git clean -fdq -- packaging 2>/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

export RED_BUILD_VERSION="v$VERSION"
RED_BUILD_GIT_SHA="$(git rev-parse HEAD)"
RED_BUILD_TIME="$(git log -1 --format=%cI HEAD)"
export RED_BUILD_GIT_SHA RED_BUILD_TIME

# 1. Bundles — the same producers red-publish.yml runs, through the workspace
# task graph plus the dev MCP server that has its own script.
if [ "${REHEARSAL_SKIP_BUNDLE:-}" != "1" ]; then
  step "building runtime bundles"
  pnpm bundle >"$work/bundle.log" 2>&1 || { cat "$work/bundle.log"; fail "pnpm bundle failed"; }
  (cd apps/dev && pnpm bundle:mcp >"$work/bundle-mcp.log" 2>&1) || { cat "$work/bundle-mcp.log"; fail "apps/dev bundle:mcp failed"; }
fi
for bundle in dev memory brain opencode-host redskilled-mcp code-nav-mcp rsp rsp-core redskilled release; do
  [ -f "dist/$bundle.bundle.min.mjs" ] || fail "dist/$bundle.bundle.min.mjs was not built"
done
[ -f dist/memory-tokenizer.asset.cjs ] || fail "dist/memory-tokenizer.asset.cjs was not built"
pass "runtime bundles built"

# 2. Per-plugin packages, packed the way the publish packs them.
step "staging and packing per-plugin packages at $VERSION"
plugin_pack_dir="$work/plugins"
core_pack_dir="$work/core"
mkdir -p "$plugin_pack_dir" "$core_pack_dir"
pnpm pi:packages:build >"$work/pi-build.log" 2>&1 || { cat "$work/pi-build.log"; fail "pi:packages:build failed"; }
while IFS= read -r plugin_json; do
  plugin="$(node -p "require('./${plugin_json}').name")"
  pnpm --dir "packaging/pi/$plugin" pack --pack-destination "$plugin_pack_dir" >/dev/null
done < <(find plugins -mindepth 3 -maxdepth 3 -path '*/.claude-plugin/plugin.json' -print | sort)
pass "packed $(ls "$plugin_pack_dir" | wc -l) per-plugin tarballs"

# 3. Core package: version pinned like the publish pins it to the tag, staged by
# prepare.mjs, packed, and both sides checked by the boundary checker.
step "staging and packing the core package"
node -e "const fs=require('fs');const p='packaging/npm/package.json';const j=JSON.parse(fs.readFileSync(p));j.version=process.env.RED_BUILD_VERSION.replace(/^v/,'');fs.writeFileSync(p,JSON.stringify(j,null,2)+'\n');"
node packaging/npm/scripts/prepare.mjs >"$work/prepare.log" 2>&1 || { cat "$work/prepare.log"; fail "prepare.mjs failed"; }
if grep -q "not built" "$work/prepare.log"; then
  cat "$work/prepare.log"
  fail "prepare.mjs skipped a bundle nothing built"
fi
(cd packaging/npm && pnpm pack --pack-destination "$core_pack_dir" >/dev/null)
core_tarball="$(ls "$core_pack_dir"/reddb-io-red-skills-*.tgz | head -n1)"
node scripts/check-npm-tarball-boundaries.mjs --root "$ROOT" --core "$core_tarball" --plugins "$plugin_pack_dir"
pass "tarball boundaries hold for core and every plugin"

# 4. The consumer: scripts/install.sh, exactly as a workstation runs it, with
# npm answering from the tarballs just packed and a fake OpenCode on PATH so
# the OpenCode host wiring runs for real into a throwaway config home.
step "installing the packed set through scripts/install.sh (fake OpenCode host)"
shim="$work/bin"
mkdir -p "$shim"
real_npm="$(command -v npm)"
cat >"$shim/npm" <<SHIM
#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "install" ]; then
  args=()
  for a in "\$@"; do
    case "\$a" in
      @reddb-io/red-skills@*) args+=("$core_tarball");;
      @reddb-io/red-skills-*@*) n="\${a#@reddb-io/red-skills-}"; n="\${n%@*}"; args+=("$plugin_pack_dir/reddb-io-red-skills-\$n-$VERSION.tgz");;
      *) args+=("\$a");;
    esac
  done
  exec "$real_npm" "\${args[@]}"
fi
exec "$real_npm" "\$@"
SHIM
printf '#!/usr/bin/env bash\nexit 0\n' >"$shim/opencode"
chmod +x "$shim/npm" "$shim/opencode"

install_root="$work/install-root"
xdg="$work/xdg"
mkdir -p "$xdg"
if ! XDG_CONFIG_HOME="$xdg" PATH="$shim:$PATH" \
  bash scripts/install.sh --version "v$VERSION" --install-root "$install_root" --only opencode >"$work/install.log" 2>&1; then
  cat "$work/install.log"
  fail "scripts/install.sh could not install the packed set"
fi
pass "install.sh materialised the set and wired the OpenCode host"

# 5. The surface the generator wrote must be complete: skills from every
# plugin, hook modules, an MCP block that points at the materialised tree.
step "asserting the installed OpenCode surface"
host="$xdg/opencode"
current="$install_root/current"
[ -f "$current/plugins/dev/.claude-plugin/plugin.json" ] || fail "materialised dev plugin has no manifest"
[ -f "$current/plugins/memory/scripts/bootstrap.mjs" ] || fail "materialised memory plugin has no scripts/bootstrap.mjs"
[ -f "$current/dist/dev.bundle.min.mjs" ] || fail "materialised tree has no dev runtime bundle"
[ ! -e "$current/dist/internal.bundle.min.mjs" ] || fail "skills-only internal plugin must not materialise a bundle"
for skill in afk store capture bootstrap; do
  [ -f "$host/skills/$skill/SKILL.md" ] || fail "OpenCode host is missing skill $skill"
done
ls "$host/plugins"/redskills-dev-*.ts >/dev/null 2>&1 || fail "OpenCode host has no dev hook modules"
# A fresh host gets opencode.json; an existing opencode.jsonc is kept as the name.
host_cfg="$host/opencode.json"
[ -f "$host/opencode.jsonc" ] && host_cfg="$host/opencode.jsonc"
[ -f "$host_cfg" ] || { ls -la "$host" >&2; fail "OpenCode host has no opencode.json(c)"; }
grep -qF '"mcp"' "$host_cfg" || fail "$host_cfg carries no MCP block"
grep -qF "$current/plugins/memory/scripts/bootstrap.mjs" "$host_cfg" || fail "$host_cfg does not point red-memory at the materialised tree"
skills_installed="$(grep -c 'installed skill' "$work/install.log" || true)"
pass "OpenCode host carries $skills_installed skills, hook modules, and an MCP block over $current"

printf '\nrehearsal: OK — the package set at %s is installable\n' "$VERSION"
