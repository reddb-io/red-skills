#!/usr/bin/env bash
# Unit tests for detect_runner — the runner-detection cascade introduced for #8.
#
# afk.sh is sourced for its function definitions; the orchestrator's main
# block stays dormant thanks to the BASH_SOURCE guard at the bottom of afk.sh.

set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AFK_SH="$HERE/../afk.sh"

# Sourcing afk.sh runs its arg-parsing, but with no args it falls through and
# only defines functions + globals. We then call detect_runner directly.
# shellcheck disable=SC1090
source "$AFK_SH"

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

# Clean slate — wipe every var the cascade inspects so this test file is
# robust against the harness inheriting one from the user's shell.
unset CLAUDECODE CLAUDE_CODE_ENTRYPOINT CLAUDE_CODE_SSE_PORT
unset CODEX_HOME CODEX_SANDBOX CODEX_SANDBOX_NETWORK_DISABLED CODEX_MANAGED_BY_NPM
unset RED_AFK_RUNNER

# 1) Explicit pin wins over everything.
CLAUDECODE=1 expect_eq "pin beats env-var (claude)" "$(detect_runner claude /tmp/whatever '')" "claude|pin"
CODEX_HOME=/tmp expect_eq "pin beats env-var (codex)" "$(detect_runner codex /tmp/whatever '')" "codex|pin"
expect_eq "pin with neutral state"             "$(detect_runner claude /tmp/whatever '')" "claude|pin"

# 2) Env-var sniff (claude family).
expect_eq "CLAUDECODE → claude|env-var"           "$(CLAUDECODE=1 detect_runner '' /tmp/whatever '')"             "claude|env-var"
expect_eq "CLAUDE_CODE_ENTRYPOINT → claude"       "$(CLAUDE_CODE_ENTRYPOINT=cli detect_runner '' /tmp/whatever '')" "claude|env-var"
expect_eq "CLAUDE_CODE_SSE_PORT → claude"         "$(CLAUDE_CODE_SSE_PORT=4000 detect_runner '' /tmp/whatever '')" "claude|env-var"

# 3) Env-var sniff (codex family).
expect_eq "CODEX_HOME → codex|env-var"            "$(CODEX_HOME=/x detect_runner '' /tmp/whatever '')"            "codex|env-var"
expect_eq "CODEX_SANDBOX → codex|env-var"         "$(CODEX_SANDBOX=1 detect_runner '' /tmp/whatever '')"          "codex|env-var"
expect_eq "CODEX_SANDBOX_NETWORK_DISABLED → codex" "$(CODEX_SANDBOX_NETWORK_DISABLED=1 detect_runner '' /tmp/whatever '')" "codex|env-var"
expect_eq "CODEX_MANAGED_BY_NPM → codex"          "$(CODEX_MANAGED_BY_NPM=1 detect_runner '' /tmp/whatever '')" "codex|env-var"

# 4) Process-tree sniff. This catches repo-local skill copies where the path is neutral.
expect_eq "process tree codex → codex|process"    "$(detect_runner '' /opt/random/path '3259985 codex /home/u/.asdf/bin/codex')" "codex|process"
expect_eq "process tree claude → claude|process"  "$(detect_runner '' /opt/random/path '9988 claude /home/u/.local/bin/claude')" "claude|process"

# 5) Path sniff. Env vars and process snapshot absent.
expect_eq "path under ~/.claude/ → claude|path"   "$(detect_runner '' /home/u/.claude/plugins/dev/skills/engineering/afk/scripts '')" "claude|path"
expect_eq "path under ~/.codex/  → codex|path"    "$(detect_runner '' /home/u/.codex/plugins/dev/skills/engineering/afk/scripts '')"  "codex|path"

# 6) Env fallback. Absent env, neutral path, neutral process snapshot.
expect_eq "no signal → claude (default fallback)" "$(detect_runner '' /opt/random/path '')" "claude|env-fallback"
expect_eq "RED_AFK_RUNNER=codex respected"        "$(RED_AFK_RUNNER=codex detect_runner '' /opt/random/path '')" "codex|env-fallback"

# 7) Earlier stages dominate later stages (cascade order).
expect_eq "env-var beats process/path"            "$(CLAUDECODE=1 detect_runner '' /home/u/.codex/x '3259985 codex /bin/codex')" "claude|env-var"
expect_eq "process beats path"                    "$(detect_runner '' /home/u/.claude/x '3259985 codex /bin/codex')" "codex|process"

# ---------- summary ----------
echo
echo "summary: $pass passed, $fail failed"
[[ $fail -eq 0 ]]
