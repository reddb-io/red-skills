#!/usr/bin/env bash
# Unit tests for lib/agent-lane.sh — the fanout that turns the runner's
# decoded per-turn stream into the three per-attempt sinks (issue #250):
#   * the back-compat plain afk.log (raw text, byte-for-byte the old tee),
#   * the clean JSONL agent lane (one record per assistant turn, type=agent),
#   * the everything firehose (the same turn as a type=agent record).
#
# The fanout is fed, on stdin, one JSON-encoded string per assistant turn —
# exactly the output of `jq -c 'select(.type=="assistant")…text'` — so newlines
# inside a turn arrive escaped and one line is always one whole turn.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="$HERE/../lib"
# shellcheck source=../lib/agent-lane.sh
source "$LIB_DIR/agent-lane.sh"

TMP_ROOT="$(mktemp -d)"
cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

pass=0
fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1${2:+ ($2)}"; fail=$((fail+1)); }

PLAIN="$TMP_ROOT/afk.log"
AGENT="$TMP_ROOT/agent.log.jsonl"
FIRE="$TMP_ROOT/log.jsonl"

# Two assistant turns, JSON-encoded one per line (as `jq -c` emits them); the
# second turn carries an embedded newline so we prove the line-per-turn contract.
# Capture stdout too — it must mirror the raw text (drop-in for the old tee).
STDOUT_CAP="$TMP_ROOT/stdout.txt"
printf '%s\n' '"writing test for X"' '"line one\nline two"' \
  | agent_lane_fanout "$PLAIN" "$AGENT" "$FIRE" worker=wTEST issue=250 attempt=1 \
  > "$STDOUT_CAP"

# ---------- stdout: byte-for-byte the old tee output (preserves `result`) ----------
if [[ "$(cat "$STDOUT_CAP")" == $'writing test for X\nline one\nline two' ]]; then
  ok "stdout: decoded raw text echoed (drop-in for old tee → result unchanged)"
else
  bad "stdout raw text" "got=$(cat "$STDOUT_CAP" | tr '\n' '|')"
fi

# ---------- plain lane: raw text, back-compat with the old tee ----------
if [[ "$(cat "$PLAIN")" == $'writing test for X\nline one\nline two' ]]; then
  ok "plain lane: decoded raw text with newlines restored"
else
  bad "plain lane raw text" "got=$(cat "$PLAIN" | tr '\n' '|')"
fi

# ---------- agent lane: one record per turn, type=agent, clean ----------
agent_lines="$(wc -l < "$AGENT" | tr -d ' ')"
[[ "$agent_lines" == "2" ]] && ok "agent lane: one record per assistant turn" \
  || bad "agent lane record count" "got=$agent_lines want=2"

if [[ "$(jq -r '.type' "$AGENT" | sort -u)" == "agent" ]]; then
  ok "agent lane: every record is type=agent"
else
  bad "agent lane type" "got=$(jq -rc '[.type]' "$AGENT" | tr '\n' ',')"
fi

first_msg="$(jq -r 'select(.msg=="writing test for X") | .msg' "$AGENT" | head -n1)"
[[ "$first_msg" == "writing test for X" ]] \
  && ok "agent lane: turn text preserved verbatim in msg" \
  || bad "agent lane msg" "got=$first_msg"

multiline_msg="$(jq -rc 'select(.msg | contains("line one")) | .msg' "$AGENT")"
[[ "$multiline_msg" == $'line one\nline two' ]] \
  && ok "agent lane: embedded newline preserved as a single record's msg" \
  || bad "agent lane multiline" "got=$(printf %q "$multiline_msg")"

if [[ "$(jq -rc '[.worker,.issue,.attempt]' "$AGENT" | sort -u)" == '["wTEST",250,1]' ]]; then
  ok "agent lane: identity (worker/issue/attempt) stamped on every record"
else
  bad "agent lane identity" "got=$(jq -rc '[.worker,.issue,.attempt]' "$AGENT" | tr '\n' ',')"
fi

# ---------- firehose: same turns, type=agent, valid JSONL ----------
fire_lines="$(wc -l < "$FIRE" | tr -d ' ')"
[[ "$fire_lines" == "2" ]] && ok "firehose: agent output captured (one per turn)" \
  || bad "firehose record count" "got=$fire_lines want=2"

if jq -e . "$FIRE" >/dev/null 2>&1 \
   && [[ "$(jq -r '.type' "$FIRE" | sort -u)" == "agent" ]]; then
  ok "firehose: agent turns are valid JSONL of type=agent"
else
  bad "firehose agent records"
fi

# ---------- robustness: blank lines skipped, null decodes away ----------
: > "$AGENT"; : > "$FIRE"; : > "$PLAIN"
printf '%s\n' '' '"only turn"' '' | agent_lane_fanout "$PLAIN" "$AGENT" "$FIRE" worker=wTEST issue=250 attempt=1
[[ "$(wc -l < "$AGENT" | tr -d ' ')" == "1" ]] \
  && ok "fanout: blank stream lines are skipped" \
  || bad "blank-line skip" "got=$(wc -l < "$AGENT")"

# ---------- robustness: an empty sink path is silently skipped ----------
: > "$AGENT"
rc=0
printf '%s\n' '"turn"' | agent_lane_fanout "" "$AGENT" "" worker=wTEST issue=250 attempt=1 || rc=$?
[[ "$rc" == "0" && "$(wc -l < "$AGENT" | tr -d ' ')" == "1" ]] \
  && ok "fanout: empty plain/firehose paths skipped, agent lane still written, rc=0" \
  || bad "empty-sink handling" "rc=$rc agent=$(wc -l < "$AGENT")"

echo
echo "agent-lane: $pass passed, $fail failed"
[[ "$fail" -eq 0 ]]
