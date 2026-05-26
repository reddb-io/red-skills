#!/usr/bin/env bash
# Unit tests for the supervisor's pre-spawn / post-exit hook wiring and the
# monitor's `defaults:` fleet-header field (issue #21).
#
# Source supervisor.sh under the BASH_SOURCE guard so no lock is acquired
# and no workers are spawned, then drive the pure / file-IO helpers
# directly. Hook integration is exercised against the real shipped
# detector directory (cargo.sh / gradle.sh) and against a tmp fixture for
# the monitor's render path.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SUP_SH="$HERE/../supervisor.sh"
MON_SH="$HERE/../monitor.sh"

TMP_ROOT="$(mktemp -d -t supervisor-hooks.XXXXXX)"
trap 'rm -rf "$TMP_ROOT"' EXIT
mkdir -p "$TMP_ROOT/.red/tmp"

# shellcheck disable=SC1090
source "$SUP_SH" "$TMP_ROOT"
# supervisor.sh runs `set -eo pipefail`; relax for tests that expect rc≠0.
set +e

pass=0
fail=0

ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
expect_eq() {
  local label="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then ok "$label"; else
    bad "$label"; echo "  got:  >>$got<<"; echo "  want: >>$want<<";
  fi
}
expect_contains() {
  local label="$1" hay="$2" needle="$3"
  if [[ "$hay" == *"$needle"* ]]; then ok "$label"; else
    bad "$label"; echo "  hay: >>$hay<<"; echo "  needle: >>$needle<<";
  fi
}

# ---------- 1. gen_supervisor_wid format -----------------------------------
wid="$(gen_supervisor_wid)"
[[ "$wid" =~ ^w[A-Z0-9]{4}$ ]] && ok "gen_supervisor_wid format" \
  || bad "gen_supervisor_wid format (got >>$wid<<)"
for _ in $(seq 1 200); do
  wid="$(gen_supervisor_wid)" || { bad "gen_supervisor_wid survives repeated calls"; break; }
  [[ "$wid" =~ ^w[A-Z0-9]{4}$ ]] || { bad "gen_supervisor_wid repeated format (got >>$wid<<)"; break; }
done
[[ "$wid" =~ ^w[A-Z0-9]{4}$ ]] && ok "gen_supervisor_wid survives repeated calls"

# ---------- 2. write_defaults_file is atomic, readable ---------------------
write_defaults_file "cargo gradle"
expect_eq "write_defaults_file: writes content" \
  "$(<"$DEFAULTS_FILE")" "cargo gradle"
write_defaults_file ""
expect_eq "write_defaults_file: empty payload" \
  "$(<"$DEFAULTS_FILE")" ""
rm -f "$DEFAULTS_FILE"

# ---------- 3. run_pre_spawn_hooks on a non-build project ------------------
# Project has no Cargo.toml / build.gradle*, so the shipped detectors all
# exit 1 (skip). Applied list is empty, env file is empty, rc=0.
proj_none="$TMP_ROOT/proj-none"
mkdir -p "$proj_none"
outdir="$(PROJECT_ROOT="$proj_none" run_pre_spawn_hooks 0 wNONE)"
rc=$?
expect_eq "pre-spawn (no build): rc"        "$rc" "0"
expect_eq "pre-spawn (no build): applied"   "$(<"$outdir/applied")" ""
expect_eq "pre-spawn (no build): env empty" "$(wc -c <"$outdir/env" | tr -d ' ')" "0"
rm -rf "$outdir"

# ---------- 4. run_pre_spawn_hooks on a Rust project -----------------------
proj_rust="$TMP_ROOT/proj-rust"
mkdir -p "$proj_rust"
touch "$proj_rust/Cargo.toml"
cargo_base="$TMP_ROOT/cargo-target"

outdir="$(PROJECT_ROOT="$proj_rust" RED_AFK_CARGO_TARGET_BASE="$cargo_base" \
  run_pre_spawn_hooks 2 wRUST)"
rc=$?
expect_eq "pre-spawn (Rust): rc"      "$rc" "0"
expect_eq "pre-spawn (Rust): applied" "$(<"$outdir/applied")" "cargo"
# Env diff isolates *only* detector exports. The detector emits
# CARGO_TARGET_DIR=${RED_AFK_CARGO_TARGET_BASE}/slot-${RED_AFK_SLOT}.
expect_eq "pre-spawn (Rust): env content" \
  "$(<"$outdir/env")" "CARGO_TARGET_DIR=${cargo_base}/slot-2"
[[ -d "$cargo_base/slot-2" ]] && ok "pre-spawn (Rust): slot dir created" \
  || bad "pre-spawn (Rust): slot dir missing"
rm -rf "$outdir"

# ---------- 5. run_pre_spawn_hooks: AFK_* not part of env diff -------------
# Sanity check the diff doesn't leak our own AFK_* exports back to the caller.
outdir="$(PROJECT_ROOT="$proj_rust" RED_AFK_CARGO_TARGET_BASE="$cargo_base" \
  run_pre_spawn_hooks 0 wAFK)"
grep -q '^RED_AFK_SLOT=' "$outdir/env" \
  && bad "pre-spawn: env diff leaks RED_AFK_SLOT" \
  || ok "pre-spawn: env diff excludes RED_AFK_SLOT"
grep -q '^RED_AFK_WORKER_ID=' "$outdir/env" \
  && bad "pre-spawn: env diff leaks RED_AFK_WORKER_ID" \
  || ok "pre-spawn: env diff excludes RED_AFK_WORKER_ID"
rm -rf "$outdir"

# ---------- 6. run_pre_spawn_hooks: hook failure aborts (returns rc) -------
# Plant a misbehaving project-local detector that returns 99. We need to
# use a Layer 2 project detector (Layer 1 shipped detectors are off-limits
# in tests). The orchestrator aborts on first non-zero pre-* result.
proj_break="$TMP_ROOT/proj-break"
mkdir -p "$proj_break/.red/hooks/detectors"
cat > "$proj_break/.red/hooks/detectors/aaaa-bad.sh" <<'EOS'
#!/usr/bin/env bash
exit 99
EOS
chmod +x "$proj_break/.red/hooks/detectors/aaaa-bad.sh"
outdir="$(PROJECT_ROOT="$proj_break" run_pre_spawn_hooks 0 wBAD)"
rc=$?
expect_eq "pre-spawn (broken detector): rc" "$rc" "99"
# applied / env may or may not exist after abort — only rc is contractual.
rm -rf "$outdir"

# ---------- 7. run_post_exit_hooks is best-effort --------------------------
# Plant a project-local main hook for post-exit that asserts the env
# contract (RED_AFK_EXIT_CODE / RED_AFK_DURATION_S / RED_AFK_SLOT / RED_AFK_WORKER_ID) and
# records what it saw. Layer 3 main hook fires unconditionally.
proj_post="$TMP_ROOT/proj-post"
mkdir -p "$proj_post/.red/hooks"
record="$TMP_ROOT/post-exit.record"
: > "$record"
cat > "$proj_post/.red/hooks/post-exit.sh" <<EOS
#!/usr/bin/env bash
printf '%s|%s|%s|%s\n' "\$RED_AFK_SLOT" "\$RED_AFK_WORKER_ID" "\$RED_AFK_EXIT_CODE" "\$RED_AFK_DURATION_S" >> "$record"
exit 0
EOS
chmod +x "$proj_post/.red/hooks/post-exit.sh"
PROJECT_ROOT="$proj_post" run_post_exit_hooks 1 wEXIT 137 42
rc=$?
expect_eq "post-exit: rc passthrough (always 0)" "$rc" "0"
expect_eq "post-exit: env contract recorded" "$(<"$record")" "1|wEXIT|137|42"

# Failure path — post-exit returning non-zero must still return 0 from the
# wrapper (best-effort semantics).
cat > "$proj_post/.red/hooks/post-exit.sh" <<'EOS'
#!/usr/bin/env bash
exit 5
EOS
chmod +x "$proj_post/.red/hooks/post-exit.sh"
PROJECT_ROOT="$proj_post" run_post_exit_hooks 1 wEXIT 137 42
rc=$?
expect_eq "post-exit: wrapper swallows non-zero" "$rc" "0"

# ---------- 8. log_applied_detectors_boot_line seeds defaults file ---------
# On a Rust project the boot line writes `cargo` to DEFAULTS_FILE; on a
# bare project it writes an empty line so monitor.sh can still render `-`.
rm -f "$DEFAULTS_FILE"
export RED_AFK_CARGO_TARGET_BASE="$cargo_base"
PROJECT_ROOT="$proj_rust" log_applied_detectors_boot_line >/dev/null 2>&1
expect_eq "boot-line: writes applied list" \
  "$(<"$DEFAULTS_FILE")" "cargo"
unset RED_AFK_CARGO_TARGET_BASE
rm -f "$DEFAULTS_FILE"
PROJECT_ROOT="$proj_none" log_applied_detectors_boot_line >/dev/null 2>&1
expect_eq "boot-line: writes empty line on bare project" \
  "$(<"$DEFAULTS_FILE")" ""

# ---------- 9. monitor renders `defaults:` field ---------------------------
# Stand up a tmp project that mimics a live supervisor: pid file (this
# test's own PID, guaranteed alive), supervisor log with a `target=` line,
# defaults file with two detectors. monitor.sh --once must emit a
# fleet-header line containing `defaults: cargo, gradle`.
mon_proj="$TMP_ROOT/mon-proj"
mkdir -p "$mon_proj/.red/tmp"
echo "$$" > "$mon_proj/.red/tmp/afk-supervisor.pid"
echo "[$(date -Iseconds)] [supervisor] acquired lock (pid=$$, target=2, project=$mon_proj)" \
  > "$mon_proj/.red/tmp/afk-supervisor.log"
printf 'cargo gradle\n' > "$mon_proj/.red/tmp/afk-supervisor-defaults.txt"
mon_out="$(NO_COLOR=1 bash "$MON_SH" --once "$mon_proj" 2>/dev/null)"
expect_contains "monitor: defaults: cargo, gradle present" "$mon_out" "defaults: cargo, gradle"

# Empty defaults file → `defaults: -`.
printf '\n' > "$mon_proj/.red/tmp/afk-supervisor-defaults.txt"
mon_out="$(NO_COLOR=1 bash "$MON_SH" --once "$mon_proj" 2>/dev/null)"
expect_contains "monitor: defaults: - on empty file" "$mon_out" "defaults: -"

# Missing defaults file → `defaults: -` (graceful fallback).
rm -f "$mon_proj/.red/tmp/afk-supervisor-defaults.txt"
mon_out="$(NO_COLOR=1 bash "$MON_SH" --once "$mon_proj" 2>/dev/null)"
expect_contains "monitor: defaults: - on missing file" "$mon_out" "defaults: -"

# No pid file → header (and therefore `defaults:`) absent.
rm -f "$mon_proj/.red/tmp/afk-supervisor.pid"
mon_out="$(NO_COLOR=1 bash "$MON_SH" --once "$mon_proj" 2>/dev/null)"
if [[ "$mon_out" != *"supervisor pid="* ]]; then
  ok "monitor: header absent without supervisor pid"
else
  bad "monitor: header present without supervisor pid"
fi

# ---------- 10. structural greps for spawn_slot / handle_dead_slot wiring --
grep -q 'run_pre_spawn_hooks "$slot" "$worker_id"' "$SUP_SH" \
  && ok "spawn_slot calls run_pre_spawn_hooks" \
  || bad "spawn_slot does not call run_pre_spawn_hooks"
grep -q 'pre-spawn hook failed' "$SUP_SH" \
  && ok "spawn_slot logs pre-spawn failures" \
  || bad "spawn_slot missing pre-spawn failure log"
grep -q 'run_post_exit_hooks "$slot"' "$SUP_SH" \
  && ok "handle_dead_slot calls run_post_exit_hooks" \
  || bad "handle_dead_slot does not call run_post_exit_hooks"
grep -q 'wait "$pid"' "$SUP_SH" \
  && ok "handle_dead_slot reaps zombie for RED_AFK_EXIT_CODE" \
  || bad "handle_dead_slot does not reap zombie"
grep -q 'RED_AFK_PLUGIN_DIR="$PLUGIN_DIR"' "$SUP_SH" \
  && ok "hooks invoked with RED_AFK_PLUGIN_DIR" \
  || bad "hooks missing RED_AFK_PLUGIN_DIR export"
grep -q 'SUPERVISOR_REQUEST="${RED_AFK_REQUEST:-}"' "$SUP_SH" \
  && ok "supervisor reads RED_AFK_REQUEST default" \
  || bad "supervisor missing RED_AFK_REQUEST default"
grep -q 'worker_cmd+=(--request "$SUPERVISOR_REQUEST")' "$SUP_SH" \
  && ok "spawn_slot forwards --request to worker" \
  || bad "spawn_slot missing --request forwarding"

# ---------- 11. RED_AFK_* passthrough env ---------------------------------
(
  export RED_AFK_SKIP_PERF=1
  export RED_AFK_FOO=bar
  export RED_AFK_TARGET=42
  export RED_AFK_CARGO_TARGET_BASE=/tmp/x
  export RED_AFK_POLL_S=99
  out="$(build_passthrough_env)"
  if grep -qx 'RED_AFK_SKIP_PERF=1' <<<"$out"; then ok "passthrough: SKIP_PERF forwarded"; else bad "passthrough: SKIP_PERF missing"; fi
  if grep -qx 'RED_AFK_FOO=bar' <<<"$out"; then ok "passthrough: FOO forwarded"; else bad "passthrough: FOO missing"; fi
  if grep -qx 'RED_AFK_TARGET=42' <<<"$out"; then bad "passthrough: TARGET leaked (denylist)"; else ok "passthrough: TARGET excluded"; fi
  if grep -q 'RED_AFK_CARGO_TARGET_BASE' <<<"$out"; then bad "passthrough: _BASE leaked"; else ok "passthrough: _BASE excluded"; fi
  if grep -qx 'RED_AFK_POLL_S=99' <<<"$out"; then bad "passthrough: POLL_S leaked (denylist)"; else ok "passthrough: POLL_S excluded"; fi
)
grep -q 'build_passthrough_env' "$SUP_SH" \
  && ok "supervisor defines build_passthrough_env" \
  || bad "supervisor missing build_passthrough_env"
grep -q 'build_passthrough_env "$slot"\|build_passthrough_env)' "$SUP_SH" \
  && ok "spawn_slot consumes build_passthrough_env" \
  || bad "spawn_slot does not consume build_passthrough_env"

echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
