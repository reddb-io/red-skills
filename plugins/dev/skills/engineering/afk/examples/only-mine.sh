#!/usr/bin/env bash
# only-mine.sh — example post_pick hook for /afk.
#
# Narrows the queue to issues authored by $RED_AFK_GITHUB_LOGIN. Wire it in
# .red/config.yaml under `afk.hooks.post_pick`:
#
#   afk:
#     hooks:
#       post_pick:
#         - "RED_AFK_GITHUB_LOGIN=$(gh api user --jq .login) \
#            plugins/dev/skills/engineering/afk/examples/only-mine.sh"
#
# Contract (PRD #207, issue #210):
#   stdin  — JSON object: `{ "issues": [ { number, title, labels, body, author, … } ] }`
#   stdout — empty (context unchanged) OR a JSON object whose `.issues`
#            replaces the queue. Extra keys are ignored by AFK.
#   exit   — non-zero is logged; AFK falls back to the un-mutated list.
#
# When $RED_AFK_GITHUB_LOGIN is unset we exit 0 with empty stdout so the
# queue is preserved — declaring this hook becomes a no-op rather than a
# silent queue wipe.

set -euo pipefail

login="${RED_AFK_GITHUB_LOGIN:-}"
if [[ -z "$login" ]]; then
  exit 0
fi

jq -c --arg login "$login" '
  {issues: ((.issues // []) | map(select((.author.login // "") == $login)))}
'
