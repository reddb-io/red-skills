#!/usr/bin/env bash
# Contract test for the installer's marketplace registration source (#3059).
#
# The defect this pins: registering the marketplace from the downloaded snapshot
# directory means `plugin marketplace update` re-reads an unchanging directory,
# so the machine can never advance past its install-day version. The installer
# must register from the GitHub source, and must replace a directory-sourced
# registration it finds on a machine installed before that change.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if ! grep -qF -- "$needle" "$file"; then
    fail "$label: expected '$needle' in:"
    sed 's/^/    /' "$file" >&2
  fi
}

assert_absent() {
  local label="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file"; then
    fail "$label: did not expect '$needle' in:"
    sed 's/^/    /' "$file" >&2
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A minimal source tree: the installer only validates the two marketplace
# manifests before wiring a host.
source_dir="$tmp/source"
mkdir -p "$source_dir/.claude-plugin" "$source_dir/.agents/plugins"
printf '{}\n' >"$source_dir/.claude-plugin/marketplace.json"
printf '{}\n' >"$source_dir/.agents/plugins/marketplace.json"

# The stub records every argv it is handed and answers `marketplace list` with
# the transcript the scenario poses.
cat >"$tmp/claude" <<'FAKE_CLI'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >>"$CLI_STUB_LOG"
if [ "${1:-}" = "plugin" ] && [ "${2:-}" = "marketplace" ] && [ "${3:-}" = "list" ]; then
  # An empty fixture poses a CLI that could not answer at all.
  [ -s "$CLI_STUB_LIST" ] || exit 3
  cat "$CLI_STUB_LIST"
  exit 0
fi
exit 0
FAKE_CLI
chmod +x "$tmp/claude"
cp "$tmp/claude" "$tmp/codex"

export PATH="$tmp:$PATH"

run_install() {
  local list_fixture="$1"
  shift
  : >"$tmp/log"
  printf '%s' "$list_fixture" >"$tmp/list"
  CLI_STUB_LOG="$tmp/log" CLI_STUB_LIST="$tmp/list" \
    scripts/install.sh --source-dir "$source_dir" --only claude "$@" >"$tmp/stdout" 2>&1 \
    || fail "installer exited non-zero:$(printf '\n')$(sed 's/^/    /' "$tmp/stdout")"
}

github_list='Configured marketplaces:

  ❯ red-skills
    Source: GitHub (reddb-io/red-skills)
'

directory_list='Configured marketplaces:

  ❯ red-skills
    Source: Directory (/home/user/.red-skills/current)
'

empty_list='Configured marketplaces:
'

# 1. A fresh install registers the GitHub source, never the snapshot directory.
run_install "$empty_list"
assert_contains "fresh install" "plugin marketplace add --scope user reddb-io/red-skills" "$tmp/log"
assert_absent "fresh install" "marketplace add --scope user $source_dir" "$tmp/log"
assert_absent "fresh install" "plugin marketplace remove red-skills" "$tmp/log"

# 2. A machine already on the GitHub source is not re-registered.
run_install "$github_list"
assert_absent "already healthy" "plugin marketplace remove red-skills" "$tmp/log"
assert_contains "already healthy" "plugin marketplace add --scope user reddb-io/red-skills" "$tmp/log"

# 3. The heal: a directory-sourced registration is removed and re-added from
#    GitHub, so re-running the one-liner cures a frozen machine.
run_install "$directory_list"
assert_contains "frozen machine heal" "plugin marketplace remove red-skills" "$tmp/log"
assert_contains "frozen machine heal" "plugin marketplace add --scope user reddb-io/red-skills" "$tmp/log"
assert_contains "frozen machine heal" "is directory-sourced" "$tmp/stdout"

# 4. The explicit offline/dev fallback still registers the local directory, and
#    replaces a GitHub registration to get there.
run_install "$github_list" --local-marketplace
assert_contains "local fallback" "plugin marketplace add --scope user $source_dir" "$tmp/log"
assert_contains "local fallback" "plugin marketplace remove red-skills" "$tmp/log"
assert_absent "local fallback" "marketplace add --scope user reddb-io/red-skills" "$tmp/log"

# 5. An unreadable source is never re-registered: replacing a registration we
#    could not read would discard whatever the operator configured.
run_install ""
assert_absent "unreadable list" "plugin marketplace remove red-skills" "$tmp/log"

# 6. The source kind is rejected before any host is touched.
if scripts/install.sh --marketplace-source snapshot --only claude >"$tmp/stdout" 2>&1; then
  fail "invalid --marketplace-source was accepted"
else
  assert_contains "invalid source" "--marketplace-source must be github or local" "$tmp/stdout"
fi

if [ "$failures" -eq 0 ]; then
  printf 'ok: installer registers the marketplace from the GitHub source and heals frozen machines\n'
else
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
