# Runner: Claude

> **Unattended posture.** What makes this Agent able to work with nobody at the
> keyboard — and the evidence behind it — is
> [`runner-unattended-posture.md`](./runner-unattended-posture.md).

How `/afk` invokes Claude as the inner agent for one issue.

## Spawn Command

```bash
claude \
  --model opus \
  --effort medium \
  --permission-mode bypassPermissions \
  --output-format stream-json \
  --verbose \
  --print \
  "$full_prompt"
```

`$full_prompt` is built by the orchestrator as:

```
Handoff file: <absolute path to .red/tmp/workers/{id}/{N}-a{n}/handoff.md>

Recent commits on main:
<git log -n 5 --format="%H%n%ad%n%B---" --date=short>

<contents of AGENT-PROMPT.md>
```

The shell stream is piped through `jq` to extract assistant text for display and the final result string for sentinel detection.

## Stdout Parsing

`stream-json` produces one JSON object per line. The two filters used:

```jq
# Live stream for header and stage detection:
select(.type == "assistant").message.content[]?
  | select(.type == "text").text // empty
  | gsub("\n"; "\r\n") | . + "\r\n\n"

# Final result for sentinel detection:
select(.type == "result").result // empty
```

The orchestrator checks the final result for `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`.

## Exhaustion Detection

Claude signals rate limit / quota exhaustion in any of these ways:

- Top-level JSON `{"type":"error","error":{"type":"rate_limit_error", ...}}`.
- Final result string containing `Claude usage limit reached`, `weekly limit`, `session limit`, or `quota`.
- Process exit code 429 or 503.

On any of those, the orchestrator emits the internal `RUNNER_EXHAUSTED` signal, preserves the worktree, and swaps to Codex if alternation is enabled. (Since Slice D there is no heartbeat sub-shell to reap.)

## Working Directory

Claude is invoked with the worktree as `cwd`. It has filesystem access only inside that worktree. Do not pass paths outside it.

## Handoff File Contract

Claude reads the handoff file path passed in the prompt at the start of its session. The file lives one level above the worktree, at `.red/tmp/workers/{id}/{N}-a{n}/handoff.md`, so it survives runner retries.

## Notes On Permissions

`bypassPermissions` is required because `/afk` runs unattended. The safety policy is enforced by worktree isolation, the forbidden git command list in `AGENT-PROMPT.md`, and orchestrator validation before merge.
