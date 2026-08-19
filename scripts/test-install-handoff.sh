#!/usr/bin/env bash
# Contract test for the standalone installer's handoff to mise/red-dev (#3978).
#
# The ownership this pins away: the installer used to acquire RedSkills itself —
# it materialised npm packages into its own `versions/<tag>` tree under the
# RedSkills root (`~/.red/skills` today), symlinked `current`, registered a GitHub-sourced marketplace on every host CLI,
# and *healed* a Directory-sourced registration back to GitHub. Once red-dev owns
# acquisition and wiring through mise, every one of those is a second owner of
# the same machine, and the heal actively tears out red-dev's registration.
#
# What the installer must do instead: detect a supported platform, hand the
# operator to the pinned red-dev bootstrap, and own nothing. The local-development
# escape hatch stays, wires only from an explicit checkout, and says out loud
# that it is not a production installation.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

failures=0

fail() {
  printf 'FAIL: %s\n' "$*" >&2
  failures=$((failures + 1))
}

show() {
  sed 's/^/    /' "$1" >&2
}

assert_contains() {
  local label="$1" needle="$2" file="$3"
  if ! grep -qF -- "$needle" "$file"; then
    fail "$label: expected '$needle' in:"
    show "$file"
  fi
}

assert_absent() {
  local label="$1" needle="$2" file="$3"
  if grep -qF -- "$needle" "$file"; then
    fail "$label: did not expect '$needle' in:"
    show "$file"
  fi
}

assert_no_path() {
  local label="$1" path="$2"
  if [[ -e "$path" ]]; then
    fail "$label: installer created independent ownership at $path"
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

bin="$tmp/bin"
mkdir -p "$bin"
export PATH="$bin:$PATH"

# The installer runs against a PATH holding the stubs, node, and the system
# tools — never the operator's own red-dev, mise or npm, or a scenario that
# poses one of them as absent would silently exercise the real thing.
node_dir="$(dirname "$(command -v node)")"
installer_path="$bin:$node_dir:/usr/bin:/bin"

# A minimal source checkout: the escape hatch validates the two marketplace
# manifests before wiring a host.
source_dir="$tmp/source"
mkdir -p "$source_dir/.claude-plugin" "$source_dir/.agents/plugins"
printf '{}\n' >"$source_dir/.claude-plugin/marketplace.json"
printf '{}\n' >"$source_dir/.agents/plugins/marketplace.json"

# Every stub records its argv in one log, so a scenario can assert on what the
# installer did to the machine rather than on what it printed.
make_stub() {
  local name="$1"
  cat >"$bin/$name" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf '$name %s\n' "\$*" >>"\$STUB_LOG"
STUB
  chmod +x "$bin/$name"
}

# The host CLIs also answer \`plugin marketplace list\` with the transcript the
# scenario poses.
make_host_stub() {
  local name="$1"
  cat >"$bin/$name" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf '$name %s\n' "\$*" >>"\$STUB_LOG"
if [ "\${1:-}" = "plugin" ] && [ "\${2:-}" = "marketplace" ] && [ "\${3:-}" = "list" ]; then
  [ -s "\$STUB_LIST" ] || exit 3
  cat "\$STUB_LIST"
fi
exit 0
STUB
  chmod +x "$bin/$name"
}

# The npm stub materialises exactly what the retired acquisition path expected,
# so a regression that restores it produces a real tree this test can see.
cat >"$bin/npm" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
printf 'npm %s\n' "$*" >>"$STUB_LOG"
prefix=""
specs=()
while [ $# -gt 0 ]; do
  case "$1" in
    --prefix) prefix="$2"; shift 2 ;;
    @reddb-io/*) specs+=("$1"); shift ;;
    *) shift ;;
  esac
done
[ -n "$prefix" ] || exit 0
for spec in "${specs[@]}"; do
  name="${spec%@*}"
  dir="$prefix/node_modules/$name"
  mkdir -p "$dir/dist" "$dir/.claude-plugin" "$dir/.agents/plugins"
  printf '{"name":"%s","version":"9.9.9"}\n' "$name" >"$dir/package.json"
  printf '{}\n' >"$dir/.claude-plugin/marketplace.json"
  printf '{}\n' >"$dir/.agents/plugins/marketplace.json"
  plugin="${name#@reddb-io/red-skills-}"
  if [ "$plugin" != "$name" ]; then
    printf '// stub\n' >"$dir/dist/$plugin.bundle.min.mjs"
  fi
done
STUB
chmod +x "$bin/npm"

remove_stub() { rm -f "$bin/$1"; }

# Every host CLI is stubbed up front, so a real one installed on the machine
# running this test is never reached and never wired.
make_host_stub claude
make_host_stub codex
for host in gemini hermes opencode redcode pi; do
  make_stub "$host"
done

home=""
status=0

# Each scenario gets a fresh HOME so `~/.red/skills` can only exist because this
# run created it.
run_installer() {
  home="$tmp/home"
  rm -rf "$home"
  mkdir -p "$home"
  run_installer_in_home "$@"
}

# Same run against whatever the scenario already put in HOME — the shape of a
# machine that carries state from an earlier install.
run_installer_in_home() {
  : >"$tmp/log"
  status=0
  HOME="$home" PATH="$installer_path" STUB_LOG="$tmp/log" STUB_LIST="$tmp/list" \
    scripts/install.sh "$@" >"$tmp/stdout" 2>&1 || status=$?
}

pose_marketplace_list() { printf '%s' "$1" >"$tmp/list"; }

github_list='Configured marketplaces:

  ❯ red-skills
    Source: GitHub (reddb-io/red-skills)
'

directory_list='Configured marketplaces:

  ❯ red-skills
    Source: Directory (/home/user/.red-dev/state/red-skills)
'

empty_list='Configured marketplaces:
'

: >"$tmp/list"

# ---------------------------------------------------------------------------
# 1. The handoff. red-dev already on the machine: the installer runs its
#    bootstrap and touches nothing else.
# ---------------------------------------------------------------------------
make_stub red-dev
pose_marketplace_list "$empty_list"
run_installer
[[ "$status" -eq 0 ]] || {
  fail "handoff with red-dev present exited $status:"
  show "$tmp/stdout"
}
assert_contains "handoff" "red-dev install" "$tmp/log"
assert_contains "handoff" "red-dev --version" "$tmp/log"
assert_no_path "handoff" "$home/.red/skills"
assert_absent "handoff" "npm " "$tmp/log"
assert_absent "handoff" "marketplace add" "$tmp/log"
assert_absent "handoff" "marketplace remove" "$tmp/log"
assert_absent "handoff" "reddb-io/red-skills" "$tmp/log"

# ---------------------------------------------------------------------------
# 2. The handoff acquires red-dev through mise when it is missing, from a
#    pinned spec, and proves the entry point answers before reporting success.
# ---------------------------------------------------------------------------
remove_stub red-dev
cat >"$bin/mise" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf 'mise %s\n' "\$*" >>"\$STUB_LOG"
STUB
chmod +x "$bin/mise"
run_installer
[[ "$status" -ne 0 ]] || fail "handoff reported success although red-dev never answered"
assert_contains "unverified handoff" "mise use --global red-dev@" "$tmp/log"
assert_contains "unverified handoff" "could not run red-dev" "$tmp/stdout"
assert_no_path "unverified handoff" "$home/.red/skills"

# A mise that really installs the tool: the bootstrap runs through it.
cat >"$bin/mise" <<STUB
#!/usr/bin/env bash
set -euo pipefail
printf 'mise %s\n' "\$*" >>"\$STUB_LOG"
if [ "\${1:-}" = "use" ]; then
  cat >"$bin/red-dev" <<'INNER'
#!/usr/bin/env bash
set -euo pipefail
printf 'red-dev %s\n' "\$*" >>"\$STUB_LOG"
INNER
  chmod +x "$bin/red-dev"
fi
exit 0
STUB
chmod +x "$bin/mise"
run_installer
[[ "$status" -eq 0 ]] || {
  fail "mise handoff exited $status:"
  show "$tmp/stdout"
}
assert_contains "mise handoff" "mise use --global red-dev@" "$tmp/log"
assert_contains "mise handoff" "red-dev install" "$tmp/log"
assert_no_path "mise handoff" "$home/.red/skills"
assert_absent "mise handoff" "npm " "$tmp/log"

# The pin is overridable for a red-dev pre-release, and the override is what
# mise is asked for.
remove_stub red-dev
run_installer --red-dev-spec "red-dev@2.0.0-rc.1"
assert_contains "pinned override" "mise use --global red-dev@2.0.0-rc.1" "$tmp/log"

remove_stub red-dev

# ---------------------------------------------------------------------------
# 3. No mise, no red-dev: the installer explains the one supported path and
#    fails rather than falling back to owning the machine itself.
# ---------------------------------------------------------------------------
remove_stub mise
run_installer
[[ "$status" -ne 0 ]] || fail "installer reported success with neither mise nor red-dev present"
assert_contains "no bootstrap" "mise" "$tmp/stdout"
assert_contains "no bootstrap" "red-dev@" "$tmp/stdout"
assert_no_path "no bootstrap" "$home/.red/skills"
assert_absent "no bootstrap" "npm " "$tmp/log"
assert_absent "no bootstrap" "marketplace add" "$tmp/log"

# ---------------------------------------------------------------------------
# 4. An unsupported platform is refused before anything is written, and is sent
#    to the manual per-host walkthrough rather than to a silent legacy install.
# ---------------------------------------------------------------------------
cat >"$bin/uname" <<'STUB'
#!/usr/bin/env bash
case "${1:-}" in
  -s) printf 'Plan9\n' ;;
  -m) printf 'vax\n' ;;
  *) printf 'Plan9\n' ;;
esac
STUB
chmod +x "$bin/uname"
run_installer
[[ "$status" -ne 0 ]] || fail "unsupported platform was accepted"
assert_contains "unsupported platform" "Plan9" "$tmp/stdout"
assert_contains "unsupported platform" "docs/INSTALL.md" "$tmp/stdout"
assert_no_path "unsupported platform" "$home/.red/skills"
remove_stub uname

# ---------------------------------------------------------------------------
# 5. The escape hatch. Explicit, checkout-scoped, and never disguised as a
#    production install.
# ---------------------------------------------------------------------------
pose_marketplace_list "$empty_list"
run_installer --local-dev --source-dir "$source_dir" --only claude
[[ "$status" -eq 0 ]] || {
  fail "local-dev install exited $status:"
  show "$tmp/stdout"
}
assert_contains "escape hatch" "not a production installation" "$tmp/stdout"
assert_contains "escape hatch" "plugin marketplace add --scope user $source_dir" "$tmp/log"
assert_absent "escape hatch" "reddb-io/red-skills" "$tmp/log"
assert_absent "escape hatch" "npm " "$tmp/log"
assert_no_path "escape hatch" "$home/.red/skills/versions"
assert_no_path "escape hatch" "$home/.red/skills/current"

# Without a checkout there is nothing to develop against, and the escape hatch
# must not quietly become an acquisition path.
run_installer --local-dev --only claude
[[ "$status" -ne 0 ]] || fail "--local-dev without --source-dir was accepted"
assert_contains "escape hatch needs a checkout" "--source-dir" "$tmp/stdout"
assert_absent "escape hatch needs a checkout" "npm " "$tmp/log"

# ---------------------------------------------------------------------------
# 6. A Directory-sourced registration is red-dev's. It is never removed, and
#    never healed back to the GitHub source.
# ---------------------------------------------------------------------------
pose_marketplace_list "$directory_list"
run_installer --local-dev --source-dir "$source_dir" --only claude
[[ "$status" -eq 0 ]] || {
  fail "local-dev over a red-dev registration exited $status:"
  show "$tmp/stdout"
}
assert_absent "red-dev registration" "marketplace remove" "$tmp/log"
assert_absent "red-dev registration" "marketplace add" "$tmp/log"
assert_absent "red-dev registration" "reddb-io/red-skills" "$tmp/log"
assert_contains "red-dev registration" "red-dev" "$tmp/stdout"

# --force is the operator saying they want this checkout instead; even then the
# replacement is the checkout, never GitHub.
run_installer --local-dev --source-dir "$source_dir" --only claude --force
assert_contains "forced replacement" "plugin marketplace remove red-skills" "$tmp/log"
assert_contains "forced replacement" "plugin marketplace add --scope user $source_dir" "$tmp/log"
assert_absent "forced replacement" "reddb-io/red-skills" "$tmp/log"

# ---------------------------------------------------------------------------
# 7. A GitHub-sourced registration is the retired standalone installer's own
#    leftover: the escape hatch replaces it with the checkout.
# ---------------------------------------------------------------------------
pose_marketplace_list "$github_list"
run_installer --local-dev --source-dir "$source_dir" --only claude
assert_contains "legacy github registration" "plugin marketplace remove red-skills" "$tmp/log"
assert_contains "legacy github registration" "plugin marketplace add --scope user $source_dir" "$tmp/log"
assert_absent "legacy github registration" "marketplace add --scope user reddb-io/red-skills" "$tmp/log"

# ---------------------------------------------------------------------------
# 8. The knobs that only existed to choose an independently owned source are
#    gone, so no caller can ask for one.
# ---------------------------------------------------------------------------
for retired in --local-marketplace --refresh; do
  run_installer "$retired"
  [[ "$status" -ne 0 ]] || fail "retired flag $retired was accepted"
  assert_contains "retired flag $retired" "unknown argument" "$tmp/stdout"
done
run_installer --marketplace-source github
[[ "$status" -ne 0 ]] || fail "retired flag --marketplace-source was accepted"

if [ "$failures" -eq 0 ]; then
  printf 'ok: the standalone installer hands ownership to mise/red-dev and owns nothing\n'
else
  printf '%d check(s) failed\n' "$failures" >&2
  exit 1
fi
