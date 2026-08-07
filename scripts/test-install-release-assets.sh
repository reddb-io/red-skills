#!/usr/bin/env bash
# Regression test for release assets in the installed `current` tree on Git Bash.
#
# Git Bash emulates `ln -s <directory>` by copying the directory.  Therefore all
# release-only assets must be downloaded before `current` is created.  The RSP
# launcher also needs its separately published bundle beside the source archive.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fixture="$tmp/red-skills-v9.9.9"
mkdir -p \
  "$fixture/.claude-plugin" \
  "$fixture/.agents/plugins" \
  "$fixture/scripts" \
  "$fixture/packaging/npm/bin"
printf '{}\n' >"$fixture/.claude-plugin/marketplace.json"
printf '{}\n' >"$fixture/.agents/plugins/marketplace.json"

cat >"$fixture/scripts/install-opencode.sh" <<'INSTALL_OPENCODE'
#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
test -f "$root/dist/opencode-host.bundle.min.mjs"
test -f "$root/packaging/npm/dist/rsp.bundle.min.mjs"
INSTALL_OPENCODE
chmod +x "$fixture/scripts/install-opencode.sh"
printf '%s\n' '#!/usr/bin/env node' >"$fixture/packaging/npm/bin/rsp.mjs"

fixture_archive="$tmp/v9.9.9.tar.gz"
tar -czf "$fixture_archive" -C "$tmp" "$(basename "$fixture")"

# curl serves the source archive and the two independently published bundles.
# The generated OpenCode archive is optional and intentionally unavailable.
cat >"$tmp/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -euo pipefail
url=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    http*) url="$1"; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */archive/refs/tags/v9.9.9.tar.gz) cp "$FIXTURE_ARCHIVE" "$out" ;;
  */opencode-host.bundle.min.mjs) printf 'opencode bundle\n' >"$out" ;;
  */rsp.bundle.min.mjs) printf 'rsp bundle\n' >"$out" ;;
  */opencode-host.generated.tgz) exit 22 ;;
  *) printf 'unexpected URL: %s\n' "$url" >&2; exit 64 ;;
esac
FAKE_CURL
chmod +x "$tmp/curl"

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
if ! FIXTURE_ARCHIVE="$fixture_archive" PATH="$tmp:$PATH" \
  scripts/install.sh \
    --version v9.9.9 \
    --install-root "$tmp/install" \
    --only opencode >"$stdout" 2>&1; then
  printf 'FAIL: installer did not leave a complete current tree under Git Bash semantics\n' >&2
  sed 's/^/    /' "$stdout" >&2
  exit 1
fi

test -f "$tmp/install/current/dist/opencode-host.bundle.min.mjs"
test -f "$tmp/install/current/packaging/npm/dist/rsp.bundle.min.mjs"
printf 'ok: release assets are present before Git Bash creates current\n'
