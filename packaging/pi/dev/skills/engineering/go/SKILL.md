---
name: go
working-mode: ad-hoc
description: Middle tier of the dispatch spectrum — `/goal` → `/go` → `/afk`. Use for genuinely untracked, ad-hoc, one-off demands only; anything that is or should be a tracked issue belongs to `/afk`. Mints a disposable issue, spins a dedicated worker, and brings back a PR. Add `--scout "<question>"` for a read-only investigation that posts a report comment and mutates nothing.
argument-hint: "\"<approved-task>\" --dod \"<definition-of-done>\" [--request \"<inner-agent-instruction>\"] [--verify \"<cmd>\"] [--tags a,b] [--mode no-mistakes|direct-PR|local-only] [--runner claude|codex|opencode] [+yolo] | --scout \"<question>\" [--runner ...]"
disable-model-invocation: true
---

# /go

**One demand in, one clean PR out — no Spec, no triage, no queue. `/go` is only for genuinely untracked, ad-hoc, one-off demands.** Anything that is or should be a tracked issue belongs to `/afk`, never `/go`. `/go` is the middle tier of the dispatch spectrum: `/goal` (unstructured directive) → **`/go` (concrete demand)** → `/afk` (structured backlog). See ADR 0081.

Add `--scout` to investigate without touching any code: the agent reads the codebase and posts a markdown report as a comment. Nothing commits, nothing pushes, nothing merges — enforced by the engine, not by convention.

<what-to-do>

## Mandatory confirmation gate for code-producing `/go`

For standard `/go` (anything except `--scout`), do **not** dispatch immediately.
Before dispatching, draft both:

1. **Task** — rewrite the maintainer's demand in high detail, including scope, boundaries, files/areas likely involved, and what not to do.
2. **Definition of Done** — the semantic stop condition: what must be true for the work to be considered complete.

Then ask the maintainer exactly: **`Aprovado?`**

Only after the maintainer approves do you call the dispatch tool. The approved Task becomes the `demand`; the approved Definition of Done becomes the `dod`, so it is recorded on the disposable `lane:go` Ticket and injected into the Worker handoff.

This gate is always required. `+yolo` only raises in-run autonomy; it never skips Task+DoD approval. `--dod "<condition>"` may pre-fill the Definition of Done draft, but it still requires maintainer approval before dispatch.

At approval time, read the repo's declared `plugins.dev.afk.validation` schedule. If its `post_done` Validation moment is undeclared or explicitly empty, offer one ephemeral inline check with `--verify "<cmd>"`; `--verify` appends one command to `post_done` for this dispatch only. If the maintainer declines, proceed best-effort: the undeclared moment is skipped loudly and the engine applies a tightened iteration cap so a check-less dispatch fails fast instead of looping.

Scout mode is read-only and report-producing, so this Task+DoD gate does not apply to `/go --scout`.

## Dispatch through the `rs_dev` MCP, then observe

**`/go` and `/afk` are two clients of one interface, and `/go`'s half is ONE
call.** After approval, dispatch with the `worker_dispatch` tool: it carries the
approved demand to the daemon's `go_dispatch` method (ADR 0150 §3), and the daemon
mints the disposable Ticket, admits the Worker against the host budget, and returns
its id — all inside that call. `/go` mints nothing itself, places no workspace, and
runs no boot phase over the human's checkout.

`worker_dispatch` takes **exactly one** of `demand` or `issue`, and `mode` is valid
only with `demand` — the schema enforces the `/go`-versus-`/afk` boundary that the
hard rules below state in prose. The complete surface, host tool-name prefixing,
and the mutation-mode contract are in [`../afk/MCP.md`](../afk/MCP.md).

| Dispatch parameter | Meaning |
| --- | --- |
| `demand` | the approved Task, as one string |
| `dod` | the approved semantic Definition of Done |
| `mode` | `direct-PR` (default), `no-mistakes`, `local-only`, or `scout` |
| `runner` | a pinned backend; omitted, the host resolves its own |
| `verify` | one ephemeral command appended to `post_done` for this dispatch |
| `tags` | territory `tag:<value>` labels stamped on the minted Ticket |

**What `/go` never does by hand.** No `git worktree add`, no branch pushed from
the human's checkout, no CI watched in a shell loop, no `gh pr merge`: the
dispatched Worker works in the workspace the daemon placed, the gate runs
inside its turn, and landing goes through the daemon's custody hand-off. An
agent that finds itself doing any of those is not "helping" — it is rebuilding
the deleted engine one shell command at a time, and the repair is to fix or
file the MCP gap and dispatch again.

**Then observe.** `status {scope: worker}` reads the run — a `/go` Worker is
stamped `origin=go` / `current.kind=go`, so it stays distinguishable from drain
Workers in every observability tool. `events_since` is the incremental read for a
watch loop, and the Worker's own log lane is named in the dispatch answer. Pass a
per-dispatch inner-agent instruction with `worker_request`, and reach a run already
in flight with `runner_steer`.

**When the MCP is unreachable, first ask whether the plugin was installed or
updated in THIS session — if so, run `/reload-plugins` (or start a new session).**
MCP servers register at plugin load, so a mid-session install writes the
declaration and starts no process: valid files on disk, zero tools in the
session. That is a load-lifecycle gap, not an outage.

**Once the reload is ruled out, the repair is the daemon — there is nothing to
fall back to.** ADR 0147 rule 1 deleted the second implementation rather than
deprecating it, so an unreachable tool surface means the daemon is down or this
project is not registered. Name that and repair it with `/redskilled`; never
hand-mint the Ticket or hand-spawn the Worker in shell.

**Dispatch mode** selects HOW the reused engine finishes the run:

- **`direct-PR`** (default) — the STANDARD path: run the gate, bring back a PR.
- **`no-mistakes`** — route the run through the HARDENED pre-PR pipeline (review → validate → escalate intent findings) *before* the PR is opened. Slowest, safest.
- **`local-only`** — land the branch by an APPROVED local fast-forward merge with **no PR opened**. For a trusted local demand the maintainer wants landed without a review PR.
- **`scout`** — the read-only investigation described below. It cannot be combined with `issue`.

**`+yolo`** is an opt-in autonomy bump — pass the literal token in the demand to
raise the engine's autonomy for this one dispatch. It composes with any mode.

**Dispatch survives the dispatcher.** Every `/go` — standard and `scout` — is an ORDER, never the work: the daemon owns the Worker process, so a UI stop, a session teardown, or a closed terminal ends the session and leaves the run alive. The call returns as soon as the host grants the Worker and answers with the two handles that outlive it — the Worker id and its log lane:

**Dispatch also skips the autonomous line.** Standard `/go` and `scout` mode claim the host's bounded interactive reservation, so a saturated `/afk` target does not make a human-attached demand wait for an AFK Worker to finish. Nothing already running is stopped or resized: the daemon may admit the interactive Worker above the ordinary Worker ceiling, up to `REDSKILLED_INTERACTIVE_RESERVATION` extra Workers (default `1`). The scoped host, project, and worker status answers state that reservation beside their ordinary target, so `target+1` is policy rather than unexplained occupancy.

```
🔍 /go --scout dispatched disposable issue #4210 (origin=scout, kind=scout, lane:scout).
   worker 8cb3eafdcbd2 (pid 41207) — detached from this session; stopping the dispatcher does not stop it.
   watch: .red/tmp/workers/8cb3eafdcbd2/worker.log.toonl
```

Follow it from those handles: `status {scope: worker}`, the statusline, or the log path above. A dispatch the host refuses starts nothing and says so — it never falls back to running the engine here.

**Dispatch refuses a superseded engine.** Before anything is minted or born, the engine the dispatch would actually run is compared against the published dist-tag. Under the default `warn` policy a superseded engine dispatches loudly, naming both versions and the span of fixes it forfeits; set `plugins.dev.dispatch.engine_floor: refuse` to make it a hard stop that mints nothing, or `off` to silence it. A registry the host cannot reach always degrades to a warning and proceeds — offline dispatch must not die — and a source checkout or prerelease is never floored. `RED_DEV_ENGINE_FLOOR=warn|refuse|off` overrides the file for one run.

**`dod`** records the approved semantic Definition of Done on the disposable issue and in the handoff. It is confirmation sugar only; it never bypasses the required approval turn.

**`worker_request`** carries a special per-dispatch instruction block into the inner-agent prompt, matching `/afk --request`. It is not part of the approved Task and is not recorded on the disposable `lane:go` issue.

**`verify`** adds a one-off inline machine check for this dispatch. `--verify` appends one command to `post_done`; use it only when that declared moment otherwise has no commands and the maintainer approved the command during the confirmation gate. A chain ending in a bare `git diff --exit-code` — the usual "regenerating leaves the tree clean" tail — is rewritten to `git add -A --intent-to-add . && git diff --exit-code` before it runs, because plain `git diff` reads tracked files only and would go green over a mirror the generator newly created. The verdict is unchanged: generated output the run has not committed still fails the check.

**`tags`** stamps territory `tag:<value>` labels (bare values, comma-separated) on the minted disposable issue, so the dispatch is visible under the same territory filters `/afk --tags` uses. Missing `tag:<value>` labels are auto-created before the mint — never pre-create them by hand.

**What standard `/go` does, in order (all reused from the AFK engine — not a parallel path):**

1. **Mints a disposable tracking issue** in the isolated `lane:go` lane — labelled `lane:go` and **never** `ready-for-agent`, so a running fleet's candidate listing can never surface it. With `--tags`, the mint also stamps the requested `tag:<value>` territory labels (auto-created when missing). The issue is minted only after Task+DoD approval; its body carries the approved Task, the approved semantic Definition of Done, and the machine gate reference.
2. **Spins a Worker** under the shared `.red/tmp/workers/` root. It does not create a separate worker namespace; the worker state carries `origin=go` and `current.kind=go`, and observability surfaces use those stamps to keep `/go` distinct from the `/afk` drain.
3. **Processes the Ticket in an isolated worktree** the daemon places for that Worker, using the stamped kind as provenance for monitor/statusline display.
4. **Runs the shared review stage** with the **interactive** (pause/ask) escalation sink: mechanical findings auto-apply + commit; an intent finding pauses and asks you to approve / fix / skip.
5. **Runs the declared `post_done` Validation moment at the branch's fork point.** If a command fails after the inner agent emits DONE, the engine re-seeds it with only the failing subset under the bounded `/go` Re-seed budget, then folds back to the full declaration after that subset passes. Exhaustion parks the Ticket at `ready-for-human` / `blocked:validation`. An undeclared or empty moment skips loudly; `--verify` is the one-dispatch addition described above.
6. **Runs the declared `landing` Validation moment before push/PR/queue, then brings back a PR.** Freshness against the merged result belongs to the merge queue, the CI-side final Validation moment. The disposable issue **auto-closes on merge** (the engine's PR body carries `Closes #N`).

**What `--scout` does differently:**

1. **Mints a disposable issue** in the isolated `lane:scout` lane (never `ready-for-agent` or `lane:go`).
2. **Spins a Worker** under the shared `.red/tmp/workers/` root with `origin=scout`, `current.kind=scout`, and `run_mode=scout`.
3. **Runs the agent in read-only mode** — the SCOUT_EXIT_PROTOCOL explicitly forbids commits. `continuousPush` is disabled so no branch is pushed during the run.
4. **Skips local Validation moments, push, PR, and Landing entirely** — the engine enforces this at the `run_mode=scout` check in `process-issue.ts`.
5. **Posts the agent's markdown report** as a comment on the disposable issue, then closes it. Nothing lands on main.

**Hard rules:**

- ✅ **Do** pass the demand/question as ONE quoted argument.
- ✅ **Do** get Task+DoD approval before standard `/go`, then pass the approved DoD with `--dod`.
- ✅ **Do** use `--scout` when you want an audit, investigation, or read-only analysis — not a code change.
- ✅ **Do** let `/go` reuse the AFK engine end-to-end. It is the same Worker / monitor / heartbeat / envelope path, driven through the same `rs_dev` MCP tools, distinguished by Worker kind and mode gates.
- ✅ **Do** run it whether or not a fleet is up — `/go` is a self-sufficient front door.
- ❌ Do **not** add `ready-for-agent` to the minted issue — lane isolation breaks.
- ❌ Do **not** hand-mint the issue or hand-spawn a worker — call `go`, which does the lane + namespace + origin wiring as one unit.
- ❌ Do **not** treat `+yolo` or a provided `--dod` as approval. The approval question still happens first.
- ❌ Do **not** reach for `/go` for a directive you keep green conversationally (that is `/goal`) or for a whole backlog (that is a Spec → `/afk`).

</what-to-do>

<supporting-info>

For failure-state playbooks, see [TROUBLESHOOTING.md](./TROUBLESHOOTING.md).

## Where `/go` sits — the dispatch spectrum

| Tier | Input | Artifact | Worker | Gate sink | When to use |
| --- | --- | --- | --- | --- | --- |
| `/goal` | unstructured directive | none | none | n/a | Conversational steering; no artifact |
| **`/go`** | **one concrete, untracked demand** | **disposable `lane:go` issue + PR** | **Worker, `current.kind=go`** | **interactive (pause/ask)** | **Ad-hoc only — never for tracked issues** |
| **`/go --scout`** | **read-only question** | **report comment** | **Worker, `current.kind=scout`** | **none (read-only path)** | Investigation without code changes |
| **`/afk` (default)** | **triaged backlog (tracked issues)** | **Spec → issues** | **project drain, `current.kind=afk`** | **headless (park to `ready-for-human`)** | **Modus operandi — all tracked work** |

## Scout isolation, concretely

- **Lane:** the issue carries `lane:scout`, not `ready-for-agent` or `lane:go`. Only a scout-kind worker lists it; the fleet and `/go` workers never see it.
- **Worker root:** the daemon places the Worker under the shared `.red/tmp/workers/…` root. Legacy `.red/tmp/scout-workers/…` entries may still appear in observability until they age out, but new scout runs do not use that root.
- **Provenance:** `--origin scout --run-mode scout` stamp the worker state with `origin=scout` and `current.kind=scout`. The `run_mode=scout` is the enforcement point — `process-issue.ts` short-circuits to the report path as soon as the agent emits DONE, before any push/PR/merge code is reached.
- **No-mutation guarantee:** `continuousPush: false` + skip `pushAttempt` + skip `doLanding` + skip `openReviewPr`. Enforced at the code level, not by convention.

## Standard /go isolation

- **Lane:** the issue carries `lane:go`, not `ready-for-agent`. The fleet lists `ready-for-agent`; the `/go` worker lists `lane:go` (`--lane lane:go`). The two pools never overlap.
- **Worker root:** the daemon places the Worker and its Worktree under the shared `.red/tmp/workers/…` root. Legacy `.red/tmp/go-workers/…` entries may still appear in observability until they age out, but new `/go` runs do not use that root.
- **Provenance:** `--origin go` is stamped once on the worker state as `origin=go` and `current.kind=go`, then never mutated.

## Review behaviour (standard /go — shared with `/afk`, ADR 0081)

The shared review stage splits findings two ways:

- **Mechanical** (closed allowlist: formatter, import-organizer, lint-fix, comment-typo, trailing-whitespace, trailing-newline) → auto-applied and committed, always.
- **Intent** (anything else) → escalated. In `/go` the sink is **interactive**: it pauses and asks you to approve, fix, or skip.

## When NOT to use `/go`

- **An issue that is or should be a tracked GitHub issue → `/afk`.** This is the hard boundary: `/go` is **only** for untracked ad-hoc demands, never for issue-form work or when work should live on the backlog.
- A directive you're steering conversationally, no artifact wanted → `/goal`.
- A batch of related work → author a Spec with `/to-spec`, then `/afk`.
- A fire that must jump the queue → file the Ticket with the `priority:urgent` label; `/afk` promotes it ahead of every filter.
- Hand-done work on your own branch that needs only validation + landing → `/retake` (the no-agent landing lane, ADR 0055).

## Name choice: `/go` not `/run`

**`/run` was the first candidate but was rejected** because `run` was already the name of the queue drain, so agents typing `/run` intending an ad-hoc dispatch would have reached the backlog loop, or vice versa. `/go` is unambiguous — it names the tier and collides with nothing.

</supporting-info>
