#!/usr/bin/env bash
# Verifies the inner-agent `pnpm` shim (lib/inner-shims/pnpm).
#
# Contract (issue #192):
#   - `pnpm test` / `pnpm test:*` / `pnpm -C dir test` / `pnpm run test`
#     are wrapped with `timeout RED_AFK_TEST_TIMEOUT_S` so a hung test
#     runner cannot keep an untimed polling loop alive forever.
#   - Non-test invocations (install, add, build, lint, etc.) are forwarded
#     to the real `pnpm` unchanged — no timeout, no behavioural drift.
#   - The shim re-resolves the real `pnpm` by stripping itself from PATH;
#     it must never recurse into itself.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SHIM_DIR="$(cd "$HERE/../lib/inner-shims" && pwd)"
SHIM="$SHIM_DIR/pnpm"

if [[ ! -x "$SHIM" ]]; then
  echo "FAIL  shim not executable at $SHIM" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Fake `pnpm` that prints its argv and either hangs (for test invocations)
# or exits immediately (for everything else). The shim must find it on a
# PATH from which the shim's own directory has been removed.
fake_dir="$tmp/fakebin"
mkdir -p "$fake_dir"
cat >"$fake_dir/pnpm" <<'EOF'
#!/usr/bin/env bash
echo "FAKE_PNPM_ARGS:$*"
for arg in "$@"; do
  case "$arg" in
    test|test:*) sleep 30; exit 0 ;;
  esac
done
exit 0
EOF
chmod +x "$fake_dir/pnpm"

# Sanitize PATH so only the shim + fake pnpm are reachable.
BASE_PATH="$SHIM_DIR:$fake_dir:/usr/bin:/bin"

pass=0
fail=0

run_case() {
  local label="$1" expect_rc="$2" max_seconds="$3"; shift 3
  local start end elapsed rc out
  out="$tmp/out.$$"
  start="$(date +%s)"
  PATH="$BASE_PATH" RED_AFK_TEST_TIMEOUT_S=2 RED_AFK_TEST_KILL_AFTER_S=1 \
    "$SHIM" "$@" >"$out" 2>&1
  rc=$?
  end="$(date +%s)"
  elapsed=$((end - start))
  if [[ "$rc" != "$expect_rc" ]]; then
    echo "FAIL  $label  (expected rc=$expect_rc got rc=$rc)"
    sed 's/^/      /' "$out"
    fail=$((fail + 1))
    return
  fi
  if [[ "$elapsed" -gt "$max_seconds" ]]; then
    echo "FAIL  $label  (took ${elapsed}s, expected <=${max_seconds}s)"
    fail=$((fail + 1))
    return
  fi
  echo "PASS  $label  (rc=$rc, ${elapsed}s)"
  pass=$((pass + 1))
}

# 124 = GNU timeout's exit code when the command is killed by SIGTERM.
run_case "pnpm test (hung) hits timeout"          124 6  test
run_case "pnpm run test (hung) hits timeout"      124 6  run test
run_case "pnpm -C svc test (hung) hits timeout"   124 6  -C svc test
run_case "pnpm test:integration (hung) timeout"   124 6  test:integration
run_case "pnpm install (passthrough, no timeout)" 0   3  install
run_case "pnpm build (passthrough, no timeout)"   0   3  build
run_case "pnpm add foo (no timeout)"              0   3  add foo

# RED_AFK_PNPM_SHIM_DISABLE bypass: even `pnpm test` runs without the wrap.
out="$tmp/out.disable"
start="$(date +%s)"
PATH="$BASE_PATH" RED_AFK_PNPM_SHIM_DISABLE=1 RED_AFK_TEST_TIMEOUT_S=2 \
  timeout 6 "$SHIM" test >"$out" 2>&1
rc=$?
end="$(date +%s)"
elapsed=$((end - start))
# disabled + hung => outer `timeout 6` reaps it at 6s with rc=124
if [[ "$rc" == "124" && "$elapsed" -ge 5 ]]; then
  echo "PASS  RED_AFK_PNPM_SHIM_DISABLE bypasses wrap  (rc=$rc, ${elapsed}s)"
  pass=$((pass + 1))
else
  echo "FAIL  RED_AFK_PNPM_SHIM_DISABLE bypasses wrap  (rc=$rc, ${elapsed}s)"
  sed 's/^/      /' "$out"
  fail=$((fail + 1))
fi

# Shim must call the real pnpm, not itself: argv must appear in output.
out="$tmp/out.argv"
PATH="$BASE_PATH" RED_AFK_TEST_TIMEOUT_S=2 "$SHIM" install >"$out" 2>&1
if grep -q '^FAKE_PNPM_ARGS:install$' "$out"; then
  echo "PASS  shim forwards argv to real pnpm"
  pass=$((pass + 1))
else
  echo "FAIL  shim did not forward argv to real pnpm"
  sed 's/^/      /' "$out"
  fail=$((fail + 1))
fi

echo
echo "summary: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
