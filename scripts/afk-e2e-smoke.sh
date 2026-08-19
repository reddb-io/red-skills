#!/usr/bin/env bash
# AFK native + sandcastle E2E smoke test — the validation gate for issue #284.
#
# The AFK skill was ported shell→TypeScript and its execution pivoted to
# @ai-hero/sandcastle (ADR 0033). Everything is unit-tested and the bundle ships,
# but the *agent path* (run → sandcastle.run → a real agent CLI → feedback → land
# → close) has never been exercised end-to-end. There is no longer a bash fallback
# (RED_AFK_LEGACY was removed), so this is the gate before flipping the release
# off `[skip release]`.
#
# It runs in LAYERS, safest first:
#   Phase 0  prerequisites (read-only)
#   Phase 1  non-agent native commands: monitor / reap / statusline (zero risk)
#   Phase 2  empty-queue drain: boot + select + precheck, no agent spawned
#   Phase 3  THE GATE — a real agent iteration through sandcastle (mutating;
#            opt-in, must target a THROWAWAY repo + a trivial test issue)
#
# Phases 0-2 run automatically. Phase 3 only runs when you set the env vars below
# and confirm — because it claims an issue, spawns an agent, opens/merges a PR,
# and closes the issue on whatever repo you run it in.
#
# Usage:
#   # safe layers only (no agent):
#   bash scripts/afk-e2e-smoke.sh
#
#   # full gate — run from a THROWAWAY test repo (its own gh remote), with a
#   # trivial `ready-for-agent` issue and an authed agent CLI on PATH:
#   AFK_E2E_ISSUE=42 AFK_E2E_RUNNER=claude bash /path/to/scripts/afk-e2e-smoke.sh
#
# Env:
#   AFK_BUNDLE        path to bin/afk.mjs (default: resolved next to this script)
#   AFK_E2E_ISSUE     issue number to drive Phase 3 (enables the gate)
#   AFK_E2E_RUNNER    claude | codex   (default: claude)
#   AFK_E2E_SANDBOX   none | docker | podman   (default: none = node-only)
#   AFK_E2E_YES=1     skip the Phase 3 confirmation prompt

set -uo pipefail

# ---- resolve the bundle ----------------------------------------------------
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUNDLE="${AFK_BUNDLE:-$here/../plugins/dev/skills/engineering/afk/bin/afk.mjs}"
RUNNER="${AFK_E2E_RUNNER:-claude}"
SANDBOX="${AFK_E2E_SANDBOX:-none}"

pass() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '  \033[31m✗\033[0m %s\n' "$1"; FAILED=1; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
FAILED=0

# ===========================================================================
hdr "Phase 0 — prerequisites (read-only)"

command -v node >/dev/null && pass "node $(node -v)" || fail "node not on PATH"
[ -f "$BUNDLE" ] && pass "bundle: $BUNDLE" || { fail "bundle not found ($BUNDLE) — run: pnpm -C apps/plugin-dev build"; }
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' 2>/dev/null \
  && pass "node >= 20" || warn "node < 20 — sandcastle targets node22"

if command -v gh >/dev/null && gh auth status >/dev/null 2>&1; then
  pass "gh authenticated ($(gh api user --jq .login 2>/dev/null || echo '?'))"
else
  warn "gh not authenticated — Phase 2/3 need it"
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  remote="$(git remote get-url origin 2>/dev/null || echo '')"
  case "$remote" in
    git@*|ssh://*) pass "git SSH remote: $remote" ;;
    "")            warn "no git origin remote" ;;
    *)             warn "non-SSH remote ($remote) — AFK rejects HTTPS remotes" ;;
  esac
else
  warn "not inside a git work tree"
fi

# The agent CLI sandcastle will spawn in Phase 3.
if command -v "$RUNNER" >/dev/null; then
  pass "agent CLI on PATH: $RUNNER"
else
  warn "agent CLI '$RUNNER' not on PATH — Phase 3 (the gate) cannot run"
fi
[ "$SANDBOX" = "none" ] && pass "sandbox: noSandbox (node-only, no Docker)" \
  || { command -v "$SANDBOX" >/dev/null && pass "sandbox: $SANDBOX present" \
       || warn "sandbox '$SANDBOX' selected but not on PATH (need: sandcastle docker build-image)"; }

# ===========================================================================
hdr "Phase 1 — non-agent native commands (zero risk, no sandcastle loaded)"

# These use the lazy-import boundary: sandcastle is NOT loaded for these.
out="$(node "$BUNDLE" monitor --once 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "monitor --once (exit 0)" || fail "monitor --once exit $rc: $out"

out="$(node "$BUNDLE" reap 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "reap (exit 0): $(echo "$out" | head -1)" || fail "reap exit $rc: $out"

out="$(node "$BUNDLE" statusline "$PWD" </dev/null 2>&1)"; rc=$?
[ $rc -eq 0 ] && pass "statusline (exit 0)" || fail "statusline exit $rc: $out"

# Confirm the bash is really gone from the shipped artifact.
if grep -q 'RED_AFK_LEGACY\|spawn("bash"' "$BUNDLE" 2>/dev/null; then
  fail "bundle still references bash fallback — RED_AFK_LEGACY/spawn(bash) present"
else
  pass "no bash fallback in the bundle (native-only)"
fi

# ===========================================================================
hdr "Phase 2 — empty-queue drain (boot + select + precheck, no agent)"

# --boot-only is the honest no-agent dry-run: it runs bootstrap + every boot
# sweep (orphan cleanup, attempt cap, snapshot grace, unblock, straggler) +
# precheck, then exits BEFORE selecting/claiming/spawning. It never reaches
# selection, so it does NOT print NO MORE TASKS — a clean exit 0 with no claim
# is success. (Do NOT use `-n 0` here: in session.ts `-n 0` means unlimited
# drain — 0/undefined caps to the full queue — so it would spawn agents.)
out="$(node "$BUNDLE" run --boot-only 2>&1)"; rc=$?
if [ $rc -eq 0 ]; then
  pass "run --boot-only → clean exit 0 (boot+sweeps+precheck OK, no agent)"
elif echo "$out" | grep -qi 'precheck'; then
  warn "run --boot-only → precheck gate: $(echo "$out" | tail -1) (expected off main / outside a repo)"
else
  fail "run --boot-only unexpected (exit $rc): $(echo "$out" | tail -2)"
fi

# ===========================================================================
hdr "Phase 3 — THE GATE: a real agent iteration through sandcastle"

if [ -z "${AFK_E2E_ISSUE:-}" ]; then
  cat <<EOF
  Skipped — set AFK_E2E_ISSUE to run the real agent path.

  ⚠️  This is the only unvalidated path and it MUTATES a repo. Do it safely:
     1. Use a THROWAWAY test repo (its own SSH gh remote), NOT a real project.
        AFK acts on the current repo's GitHub issues.
     2. Create one trivial issue labelled 'ready-for-agent', e.g.
        "Append a line to README.md", with a short '## Agent brief'.
     3. Have '$RUNNER' installed and authenticated on PATH.
     4. From the test repo's checkout, run:

        AFK_E2E_ISSUE=<N> AFK_E2E_RUNNER=$RUNNER \\
          bash $here/afk-e2e-smoke.sh

  What it will do: claim the issue (label → running) → sandcastle creates a
  worktree and spawns '$RUNNER' → the agent works + emits <promise>DONE</promise>
  → AFK runs the feedback gate → lands via an admin-merged PR → closes the issue
  and posts the terminal envelope.
EOF
  printf '\n'
else
  echo "  Target issue: #$AFK_E2E_ISSUE   runner: $RUNNER   sandbox: $SANDBOX"
  echo "  Repo: $(git remote get-url origin 2>/dev/null || echo '?')"
  if [ "${AFK_E2E_YES:-}" != "1" ]; then
    read -r -p "  This will claim #$AFK_E2E_ISSUE, spawn an agent, open/merge a PR and close it. Continue? [y/N] " ans
    [ "$ans" = "y" ] || { warn "aborted by user"; ans=""; }
  else
    ans="y"
  fi
  if [ "${ans:-}" = "y" ]; then
    log="$(mktemp -t afk-e2e.XXXXXX.log)"
    echo "  running (live log → $log) ..."
    # Single supervised iteration on exactly this issue, pinned runner + sandbox.
    # RED_AFK_SANDBOX overrides afk.sandbox in config (resolveRunSettings), so the
    # docker/podman path is exercised without touching the target repo's config.
    if [ "$SANDBOX" != "none" ]; then export RED_AFK_SANDBOX="$SANDBOX"; fi
    node "$BUNDLE" run --issues "$AFK_E2E_ISSUE" --once --runner "$RUNNER" 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
    echo "  run exit: $rc"
    # Verify the outcome from GitHub, not just the exit code.
    state="$(gh issue view "$AFK_E2E_ISSUE" --json state,labels --jq '.state + " " + (.labels|map(.name)|join(","))' 2>/dev/null || echo '?')"
    echo "  issue #$AFK_E2E_ISSUE now: $state"
    case "$state" in
      CLOSED*) pass "GATE PASSED — issue closed by the native sandcastle path 🎉" ;;
      *running*) fail "issue stuck 'running' — orchestrator died mid-iteration; inspect $log + .red/tmp/workers/*/*/afk.log" ;;
      *ready-for-human*) warn "issue → ready-for-human (BLOCKED/no-sentinel/merge-conflict) — read the envelope on the issue + $log" ;;
      *) warn "issue state '$state' — inspect $log" ;;
    esac
    latest_dir="$(ls -td .red/tmp/workers/*/*/ 2>/dev/null | head -1)"
    echo "  diagnostics: latest worker dir → ${latest_dir:-none}"

    # ---- issue #405: prove the guard + heartbeat armed UNDER ISOLATION --------
    # ADR 0054 lifts the guard + externalized heartbeat from no-sandbox-only to
    # docker/podman (attempt-dir bind-mount makes the worker branch + proof-of-life
    # lane host-visible mid-run). When the gate ran under isolation, prove it
    # end-to-end: the agent ran in a real container AND a periodic heartbeat fired.
    if [ "$SANDBOX" != "none" ] && [ -n "${latest_dir:-}" ]; then
      hdr "Phase 3.5 — issue #405: guard + heartbeat under $SANDBOX isolation"
      # (a) the agent really ran in a container: sandcastle logs a sandcastle-<uuid>
      #     container, and the bind-mount provider creates the worktree on the host.
      if grep -qiE "sandcastle-[0-9a-f-]{8}|docker (run|exec)|podman (run|exec)|container" "$latest_dir/afk.log" "$log" 2>/dev/null; then
        pass "container execution observed in the unified afk.log ($SANDBOX)"
      else
        warn "no explicit container marker in logs — confirm '$SANDBOX run' happened (inspect $latest_dir/afk.log)"
      fi
      # (b) the externalized proof-of-life heartbeat fired under isolation: an
      #     enriched type=heartbeat record in the firehose + last_progress_at state.
      if grep -q '"type":"heartbeat"' "$latest_dir/log.jsonl" 2>/dev/null; then
        pass "type=heartbeat firehose record present under isolation (AC2)"
      else
        warn "no type=heartbeat record in $latest_dir/log.jsonl — short runs may finish before the first ~60s poll; lengthen the test issue"
      fi
      if grep -q 'last_progress_at' "$latest_dir/afk.state.json" 2>/dev/null; then
        pass "current.last_progress_at mirrored into afk.state.json under isolation (AC2)"
      else
        warn "no last_progress_at in $latest_dir/afk.state.json — guard may not have polled (short run)"
      fi
      echo "  Note: AC1 (guard aborts a mid-run stall under $SANDBOX) needs a"
      echo "  deliberately-stalling issue + a low RED_AFK_ATTEMPT_TIMEOUT_S; expect"
      echo "  the issue to land 'ready-for-human' with blocked:stalled."
    fi
  fi
fi

# ===========================================================================
hdr "Result"
if [ "$FAILED" -eq 0 ]; then
  printf '  \033[32mPhases 0-2 green.\033[0m '
  [ -n "${AFK_E2E_ISSUE:-}" ] && echo "Phase 3 ran — see above." || echo "Phase 3 not run (set AFK_E2E_ISSUE for the gate)."
  echo "  Once Phase 3 closes an issue cleanly on noSandbox AND docker, the native"
  echo "  path is validated — remove [skip release] and cut a real release."
else
  printf '  \033[31mSome checks failed — fix before the gate.\033[0m\n'
  exit 1
fi
