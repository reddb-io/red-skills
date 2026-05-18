#!/usr/bin/env bash
# Unit tests for the generic hook orchestrator (issue #18, PRD #16).
#
# Drives hooks_run against a tmp project tree with:
#   $tmp/plugin/detectors/              — shipped detectors
#   $tmp/project/.red/hooks/detectors/  — project detectors
#   $tmp/project/.red/hooks/<point>.sh  — project main hook

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
HOOKS_SH="$HERE/../hooks.sh"

# shellcheck disable=SC1090
source "$HOOKS_SH"

pass=0
fail=0

expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    echo "  got:  >>$got<<"
    echo "  want: >>$want<<"
    fail=$((fail + 1))
  fi
}

expect_true() {
  local label="$1" cond="$2"
  if [[ "$cond" == "1" ]]; then
    echo "PASS  $label"
    pass=$((pass + 1))
  else
    echo "FAIL  $label"
    fail=$((fail + 1))
  fi
}

mktmp_root() {
  local t
  t="$(mktemp -d -t afk-hooks.XXXXXX)"
  mkdir -p "$t/plugin/detectors"
  mkdir -p "$t/project/.red/hooks/detectors"
  printf '%s' "$t"
}

# Build a tiny detector script. Args: path, exit_code, [env_line]
make_detector() {
  local path="$1" rc="$2" env_line="${3:-}"
  cat > "$path" <<EOF
#!/usr/bin/env bash
EOF
  if [[ -n "$env_line" ]]; then
    cat >> "$path" <<EOF
printf '%s\n' '$env_line' >> "\$AFK_HOOK_ENV_FILE"
EOF
  fi
  cat >> "$path" <<EOF
exit $rc
EOF
  chmod +x "$path"
}

reset_env() {
  unset FOO BAR BAZ HOOK_ORDER
  HOOKS_APPLIED_DETECTORS=()
}

# ---------- 1. empty layers on pre-spawn → 0, no env mutation ----------
root="$(mktmp_root)"
reset_env
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
rc=$?
expect_eq "empty layers: rc=0"        "$rc" "0"
expect_eq "empty layers: FOO unset"   "${FOO:-}" ""
expect_eq "empty layers: no applied"  "${#HOOKS_APPLIED_DETECTORS[@]}" "0"
rm -rf "$root"

# ---------- 2. shipped detector writes FOO=bar → exported in caller ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/foo.sh" 0 "FOO=bar"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
rc=$?
expect_eq "shipped exports: rc=0" "$rc" "0"
expect_eq "shipped exports: FOO"  "${FOO:-}" "bar"
expect_eq "shipped exports: applied list" "${HOOKS_APPLIED_DETECTORS[*]}" "foo"
rm -rf "$root"
unset FOO

# ---------- 3. detector exit 1 → no-op, not applied, no abort ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/skipme.sh" 1
make_detector "$root/plugin/detectors/ok.sh" 0
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
rc=$?
expect_eq "exit-1: rc=0 (not aborted)" "$rc" "0"
expect_eq "exit-1: not in applied"     "${HOOKS_APPLIED_DETECTORS[*]}" "ok"
rm -rf "$root"

# ---------- 4. detector exit 2 on pre-spawn → abort with clear log ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/boom.sh" 2
log="$(mktemp)"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn 2> "$log"
rc=$?
[[ $rc -ne 0 ]] && r=1 || r=0
expect_true "exit-2 pre-spawn: non-zero rc" "$r"
if grep -q "boom" "$log"; then r=1; else r=0; fi
expect_true "exit-2 pre-spawn: log names detector" "$r"
rm -rf "$root" "$log"

# ---------- 5. same exit-2 on post-merge → logged but rc=0 ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/boom.sh" 2
log="$(mktemp)"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run post-merge 2> "$log"
rc=$?
expect_eq "exit-2 post-merge: rc=0" "$rc" "0"
if grep -q "boom" "$log"; then r=1; else r=0; fi
expect_true "exit-2 post-merge: log names detector" "$r"
rm -rf "$root" "$log"

# ---------- 6. project detector overrides shipped value ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/aa.sh"               0 "FOO=ship"
make_detector "$root/project/.red/hooks/detectors/aa.sh"   0 "FOO=proj"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
expect_eq "layer-override: project wins over shipped" "${FOO:-}" "proj"
rm -rf "$root"
unset FOO

# ---------- 7. main hook overrides both detector layers ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/aa.sh"             0 "FOO=ship"
make_detector "$root/project/.red/hooks/detectors/aa.sh" 0 "FOO=proj"
cat > "$root/project/.red/hooks/pre-spawn.sh" <<'EOF'
#!/usr/bin/env bash
echo "FOO=main" >> "$AFK_HOOK_ENV_FILE"
EOF
chmod +x "$root/project/.red/hooks/pre-spawn.sh"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
expect_eq "main-override: main hook wins" "${FOO:-}" "main"
rm -rf "$root"
unset FOO

# ---------- 8. alphabetical order within a layer ----------
root="$(mktmp_root)"
reset_env
order_file="$(mktemp)"
for n in c a b; do
  cat > "$root/plugin/detectors/$n.sh" <<EOF
#!/usr/bin/env bash
echo "$n" >> "$order_file"
exit 0
EOF
  chmod +x "$root/plugin/detectors/$n.sh"
done
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
expect_eq "alphabetical: order = a,b,c" "$(tr '\n' ',' < "$order_file")" "a,b,c,"
expect_eq "alphabetical: applied list"  "${HOOKS_APPLIED_DETECTORS[*]}" "a b c"
rm -rf "$root" "$order_file"

# ---------- 9. temp env-files cleaned up ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/foo.sh" 0 "BAR=baz"
# Use a private TMPDIR to count predictably.
private_tmp="$(mktemp -d)"
TMPDIR="$private_tmp" AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
leftover="$(find "$private_tmp" -name 'afk-hook-env.*' -type f 2>/dev/null | wc -l | tr -d ' ')"
expect_eq "cleanup: no leftover env files" "$leftover" "0"
rm -rf "$root" "$private_tmp"
unset BAR

# ---------- 10. applied list excludes failed/N-A and ordered across layers ----------
root="$(mktmp_root)"
reset_env
make_detector "$root/plugin/detectors/ship-a.sh"             0
make_detector "$root/plugin/detectors/ship-na.sh"            1
make_detector "$root/project/.red/hooks/detectors/proj-x.sh" 0
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
expect_eq "applied: shipped-first then project, N/A excluded" \
  "${HOOKS_APPLIED_DETECTORS[*]}" "ship-a proj-x"
rm -rf "$root"

# ---------- 11. unknown hook point → non-zero ----------
root="$(mktmp_root)"
reset_env
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run not-a-real-point 2>/dev/null
rc=$?
[[ $rc -ne 0 ]] && r=1 || r=0
expect_true "unknown point: non-zero rc" "$r"
rm -rf "$root"

# ---------- 12. main hook failure on pre-merge → abort ----------
root="$(mktmp_root)"
reset_env
cat > "$root/project/.red/hooks/pre-merge.sh" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$root/project/.red/hooks/pre-merge.sh"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-merge 2>/dev/null
rc=$?
expect_eq "main hook pre-merge fail: propagates rc" "$rc" "7"
rm -rf "$root"

# ---------- 13. main hook failure on post-merge → logged, rc=0 ----------
root="$(mktmp_root)"
reset_env
cat > "$root/project/.red/hooks/post-merge.sh" <<'EOF'
#!/usr/bin/env bash
exit 7
EOF
chmod +x "$root/project/.red/hooks/post-merge.sh"
log="$(mktemp)"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run post-merge 2> "$log"
rc=$?
expect_eq "main hook post-merge fail: rc=0" "$rc" "0"
if grep -q "post-merge" "$log"; then r=1; else r=0; fi
expect_true "main hook post-merge fail: logged" "$r"
rm -rf "$root" "$log"

# ---------- 14. shipped detector disabled via config (cargo=false) ----------
root="$(mktmp_root)"
reset_env
mkdir -p "$root/project/.red"
cat > "$root/project/.red/config.yaml" <<'YAML'
afk:
  hooks:
    defaults:
      cargo: false
YAML
make_detector "$root/plugin/detectors/cargo.sh"  0 "CARGO_RAN=1"
make_detector "$root/plugin/detectors/gradle.sh" 0 "GRADLE_RAN=1"
# Re-load config from the project dir.
config_load "$root/project/.red/config.yaml"
AFK_PLUGIN_DIR="$root/plugin" PROJECT_ROOT="$root/project" hooks_run pre-spawn
expect_eq "config disable: cargo skipped"   "${CARGO_RAN:-unset}"  "unset"
expect_eq "config disable: gradle ran"      "${GRADLE_RAN:-unset}" "1"
expect_eq "config disable: applied excludes cargo" \
  "${HOOKS_APPLIED_DETECTORS[*]}" "gradle"
rm -rf "$root"
unset CARGO_RAN GRADLE_RAN
config_load "/nonexistent/.red/config.yaml"  # reset to defaults

# ---------- 15. wired up: afk.sh and supervisor.sh source hooks.sh ----------
afk_sh="$HERE/../afk.sh"
sup_sh="$HERE/../supervisor.sh"
if grep -q 'hooks\.sh' "$afk_sh"; then
  echo "PASS  afk.sh sources hooks.sh"
  pass=$((pass + 1))
else
  echo "FAIL  afk.sh does not source hooks.sh"
  fail=$((fail + 1))
fi
if grep -q 'hooks\.sh' "$sup_sh"; then
  echo "PASS  supervisor.sh sources hooks.sh"
  pass=$((pass + 1))
else
  echo "FAIL  supervisor.sh does not source hooks.sh"
  fail=$((fail + 1))
fi

# ---------- summary ----------
echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
