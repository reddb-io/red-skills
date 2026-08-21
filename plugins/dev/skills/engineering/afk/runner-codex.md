# Runner: Codex

> **Unattended posture.** What makes this Agent able to work with nobody at the
> keyboard — and the evidence behind it — is
> [`runner-unattended-posture.md`](./runner-unattended-posture.md).

How `/afk` invokes Codex as the inner agent for one issue.

## Spawn Command

```bash
codex exec \
  --model "$model" \
  -c "model_reasoning_effort=$effort" \
  --json \
  -C "$WORKTREE" \
  --sandbox danger-full-access \
  --dangerously-bypass-approvals-and-sandbox \
  --output-last-message "$last_msg_file" \
  "$full_prompt" \
  </dev/null
```

`$model` and `$effort` come from the resolved `afk.models.codex.<tier>` entry.
Codex receives effort through its `model_reasoning_effort` config override
because the CLI exposes model as a direct flag and reasoning effort as config.
`$full_prompt` matches the Claude runner — handoff file path + recent commits +
AGENT-PROMPT.md body. `$last_msg_file` is a temp file the orchestrator reads
after the process exits.

The bypass flags are required because the inner agent must run unattended; the policy enforcement comes from [`SAFETY.md`](SAFETY.md), not from Codex's interactive approvals.

## Stdout Parsing

Codex `--json` is expected to emit structured events, but some builds print a
non-JSON banner/status line before the JSONL stream. The orchestrator first
keeps the raw stream for forensics, then filters to lines beginning with `{`
before handing events to `jq`. The relevant JSON event is:

```jq
# Live stream for header and stage detection:
select(.type == "item.completed") | .item.text // empty
  | gsub("\n"; "\r\n") | . + "\r\n\n"
```

Final result is read from `--output-last-message`. The orchestrator checks it for `<promise>DONE</promise>` or `<promise>BLOCKED</promise>`.

## Uncommitted Work Is Disposable

AGENT-PROMPT (Workflow step 5) requires the inner agent to commit its work — one
commit per file — before emitting a sentinel. Codex does not always comply: it
can edit the worktree, run the gates, and emit `<promise>DONE</promise>` while
leaving some or all paths uncommitted.

**Nothing rescues that.** ADR 0103 retired the exit-time salvage commit: the
engine never commits dirty worktree paths on the way out, so an uncommitted diff
dies with the worktree. What survives is exactly what the agent committed — the
continuous-push hook (issue #191) sends each commit to origin as it is made — plus
the terminal Envelope, which is the forensic record of what happened. Prompt
compliance is therefore the only guarantee: the agent must commit before it
signals.

## Exhaustion Detection

Codex signals quota / rate limit exhaustion via:

- Event `{"type":"error", "error":{"code":"rate_limit"|"quota_exceeded", ...}}`.
- Last-message file containing `usage limit`, `weekly cap`, `session exhausted`, or `try again later`.
- Process exit code non-zero combined with a recognised error string on stderr.

On any of those, the orchestrator emits `RUNNER_EXHAUSTED`, preserves the worktree, and swaps to Claude if alternation is enabled. (Since Slice D there is no heartbeat sub-shell to reap.)

## Working Directory

`-C $WORKTREE` pins Codex to the worktree. The handoff file lives at `../handoff.md` (one level above the worktree, inside the worker directory `.red/tmp/workers/{id}/{N}-a{n}/`).

## Task Mirror Sink

The native Task mirror (ADR 0003, SKILL.md *Task Mirror*) is runner-specific: the
state reader and plan reconciler are shared with Claude unchanged; only the sink
differs. The Codex sink:

- branches on the Codex native-task capability probe. Codex ships no native
  background-task / progress surface today, so the probe is negative and the sink
  **falls back to the `monitor` dashboard plus a one-line notice** — no crash, no
  half-rendered state.
- If a future Codex grows a native surface, the probe goes positive; the sink then
  emits the same call-plan descriptors the Claude sink applies, to be driven
  against the Codex primitive.

This is an explicit per-runner adapter, not a cross-runner abstraction (rejected
in ADR 0003).

## Monitor Agent

Codex does expose a native sub-agent UI, but that is not the same as Claude
Code's `TaskCreate` / `TaskUpdate` task surface. `/afk run` and `/afk fleet`
therefore keep the actual workers as supervised OS processes and use one
optional Codex monitor agent only for presentation.

When a Codex session launches a normal detached `/dev:afk run` worker:

- skip the monitor agent for `--once` and `--boot-only`, because no background
  worker needs a separate presentation surface;
- fetch a sub-agent spawn primitive when the host exposes one;
- generate the monitor-agent prompt with:
  `afk codex-monitor-agent --project-root "$PWD" --mode run`;
- spawn at most one read-only monitor agent for the newly-started worker;
- have that monitor agent periodically run `/dev:afk monitor --once`, report
  concise progress, and exit once no supervisor or live workers remain;
- never let the monitor agent edit files, claim issues, stop workers, run
  validation, merge, push, or repair state.

When a Codex session launches `/dev:afk fleet N`:

- launch `/dev:afk fleet N --runner codex` or invoke the bundle with
  `RED_AFK_RUNNER=codex` so detached workers stay on the Codex runner
  deterministically;
- generate the monitor-agent prompt with:
  `afk codex-monitor-agent --project-root "$PWD" --mode fleet`;
- spawn at most one read-only monitor agent for the newly-started supervisor when
  the sub-agent primitive is available;
- have that monitor agent periodically run `/dev:afk monitor --once`, report
  concise progress, and exit once no supervisor or live workers remain;
- never let the monitor agent edit files, claim issues, stop workers, run
  validation, merge, push, or repair state.

If the sub-agent primitive is unavailable, launch the supervisor anyway and
tell the user to run `/dev:afk monitor` or tail `.red/tmp/supervisors/default/supervisor.log.toonl`.

## Notes On The Bypass Flags

`--dangerously-bypass-approvals-and-sandbox` is dangerous *only* if the rest of the pipeline isn't enforcing safety. `/afk` enforces:

- Worktree isolation (Codex can't see the primary checkout).
- Forbidden git commands list in `AGENT-PROMPT.md` (the inner agent knows the rules).
- Orchestrator post-checks (test, typecheck, lint, build) before merge.
- Merge happens *outside* the inner agent — Codex never touches the primary checkout's main branch.

If you remove any of those layers, remove these flags first.
