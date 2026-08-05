# AFK terminal-event envelope, stage detection, live header, state file (reference)

> Extracted from `afk/SKILL.md` for progressive disclosure. Consulted on demand — not the agent's step-by-step loop.
>
> The wire formats: the per-terminal-event issue comment (schema Slice C depends on), how stages are read off the agent stream, the live terminal header, and the `afk.state.json` schema.

## Terminal-Event Envelope

Every terminal event of an iteration posts **exactly one** structured comment on the issue. The comment is the canonical record of what the worker saw and did, and a future Slice C parser will reconstruct iteration history by walking these envelopes in a thread.

Envelope statuses are the wire-level `data-attempt-status` facet. They are intentionally coarser than the full Attempt Outcome vocabulary below: several outcomes emit a `blocked` envelope, and some short-circuit outcomes record labels/history without a per-issue terminal envelope.

| `data-attempt-status` | trigger |
|---|---|
| `blocked` | generic failure envelope: spec block, validation failure, or another failure folded into the blocked bucket |
| `no-sentinel` | inner agent exited without `DONE` or `BLOCKED` and the path emits the crash envelope |
| `merge-conflict` | orchestrator could not merge to `main` |
| `done` | success — merged, closing envelope |
| `discarded` | supervisor slot/circuit discard envelope |

Attempt Outcome is the runtime's terminal vocabulary. It owns the typed `blocked:<reason>` label, recovery policy key, and envelope-status mapping:

| Attempt Outcome | `data-attempt-status` | typed label | recovery |
|---|---|---|---|
| `done` | `done` | none | none |
| `blocked` | `blocked` | `blocked:spec` | none |
| `no-sentinel` | `no-sentinel` | `blocked:crashed` | `crashed` |
| `merge-conflict` | `merge-conflict` | `blocked:merge-conflict` | `merge-conflict` |
| `feedback-failed` | `blocked` | `blocked:validation` | none |
| `hook-aborted` | `blocked` | `blocked:policy` | `policy` |
| `exhausted` | `blocked` | `blocked:quota` | `quota` |
| `runner-transient` | `blocked` | `blocked:runner-transient` | `runner-transient` |
| `stalled` | `blocked` | `blocked:stalled` | none |
| `wall-clock-capped` | `wall-clock-capped` | `blocked:wall-clock-capped` | none (the supervisor owns the bounded re-queue) |
| `infra` | `blocked` | `blocked:infra` | none |
| `claim-lost` | `blocked` | none | none |

Schema (deterministic — Slice C depends on this shape):

```html
<details data-attempt-status="blocked"><summary>worker `wZ2R4` · status: blocked · duration: 2m5s · diff: +42 -10 · attempt: 1</summary>

<details data-section="notes"><summary>notes</summary>

…handoff `<agent-notes>` body…

</details>

</details>
```

Per-status body sections:

- `blocked` → one `data-section="notes"` block carrying the handoff's `<agent-notes>` body (the inner agent's appended progress/blockers).
- `no-sentinel` → both `data-section="notes"` (handoff `<agent-notes>`, may be empty placeholder) **and** `data-section="log"` (last 50 lines of the captured inner-agent stdout, fenced).
- `merge-conflict` → one `data-section="log"` block carrying the merge-conflict diff tail (last 50 lines of `git merge` output), fenced. Mirrors the no-sentinel log shape.
- `done` → one `data-section="validation"` block carrying the package-aware feedback report. Summary carries `diff: merged` and `merge: ` `<sha>` (GitHub auto-links bare SHAs to the commit on `main`). The merge commit on `main` *is* the diff — no need to duplicate it inline.

**User-hook executions section (issue #215).** Every non-`discarded` terminal Envelope also carries a trailing `data-section="hooks"` block when at least one **user-declared** lifecycle hook ran during the issue's lifecycle. Built-in defaults (`cargo`, `gradle`, `heartbeat`, `envelope`, `validation` — see the *Lifecycle Hooks* table) are deliberately excluded; the block exists to surface the policy the operator wrote in `.red/config.yaml`, not the skill's own machinery. Each line has the deterministic shape `<lifecycle_name> <command> exit=<rc>`, in execution order across the entire lifecycle (`pre_session` → `pre_pick` → `post_pick` → `pre_worktree` → `pre_attempt` → `post_attempt` → `pre_merge` → `post_merge` → `on_attempt_error` → `on_idle` → `post_session` / `on_session_error`). Non-zero exits are listed with their exit code — never omitted — so a reviewer can see which user-declared policy guarded the merge or mutated the queue, and whether it failed. When no user hook ran (the common case for projects without an `afk.hooks` block in `.red/config.yaml`), the section is omitted entirely rather than rendered empty. The `discarded` supervisor envelope never carries this section: discards record a slot-park decision made above the per-issue lifecycle, so no per-issue hook chain exists to enumerate.

**Branch namespace — `afk/*` (issue #191, ADR 0103).** AFK uses one remote worker namespace:

- `afk/{id}/{N}-{slug}` is the **live-iteration** branch. It's pushed at worktree-create (`push_initial`), kept in sync after every inner-agent commit by a per-worktree `post-commit` hook (`install_post_commit_hook`), and deleted on DONE after `gh issue close` succeeds (`delete_remote`). On any terminal failure the live ref is **not** deleted — it survives on origin so a human can `git fetch && git checkout afk/{id}/{N}-{slug}` to inspect mid-iteration state.

### Validation Sidecar

During feedback validation, AFK also writes a structured JSONL sidecar at
`$ITER_DIR/validation.jsonl`. It is not rendered into the issue comment; it is
the machine-readable source used by the optional Memory bridge.

Each line is one command/check execution:

```json
{"schema":"red.afk.validation.v1","name":"test:plugins/memory","command":"pnpm -C /repo/plugins/memory test","status":"passed","durationMs":1234,"summary":"command exited 0"}
```

Fields:

- `schema`: literal `red.afk.validation.v1`.
- `name`: stable check name, usually `{script}:{scope}` such as `typecheck:root` or `lint:plugins/memory`.
- `command`: command string when a command ran; omitted for skipped checks.
- `status`: `passed`, `failed`, or `skipped`.
- `durationMs`: command duration when a command ran.
- `summary`: short relevant output/error summary, or a skip reason.
- `infra`: typed infrastructure evidence when the command did not produce a
  branch verdict. `stall` means the validation process group exceeded its normal
  wall-time envelope and consumed no CPU for a complete sampling window before
  the gate reaped it.

The Memory attempt writer only consumes this structured sidecar after parsing it
as JSON. It must not derive validation graph nodes by parsing free-form stdout,
Envelope notes, validation-summary prose, or `<agent-notes>`.

Summary line is always `worker `{id}` · status: {status} · duration: NmSs · diff: {diff} · attempt: K [· merge: {sha}]`, where `{diff}` is `+N -M` against `origin/main` for non-DONE statuses and the literal `merged` for DONE.

After a successful POST (any 2xx), the orchestrator sets `envelope.posted: true` in the iteration state file. The boot-time *Orphan Cleanup* reads that field to pick a TTL for preserved `ready-for-human` dirs: 1 day when the envelope made it to the issue (the thread carries the canonical record), 7 days when the POST failed (the local dir is the only copy of the notes/log). The field is initialised `false` at iteration start.

On any terminal **failure** (BLOCKED, no-sentinel, merge-conflict), the envelope's `data-section="diff"` block carries a clickable **live-branch** `tree/afk/{id}/{N}-{slug}` link (the live ref survives on origin after a terminal failure, so a human can `git checkout` it to inspect or continue, #443), the local worktree path, and a `+N -M files=K` diffstat. DONE iterations delete the live remote branch after the issue closes because the merge commit on `main` is the diff. Terminal failures do not create a separate snapshot branch; the envelope plus pushed worker-branch commits are the forensic record.

The Slice D heartbeat-glyph cleanup has landed — there is no periodic `:one: :two: …` traffic on the issue thread to defer or replace.

## Stage Detection

Inner agent stages are derived from the sandcastle agent stream. AFK records the
stream callback in the canonical Worker log and updates the live state; it does
not require a second agent-only file or a raw runner stdout pipe:

| stage | signal |
|-------|--------|
| setup | first output line |
| explore | `git ls-files`, `find`, repeated `Read` |
| impl | first `Edit`/`Write` call |
| tests | `pnpm test` invocation |
| commit | `git commit` invocation |
| merge | orchestrator stage, post-inner |
| push | orchestrator stage |
| close | orchestrator stage |

Each transition writes to state file. The monitor renders the current stage.

## Live Header

Redraw every 3 s on the controlling TTY, top of the scroll buffer. Use `tput sc; tput cup 0 0; …; tput rc` so the inner agent's stream below stays intact.

```
┌─ /afk ────────────────────────────────────────────────────┐
│ runner: codex          elapsed: 00:14:23   eta: ~01:20:00 │
│ done: 3 / 12 (25%)     blocked: 0          merged: 3      │
│                                                            │
│ ▶ #142 wire OAuth callback                                 │
│   worktree: .red/tmp/workers/wZ2R4/142-a1/worktree          │
│   stage: impl                                              │
│   last: writing tests for callback handler                 │
│                                                            │
│ queue: #143 #144 #145 #146 ...                             │
└────────────────────────────────────────────────────────────┘
```

If stdout is not a TTY (CI, piped log), skip header rendering and print one JSON line per state transition to stderr.

## State File

Path: `.red/tmp/workers/{id}/{N}-a{n}/afk.state.json` — one snapshot per (worker, issue, attempt). Schema:

```json
{
  "version": 1,
  "worker_id": "wZ2R4",
  "pid": 12340,
  "pid_start_time": "123456789",
  "log": ".red/tmp/workers/wZ2R4/worker.log.toonl",
  "started_at": "2026-05-16T12:00:00-03:00",
  "runner": "codex",
  "filter": { "kind": "prd|issues|all", "value": "42" },
  "total": 12,
  "done": 3,
  "failed": 0,
  "blocked": 0,
  "completed": [139, 140, 141],
  "queue": [143, 144, 145, 146],
  "current": {
    "number": 142,
    "title": "wire OAuth callback",
    "slug": "wire-oauth-callback",
    "worktree": ".red/tmp/workers/wZ2R4/142-a1/worktree",
    "handoff": ".red/tmp/workers/wZ2R4/142-a1/handoff.md",
    "started_at": "2026-05-16T12:14:00-03:00",
    "stage": "impl",
    "heartbeat_glyph": null,
    "heartbeat_pid": null,
    "runner": "codex",
    "retries": 0,
    "last_stream_line": "writing tests for callback handler"
  },
  "durations_seconds": [820, 940, 760],
  "envelope": { "posted": false }
}
```

`pid_start_time` is a best-effort process identity token paired with `pid`
(Linux `/proc/<pid>/stat` field 22). It is empty on legacy or unsupported
platforms; readers then fall back to pid-only liveness.

Atomic write: write to `afk.state.json.tmp` inside the worker directory, `mv` over the original. `/afk monitor` and any other reader open it read-only. Between issues the worker has no live state file — monitor renders that as "idle".
