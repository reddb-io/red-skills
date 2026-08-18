#!/usr/bin/env bash
# Regression test for npm materialisation in the installed `current` tree.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

packages="$tmp/packages"
core="$packages/red-skills"
mkdir -p \
  "$core/.claude-plugin" \
  "$core/.agents/plugins" \
  "$core/scripts" \
  "$core/dist"
printf '{"name":"@reddb-io/red-skills","version":"9.9.9"}\n' >"$core/package.json"
printf '{}\n' >"$core/.claude-plugin/marketplace.json"
printf '{}\n' >"$core/.agents/plugins/marketplace.json"
printf 'opencode bundle\n' >"$core/dist/opencode-host.bundle.min.mjs"

cat >"$core/scripts/install-opencode.sh" <<'INSTALL_OPENCODE'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test -f "$root/dist/opencode-host.bundle.min.mjs"
for plugin in dev memory brain internal; do
  test -f "$root/plugins/$plugin/package.json"
  test -f "$root/plugins/$plugin/skills/example/SKILL.md"
done
for plugin in dev memory brain; do
  test -f "$root/dist/$plugin.bundle.min.mjs"
done
test ! -e "$root/dist/internal.bundle.min.mjs"
test ! -e "$root/apps"
test ! -e "$root/packages"
INSTALL_OPENCODE
chmod +x "$core/scripts/install-opencode.sh"

# `internal` is skills-only: its package ships no runtime bundle, and the
# installer must materialise it without demanding one.
for plugin in dev memory brain internal; do
  package="$packages/red-skills-$plugin"
  mkdir -p "$package/skills/example"
  printf '{"name":"@reddb-io/red-skills-%s","version":"9.9.9"}\n' "$plugin" >"$package/package.json"
  printf '# Example\n' >"$package/skills/example/SKILL.md"
  if [ "$plugin" != internal ]; then
    mkdir -p "$package/dist"
    printf '%s bundle\n' "$plugin" >"$package/dist/$plugin.bundle.min.mjs"
  fi
done

# npm installs the local fixture packages into the same node_modules shape as
# registry packages. No network-capable command is available to the installer.
cat >"$tmp/npm" <<'FAKE_NPM'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = "install"
shift
prefix=""
specs=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    --*) shift ;;
    *) specs+=("$1"); shift ;;
  esac
done
test -n "$prefix"
expected=(
  "@reddb-io/red-skills@9.9.9"
  "@reddb-io/red-skills-dev@9.9.9"
  "@reddb-io/red-skills-memory@9.9.9"
  "@reddb-io/red-skills-brain@9.9.9"
  "@reddb-io/red-skills-internal@9.9.9"
)
test "${specs[*]}" = "${expected[*]}"
mkdir -p "$prefix/node_modules/@reddb-io"
for source in "$FIXTURE_PACKAGES"/*; do
  cp -R "$source" "$prefix/node_modules/@reddb-io/$(basename "$source")"
done
printf '%s\n' "${specs[*]}" >>"$NPM_STUB_LOG"
FAKE_NPM
chmod +x "$tmp/npm"

# Reproduce Git Bash rather than Unix symlinks: `ln -s dir current` copies dir.
cat >"$tmp/ln" <<'FAKE_LN'
#!/usr/bin/env bash
set -euo pipefail
test "$1" = "-s"
cp -R "$2" "$3"
FAKE_LN
chmod +x "$tmp/ln"

cat >"$tmp/opencode" <<'FAKE_OPENCODE'
#!/usr/bin/env bash
exit 0
FAKE_OPENCODE
chmod +x "$tmp/opencode"

stdout="$tmp/stdout"
if ! FIXTURE_PACKAGES="$packages" NPM_STUB_LOG="$tmp/npm.log" PATH="$tmp:$PATH" \
  scripts/install.sh \
    --version v9.9.9 \
    --install-root "$tmp/install" \
    --only opencode >"$stdout" 2>&1; then
  printf 'FAIL: installer did not materialise the npm packages into current\n' >&2
  sed 's/^/    /' "$stdout" >&2
  exit 1
fi

version="$tmp/install/versions/v9.9.9"
test -f "$version/.claude-plugin/marketplace.json"
test -f "$version/.agents/plugins/marketplace.json"
test -f "$version/dist/opencode-host.bundle.min.mjs"
for plugin in dev memory brain internal; do
  test -f "$version/plugins/$plugin/skills/example/SKILL.md"
done
for plugin in dev memory brain; do
  test -f "$version/dist/$plugin.bundle.min.mjs"
done
test ! -e "$version/dist/internal.bundle.min.mjs"
test ! -e "$version/apps"
test ! -e "$version/packages"
test -f "$tmp/install/current/plugins/dev/skills/example/SKILL.md"
test "$(wc -l <"$tmp/npm.log")" -eq 1

# node and npm are install-wide preconditions: npm absence refuses before a
# detected host can be wired.
no_npm="$tmp/no-npm"
mkdir -p "$no_npm"
ln -s "$(command -v bash)" "$no_npm/bash"
ln -s "$(command -v node)" "$no_npm/node"
cat >"$no_npm/opencode" <<'FAKE_OPENCODE_MISSING_NPM'
#!/usr/bin/env bash
printf 'wired\n' >>"$HOST_STUB_LOG"
FAKE_OPENCODE_MISSING_NPM
chmod +x "$no_npm/opencode"
: >"$tmp/host.log"
if HOST_STUB_LOG="$tmp/host.log" PATH="$no_npm" \
  scripts/install.sh --version v9.9.9 --install-root "$tmp/missing-npm" --only opencode \
  >"$tmp/missing-npm.out" 2>&1; then
  printf 'FAIL: installer accepted a host without npm\n' >&2
  exit 1
fi
grep -qF 'npm is required' "$tmp/missing-npm.out"
test ! -s "$tmp/host.log"

printf 'ok: installer materialises release npm packages before wiring hosts\n'
