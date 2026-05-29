#!/usr/bin/env bash
# lib/agent-lane.sh — fan the inner agent's turn-text out to the three
# per-attempt sinks the orchestrator keeps (PRD #244, issue #250):
#
#   * the back-compat plain afk.log — raw text, byte-for-byte what the old
#     `… | tee -a "$ITER_LOG"` stage produced, so monitor/reaper/envelope keep
#     reading exactly what they read before (existing behaviour unchanged);
#   * the clean JSONL agent lane — one `type=agent` envelope per assistant
#     turn and nothing synthetic, so it is the true liveness signal and is
#     readable as a live transcript (`tail -f … | jq -r .msg`);
#   * the everything firehose — the same turn as a `type=agent` record, joining
#     the heartbeat vitals / hook / timing / error records the orchestrator
#     also writes there.
#
# The runner pipeline (run_claude / run_codex in afk.sh) already decodes the
# runner's stream-json into one *JSON-encoded string per assistant turn* — i.e.
# the output of `jq -c 'select(.type=="assistant").message.content[]? |
# select(.type=="text").text // empty'`: one compact JSON string per line, with
# any newline inside a turn escaped as `\n`. This module is fed that stream on
# stdin, so one input line is always one whole turn and the runner pipeline
# stays a single composable stage while the fanout is unit-testable in
# isolation (scripts/tests/agent-lane.test.sh).
#
# The envelope writers come from lib/jsonl-log.sh: jsonl_log_append_agent for
# the agent lane (single writer — this fanout only — so a plain append, and it
# rejects any synthetic type by contract) and jsonl_log_append_shared for the
# firehose (multi-writer within an attempt, so flock-serialised). The module
# sources jsonl-log.sh relatively
# when those are not already in scope, exactly as lib/attempt-ledger.sh sources
# lib/worker-paths.sh.
#
# Public surface:
#   agent_lane_fanout <plain_log> <agent_lane> <firehose> [KEY=VALUE]...
#     Read stdin line by line; each line is one JSON-encoded assistant turn.
#     For each turn, decode it back to raw text and:
#       * echo "<text>\n" to STDOUT — so the fanout is a drop-in for the old
#         `tee -a "$ITER_LOG"` final stage and the runner pipeline's stdout
#         (captured as the inner agent's `result` for sentinel detection) is
#         byte-for-byte unchanged;
#       * append "<text>\n" to <plain_log> — the back-compat afk.log, exactly
#         what the old tee wrote (skipped when <plain_log> is "" or /dev/null);
#       * append one type=agent envelope to <agent_lane>;
#       * append one type=agent envelope to <firehose>
#         (each lane skipped when its path is "").
#     Identity KEY=VALUE pairs (worker=, issue=, attempt=) are forwarded
#     verbatim to both envelopes. Blank input lines and turns that decode to
#     null/empty are skipped. Always returns 0 — a logging failure must never
#     break the runner pipeline that feeds it.

# Source the envelope writers if not already in scope (standalone / test use).
if ! declare -F jsonl_log_append_agent >/dev/null 2>&1; then
  _agent_lane_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  # shellcheck source=./jsonl-log.sh
  source "$_agent_lane_dir/jsonl-log.sh"
fi

# agent_lane_fanout <plain_log> <agent_lane> <firehose> [KEY=VALUE]...
agent_lane_fanout() {
  local plain="$1" agent_lane="$2" firehose="$3"
  shift 3
  local line text
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -n "$line" ]] || continue
    # Decode the JSON-encoded turn back to its raw text. A turn that decodes to
    # null/empty (or fails to parse) is dropped — never written to any lane.
    text="$(jq -r '. // empty' <<<"$line" 2>/dev/null)" || continue
    [[ -n "$text" ]] || continue
    # Echo to stdout so this stage is a drop-in for the old `tee -a` and the
    # pipeline's captured stdout (the inner agent's `result`) is unchanged.
    printf '%s\n' "$text"
    if [[ -n "$plain" && "$plain" != "/dev/null" ]]; then
      printf '%s\n' "$text" >> "$plain" || true
    fi
    if [[ -n "$agent_lane" ]]; then
      jsonl_log_append_agent "$agent_lane" "$text" "$@" 2>/dev/null || true
    fi
    if [[ -n "$firehose" ]]; then
      # Firehose is multi-writer within an attempt (this fanout + the heartbeat
      # loop + the orchestrator's timing/error/hook records all append it
      # concurrently), so it must go through the flock-serialised appender to
      # never interleave a line. The agent lane above is single-writer (this
      # fanout only), so its plain append is correct.
      jsonl_log_append_shared "$firehose" agent "$text" "$@" 2>/dev/null || true
    fi
  done
  return 0
}
