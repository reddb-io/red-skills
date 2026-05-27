#!/usr/bin/env bash
# lib/capabilities.sh — runner capability detection and run-mode selection
# for /afk dispatch (PRD #196, issue #202).
#
# The orchestrator calls capabilities_detect once per iteration to probe the
# active runner against a fixed set of capability axes:
#
#   native_agents       1 = runner exposes first-class sub-agent dispatch and
#                           the production phase agents are shipped on disk
#                           (plugins/dev/agents/{issue-analyzer,task-executor,
#                           quality-gate}.md). 0 otherwise.
#   structured_output   1 = runner streams structured events (claude
#                           stream-json, codex --json JSONL). 0 = plain stdout.
#   resume_session      1 = runner has a documented session resume / replay
#                           API the orchestrator could lean on. AFK does not
#                           require this today; it's reported for downstream
#                           consumers.
#   worktree_support    1 = git worktree available in PATH. The runner never
#                           opens worktrees itself — this is a host probe — but
#                           it stays in the capability matrix so monitor and
#                           state output can flag environments that lack it.
#   hooks_events        1 = runner has a hook surface RedSkills can write to
#                           (claude: hooks.json with Stop/PreToolUse/etc;
#                           codex: hooks.json with PreToolUse only).
#   permission_modes    1 = runner exposes a safe-permission flag the
#                           orchestrator passes today (claude
#                           --permission-mode bypassPermissions, codex
#                           --sandbox + --dangerously-bypass-approvals-and-
#                           sandbox).
#
# The probe is intentionally cheap: no `claude --version` / `codex --version`
# spawn during dispatch — we read what the AFK skill already knows about each
# runner from runner-{claude,codex}.md plus a single filesystem check for
# native_agents. Per-version capability surfaces evolve slowly; spawning the
# binary just to learn what the docs already say burns tokens and adds a
# failure mode.
#
# capabilities_select_mode takes the runner identity, the capabilities, and
# an optional --fallback-only flag, and echoes the selected mode:
#
#   claude-native      Claude Code with native sub-agent dispatch (#197) and
#                      the production phase agents available. Highest fidelity
#                      to the cross-runner AFK contract.
#   claude-basic       Claude Code without native sub-agents — single session,
#                      inline phases, sentinel-driven completion. Current
#                      production default for claude.
#   codex-phased       Codex CLI Option C+: single `codex exec` with inline
#                      phase prompts emitting fenced JSON envelopes (#204 §4).
#                      Active when phase prompts are shipped at
#                      $SKILL_DIR/phases/codex/{analyze,verify,finalize}.md.
#   codex-basic        Codex CLI with the unified AGENT-PROMPT.md body and
#                      sentinel completion. Current production default for
#                      codex.
#   hermes-fallback    Neutral fallback when the active runner identity is
#                      something other than `claude` or `codex` (or when the
#                      orchestrator explicitly degrades). Treats the runner as
#                      an opaque executor of the AGENT-PROMPT.md body, keeps
#                      the sentinel contract, and surrenders every advanced
#                      surface (no structured output, no native agents, no
#                      hooks).
#
# Native and phased modes degrade *down* to their basic counterparts when the
# required artefacts are absent. This is what makes #202 land safely while
# #199/#200/#201 are still rolling production wiring — the dispatch picks the
# best path the environment can satisfy, never a path that needs files we
# haven't shipped yet.
#
# Public surface:
#   capabilities_detect <runner>
#     Emits KEY=value lines on stdout. Always exits 0. Reads $SKILL_DIR for
#     the native-agent file probe; if unset, the probe defaults to 0.
#
#   capabilities_select_mode <runner> [key=value ...]
#     Echoes the mode string. Capability key=value pairs come from
#     capabilities_detect output; missing keys default to 0.
#
#   capabilities_dispatch_log <runner> <mode> <caps_kv>
#     Renders the one-line summary the orchestrator prints to afk.log and
#     stores in state.

# capabilities_detect <runner>
capabilities_detect() {
  local _runner="${1:-}"
  local _skill_dir="${SKILL_DIR:-${CAPABILITIES_SKILL_DIR:-}}"
  local _agents_dir="${CAPABILITIES_AGENTS_DIR:-}"
  if [[ -z "$_agents_dir" && -n "$_skill_dir" ]]; then
    # Walk up from the afk skill to the plugin root, then into agents/.
    # SKILL_DIR is .../plugins/dev/skills/engineering/afk → plugin root is
    # .../plugins/dev, which holds the production agents/ tree.
    _agents_dir="$_skill_dir/../../../agents"
  fi

  local _native=0 _structured=0 _resume=0 _worktree=0 _hooks=0 _perm=0
  local _phased=0

  case "$_runner" in
    claude)
      _structured=1
      _resume=1
      _hooks=1
      _perm=1
      # Native agents only count when all three production phase files are
      # present. A partial set means downstream wiring is incomplete and the
      # dispatcher should degrade to claude-basic, never to a half-native
      # path that calls one phase and inlines the rest.
      if [[ -n "$_agents_dir" \
            && -f "$_agents_dir/issue-analyzer.md" \
            && -f "$_agents_dir/task-executor.md" \
            && -f "$_agents_dir/quality-gate.md" ]]; then
        _native=1
      fi
      ;;
    codex)
      _structured=1
      _resume=0   # no documented session-resume primitive on Codex today
      _hooks=1
      _perm=1
      # Phased mode is active when the codex inline-phase prompts ship at
      # $SKILL_DIR/phases/codex/*.md. The orchestrator can read them and
      # concatenate them with the handoff brief.
      local _phase_dir="${CAPABILITIES_CODEX_PHASE_DIR:-}"
      if [[ -z "$_phase_dir" && -n "$_skill_dir" ]]; then
        _phase_dir="$_skill_dir/phases/codex"
      fi
      if [[ -n "$_phase_dir" \
            && -f "$_phase_dir/analyze.md" \
            && -f "$_phase_dir/verify.md" \
            && -f "$_phase_dir/finalize.md" ]]; then
        _phased=1
      fi
      ;;
    *)
      # Unknown runner — assume nothing. The dispatcher will route to
      # hermes-fallback. Structured output is the one field we still flip
      # to 1 if the operator explicitly opted in via RED_AFK_RUNNER_HAS_JSON
      # so a custom runner that mimics codex JSON can still be parsed.
      [[ "${RED_AFK_RUNNER_HAS_JSON:-0}" == "1" ]] && _structured=1
      ;;
  esac

  # git worktree probe — host capability, identical across runners. Cached
  # in CAPABILITIES_HAS_WORKTREE for the lifetime of the process so we don't
  # re-spawn git on every iteration.
  if [[ -n "${CAPABILITIES_HAS_WORKTREE:-}" ]]; then
    _worktree="$CAPABILITIES_HAS_WORKTREE"
  elif command -v git >/dev/null 2>&1 \
       && git worktree --help >/dev/null 2>&1; then
    _worktree=1
  fi

  printf 'native_agents=%s\n'     "$_native"
  printf 'structured_output=%s\n' "$_structured"
  printf 'resume_session=%s\n'    "$_resume"
  printf 'worktree_support=%s\n'  "$_worktree"
  printf 'hooks_events=%s\n'      "$_hooks"
  printf 'permission_modes=%s\n'  "$_perm"
  printf 'phased_mode=%s\n'       "$_phased"
}

# capabilities_select_mode <runner> [key=value ...]
# Reads the capability KV pairs and echoes the run mode.
capabilities_select_mode() {
  local _runner="${1:-}"
  shift || true

  local _native=0 _phased=0
  local _kv _k _v
  for _kv in "$@"; do
    [[ "$_kv" == *"="* ]] || continue
    _k="${_kv%%=*}"
    _v="${_kv#*=}"
    case "$_k" in
      native_agents) _native="$_v" ;;
      phased_mode)   _phased="$_v" ;;
    esac
  done

  # Operator can force the basic / fallback path with RED_AFK_RUN_MODE.
  # Accepted values: native | basic | phased | fallback | auto.
  case "${RED_AFK_RUN_MODE:-auto}" in
    fallback)
      printf 'hermes-fallback\n'; return 0 ;;
    basic)
      case "$_runner" in
        claude) printf 'claude-basic\n'; return 0 ;;
        codex)  printf 'codex-basic\n';  return 0 ;;
        *)      printf 'hermes-fallback\n'; return 0 ;;
      esac ;;
    native)
      # Honour the request only if the env can satisfy it.
      [[ "$_runner" == "claude" && "$_native" == "1" ]] && { printf 'claude-native\n'; return 0; }
      ;;
    phased)
      [[ "$_runner" == "codex" && "$_phased" == "1" ]] && { printf 'codex-phased\n'; return 0; }
      ;;
  esac

  case "$_runner" in
    claude)
      if [[ "$_native" == "1" ]]; then
        printf 'claude-native\n'
      else
        printf 'claude-basic\n'
      fi
      ;;
    codex)
      if [[ "$_phased" == "1" ]]; then
        printf 'codex-phased\n'
      else
        printf 'codex-basic\n'
      fi
      ;;
    *)
      printf 'hermes-fallback\n'
      ;;
  esac
}

# capabilities_dispatch_log <runner> <mode> <kv...>
# Build a single human-readable line for afk.log.
capabilities_dispatch_log() {
  local _runner="$1" _mode="$2"; shift 2
  local _line="dispatch: runner=${_runner} mode=${_mode}"
  local _kv
  for _kv in "$@"; do
    _line+=" ${_kv}"
  done
  printf '%s\n' "$_line"
}
