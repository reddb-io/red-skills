# Runner: Hermes / Fallback

How `/afk` treats an inner agent that is neither Claude Code nor Codex CLI.

## When This Mode Is Active

`hermes-fallback` is the run mode the capability dispatcher selects when:

- The detected runner identity is something other than `claude` or `codex` (i.e. a custom backend the operator pinned via `RED_AFK_RUNNER=<name>`), OR
- The operator explicitly forces it with `RED_AFK_RUN_MODE=fallback`.

It is the runner-neutral floor described in [`.red/contracts/afk-task.md`](../../../../.red/contracts/afk-task.md): the cross-runner contract assumes nothing about the executor beyond reading the handoff file, executing the work, and emitting the `<promise>DONE</promise>` / `<promise>BLOCKED</promise>` sentinel.

## What Hermes Does Not Provide

Hermes is the smallest possible inner-agent surface. By construction it has no:

- structured event stream (no `stream-json`, no `--json` JSONL);
- native sub-agent / phase delegation;
- documented session resume / replay API;
- hook/event surface beyond `AGENT-PROMPT.md`'s own rules;
- runner-level permission-mode flag — sandboxing is the host's concern.

Any of those surfaces a real backend exposes should be wired through the `claude` or `codex` capability path instead.

## Spawn Contract

The orchestrator does not ship a third spawn implementation today. When a user pins an unknown runner, `run_inner` falls through to whichever existing process backend (`run_claude` / `run_codex`) the `runner` parameter actually names, so the dispatch decision is purely advisory metadata. A real Hermes integration would slot in next to `run_claude` / `run_codex` in [`scripts/afk.sh`](scripts/afk.sh) and reuse the same prompt body, the same sentinel watchdog, and the same envelope writer.

## Working Directory

Hermes is expected to honour the worktree-as-cwd contract just like Claude and Codex: the handoff file is read from `../handoff.md` relative to the worktree, and no path outside the worktree is touched. Worktree isolation is the load-bearing safety primitive on this mode because none of the runner-level safety flags are available.

## Lifecycle Signalling

- `<promise>DONE</promise>` — last line of the runner's final message → orchestrator merges per *Per-Issue Loop*.
- `<promise>BLOCKED</promise>` — last line → orchestrator flips the issue to `ready-for-human` and posts the blocker envelope from `<agent-notes>`.
- Anything else → `no-sentinel` envelope. The orchestrator logs the tail of stdout, captures `<agent-notes>`, and re-labels `ready-for-human`.

Exhaustion detection is best-effort: the orchestrator scans the captured result for the same string set Claude and Codex emit (`usage limit`, `weekly cap`, `session exhausted`, `try again later`, `quota`, `rate_limit_error`). A Hermes integration that uses different wording should extend the regex in `run_inner` rather than invent a new signal.
