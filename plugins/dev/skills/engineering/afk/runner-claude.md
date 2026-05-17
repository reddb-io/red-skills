# Runner: Claude

How `/afk` invokes Claude as the inner agent for one issue.

## Spawn Command

```bash
claude \
  --model opus \
  --effort medium \
  --permission-mode acceptEdits \
  --output-format stream-json \
  --verbose \
  --print \
  "$full_prompt"
```

`$full_prompt` is built by the orchestrator as:

```
Drop file:
<contents of .red/tmp/drop-N-slug.md>

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

On any of those, the orchestrator emits the internal `RUNNER_EXHAUSTED` signal, kills the heartbeat, preserves the worktree, and swaps to Codex if alternation is enabled.

## Working Directory

Claude is invoked with the worktree as `cwd`. It has filesystem access only inside that worktree. Do not pass paths outside it.

## Drop File Contract

Claude reads `./.red/tmp/drop-{N}-{slug}.md` at the start of its session. The orchestrator does not pass file contents in the prompt itself — only the relative path and the instruction to read it. Keeps the context window lean.

## Notes On Permissions

`acceptEdits` lets Claude edit files without prompting but still requires confirmation for shell commands the policy considers risky. That's intentional — the safety policy is a backstop even when the inner agent is "trusted".
