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

## Exhaustion Detection

Codex signals quota / rate limit exhaustion via:

- Event `{"type":"error", "error":{"code":"rate_limit"|"quota_exceeded", ...}}`.
- Last-message file containing `usage limit`, `weekly cap`, `session exhausted`, or `try again later`.
- Process exit code non-zero combined with a recognised error string on stderr.

On any of those, the orchestrator emits `RUNNER_EXHAUSTED`, preserves the worktree, and swaps to Claude if alternation is enabled. (Since Slice D there is no heartbeat sub-shell to reap.)

## Working Directory

`-C $WORKTREE` pins Codex to the worktree. The handoff file lives at `../handoff.md` (one level above the worktree, inside the iteration directory `.red/tmp/work-{id}-i{N}/`).

## Task Mirror Sink

The native Task mirror (ADR 0003, SKILL.md *Task Mirror*) is runner-specific: the
`state-reader` and `mirror-reconciler` in [`scripts/lib/mirror.sh`](scripts/lib/mirror.sh)
are shared with Claude unchanged; only the sink differs. The Codex sink is
[`mirror_sink_codex`](scripts/lib/mirror.sh):

- It branches on `codex_native_task_available`, the single mockable capability
  probe. Codex ships no native background-task / progress surface today, so the
  probe returns non-zero and the sink **falls back to the `monitor.sh` dashboard
  plus a one-line notice** — no crash, no half-rendered state.
- If a future Codex grows a native surface, override `codex_native_task_available`
  to return 0; the sink then emits the same `mirror_plan` call descriptors the
  Claude sink applies, to be driven against the Codex primitive.

This is an explicit per-runner adapter, not a cross-runner abstraction (rejected
in ADR 0003).

## Fleet Monitor Agent

Codex does expose a native sub-agent UI, but that is not the same as Claude
Code's `TaskCreate` / `TaskUpdate` task surface. `/afk fleet` therefore keeps
the actual workers as supervised OS processes and uses one optional Codex
monitor agent only for presentation.

When a Codex session launches `/dev:afk fleet N`:

- pass `RED_AFK_RUNNER=codex` to `supervisor.sh` so detached workers stay on the
  Codex runner deterministically;
- spawn at most one read-only monitor agent for the newly-started supervisor
  when the sub-agent primitive is available;
- have that monitor agent periodically run
  `bash plugins/dev/skills/engineering/afk/scripts/monitor.sh --once`, report
  concise progress, and exit once no supervisor or live workers remain;
- never let the monitor agent edit files, claim issues, stop workers, run
  validation, merge, or push.

If the sub-agent primitive is unavailable, launch the supervisor anyway and
tell the user to run `/dev:afk monitor` or tail `.red/tmp/afk-supervisor.log`.

## Notes On The Bypass Flags

`--dangerously-bypass-approvals-and-sandbox` is dangerous *only* if the rest of the pipeline isn't enforcing safety. `/afk` enforces:

- Worktree isolation (Codex can't see the primary checkout).
- Forbidden git commands list in `AGENT-PROMPT.md` (the inner agent knows the rules).
- Orchestrator post-checks (test, typecheck, lint, build) before merge.
- Merge happens *outside* the inner agent — Codex never touches the primary checkout's main branch.

If you remove any of those layers, remove these flags first.
