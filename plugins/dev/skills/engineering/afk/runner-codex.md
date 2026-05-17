# Runner: Codex

How `/afk` invokes Codex as the inner agent for one issue.

## Spawn Command

```bash
codex exec \
  --json \
  -C "$WORKTREE" \
  --sandbox danger-full-access \
  --dangerously-bypass-approvals-and-sandbox \
  --output-last-message "$last_msg_file" \
  "$full_prompt" \
  </dev/null
```

`$full_prompt` matches the Claude runner — handoff file path + recent commits + AGENT-PROMPT.md body. `$last_msg_file` is a temp file the orchestrator reads after the process exits.

The bypass flags are required because the inner agent must run unattended; the policy enforcement comes from [`SAFETY.md`](SAFETY.md), not from Codex's interactive approvals.

## Stdout Parsing

Codex `--json` emits structured events. The relevant one:

```jq
# Live stream for header and stage detection:
select(.type == "item.completed") | .item.text // empty
  | gsub("\n"; "\r\n") | . + "\r\n\n"
```

Final result is read from `--output-last-message`. The orchestrator checks it for `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`.

## Exhaustion Detection

Codex signals quota / rate limit exhaustion via:

- Event `{"type":"error", "error":{"code":"rate_limit"|"quota_exceeded", ...}}`.
- Last-message file containing `usage limit`, `weekly cap`, `session exhausted`, or `try again later`.
- Process exit code non-zero combined with a recognised error string on stderr.

On any of those, the orchestrator emits `RUNNER_EXHAUSTED`, kills heartbeat, preserves the worktree, and swaps to Claude if alternation is enabled.

## Working Directory

`-C $WORKTREE` pins Codex to the worktree. The handoff file lives at `../handoff.md` (one level above the worktree, inside the iteration directory `.red/tmp/work-{id}-i{N}/`).

## Notes On The Bypass Flags

`--dangerously-bypass-approvals-and-sandbox` is dangerous *only* if the rest of the pipeline isn't enforcing safety. `/afk` enforces:

- Worktree isolation (Codex can't see the primary checkout).
- Forbidden git commands list in `AGENT-PROMPT.md` (the inner agent knows the rules).
- Orchestrator post-checks (test, typecheck, lint, build) before merge.
- Merge happens *outside* the inner agent — Codex never touches the primary checkout's main branch.

If you remove any of those layers, remove these flags first.
