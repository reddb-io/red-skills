---
name: go
description: Middle tier of the dispatch spectrum — `/goal` → `/go` → `/afk`. Use for genuinely untracked, ad-hoc, one-off demands only; anything that is or should be a tracked issue belongs to `/afk`. Mints a disposable issue, spins a dedicated worker, and brings back a PR. Add `--scout "<question>"` for a read-only investigation that posts a report comment and mutates nothing.
argument-hint: "\"<approved-task>\" --dod \"<definition-of-done>\" [--verify \"<cmd>\"] [--mode no-mistakes|direct-PR|local-only] [--runner claude|codex|opencode] [+yolo] | --scout \"<question>\" [--runner ...]"
disable-model-invocation: true
---

# /go

**One demand in, one clean PR out — no Spec, no triage, no queue. `/go` is only for genuinely untracked, ad-hoc, one-off demands.** Anything that is or should be a tracked issue belongs to `/afk`, never `/go`. `/go` is the middle tier of the dispatch spectrum: `/goal` (unstructured directive) → **`/go` (concrete demand)** → `/afk` (structured backlog). See ADR 0081.

Add `--scout` to investigate without touching any code: the agent reads the codebase and posts a markdown report as a comment. Nothing commits, nothing pushes, nothing merges — enforced by the engine, not by convention.

<what-to-do>

## Mandatory confirmation gate for code-producing `/go`

For standard `/go` (anything except `--scout`), do **not** dispatch immediately.
Before invoking the bundle command, draft both:

1. **Task** — rewrite the maintainer's demand in high detail, including scope, boundaries, files/areas likely involved, and what not to do.
2. **Definition of Done** — the semantic stop condition: what must be true for the work to be considered complete.

Then ask the maintainer exactly: **`Aprovado?`**

Only after the maintainer approves do you run the `go` bundle command. The approved Task becomes the quoted command argument. The approved Definition of Done is passed with `--dod "<condition>"`, so it is recorded on the disposable `lane:go` issue and injected into the worker handoff.

This gate is always required. `+yolo` only raises in-run autonomy; it never skips Task+DoD approval. `--dod "<condition>"` may pre-fill the Definition of Done draft, but it still requires maintainer approval before dispatch.

At approval time, check whether the repo has configured machine validation (`afk.backpressure` / the normal feedback harness). If no harness is configured, offer one ephemeral inline check with `--verify "<cmd>"`; that command runs as backpressure for this single dispatch only. If the maintainer declines an inline check, proceed best-effort; the engine applies a tightened iteration cap so a check-less dispatch fails fast instead of looping.

Scout mode is read-only and report-producing, so this Task+DoD gate does not apply to `/go --scout`.

**Run the bundle — do not read its source.** This SKILL.md is the contract; the `dev` bundle's `go` command is a build artifact.

Invoke the dev CLI's `go` command with the demand as a single quoted argument:

```
# Standard /go — ships a PR (direct-PR is the default mode)
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev go "<approved-task>" --dod "<definition-of-done>" [--verify "<cmd>"] [--mode <mode>] [--runner <runner>] [+yolo]

# Scout mode — read-only investigation, posts a report comment, no branch/PR/merge
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev go --scout "<question>" [--runner <runner>]
```

Set `RED_AFK_RUNNER` to your own host runner (`claude` from Claude Code, `codex` from Codex). Use `--runner` only when the user explicitly pinned a backend.

**Dispatch mode — `--mode {no-mistakes|direct-PR|local-only}`** selects HOW the reused engine finishes the run. Omit it and `/go` uses `direct-PR`:

- **`direct-PR`** (default) — the STANDARD path: run the gate, bring back a PR.
- **`no-mistakes`** — route the run through the HARDENED pre-PR pipeline (review → validate → escalate intent findings) *before* the PR is opened. Slowest, safest.
- **`local-only`** — land the branch by an APPROVED local fast-forward merge with **no PR opened**. For a trusted local demand the maintainer wants landed without a review PR.

**`+yolo`** is an opt-in autonomy bump — pass the literal token to raise the engine's autonomy for this one dispatch. It composes with any mode.

**`--dod "<condition>"`** records the approved semantic Definition of Done on the disposable issue and in the handoff. It is confirmation sugar only; it never bypasses the required approval turn.

**`--verify "<cmd>"`** adds a one-off inline machine check for this dispatch. Use it only when the repo lacks a configured harness/backpressure and the maintainer approved the command during the confirmation gate.

**What standard `/go` does, in order (all reused from the AFK engine — not a parallel path):**

1. **Mints a disposable tracking issue** in the isolated `lane:go` lane — labelled `lane:go` and **never** `ready-for-agent`, so a running fleet's candidate listing can never surface it. The issue is minted only after Task+DoD approval; its body carries the approved Task, the approved semantic Definition of Done, and the machine gate reference.
2. **Spins a dedicated namespaced worker** under `.red/tmp/go-workers/` (separate from `/afk`'s `.red/tmp/workers/`) via `RED_AFK_WORKERS_NAMESPACE=go-workers` — no collision with the fleet.
3. **Processes the issue in an isolated worktree**, stamping `origin=go` on the worker so the monitor/statusline show it as a distinct source.
4. **Runs the shared validation gate** with the **interactive** (pause/ask) escalation sink: mechanical findings auto-apply + commit; an intent finding pauses and asks you to approve / fix / skip.
5. **Runs bounded post-DONE machine-gate correction** for `/go`: if feedback/backpressure fails after the inner agent emits DONE, the engine re-seeds the agent with the failing validation tail under a small `RED_GO_VERIFY_RETRIES` cap, then deterministically parks to `ready-for-human` / `blocked:validation` when the cap is exhausted.
6. **Brings back a PR**; the disposable issue **auto-closes on merge** (the engine's PR body carries `Closes #N`).

**What `--scout` does differently:**

1. **Mints a disposable issue** in the isolated `lane:scout` lane (never `ready-for-agent` or `lane:go`).
2. **Spins a dedicated scout worker** under `.red/tmp/scout-workers/` (`origin=scout`, `run_mode=scout`).
3. **Runs the agent in read-only mode** — the SCOUT_EXIT_PROTOCOL explicitly forbids commits. `continuousPush` is disabled so no branch is pushed during the run.
4. **Skips push / feedback gate / PR / landing entirely** — the engine enforces this at the `run_mode=scout` check in `process-issue.ts`.
5. **Posts the agent's markdown report** as a comment on the disposable issue, then closes it. Nothing lands on main.

**Hard rules:**

- ✅ **Do** pass the demand/question as ONE quoted argument.
- ✅ **Do** get Task+DoD approval before standard `/go`, then pass the approved DoD with `--dod`.
- ✅ **Do** use `--scout` when you want an audit, investigation, or read-only analysis — not a code change.
- ✅ **Do** let `/go` reuse the AFK engine end-to-end. It is the same worker / monitor / heartbeat / envelope path, only namespaced and mode-gated.
- ✅ **Do** run it whether or not a fleet is up — `/go` is a self-sufficient front door.
- ❌ Do **not** add `ready-for-agent` to the minted issue — lane isolation breaks.
- ❌ Do **not** hand-mint the issue or hand-spawn a worker — call `go`, which does the lane + namespace + origin wiring as one unit.
- ❌ Do **not** treat `+yolo` or a provided `--dod` as approval. The approval question still happens first.
- ❌ Do **not** reach for `/go` for a directive you keep green conversationally (that is `/goal`) or for a whole backlog (that is a Spec → `/afk`).

</what-to-do>

<supporting-info>

## Where `/go` sits — the dispatch spectrum

| Tier | Input | Artifact | Worker | Gate sink | When to use |
| --- | --- | --- | --- | --- | --- |
| `/goal` | unstructured directive | none | none | n/a | Conversational steering; no artifact |
| **`/go`** | **one concrete, untracked demand** | **disposable `lane:go` issue + PR** | **dedicated, `go-workers/`** | **interactive (pause/ask)** | **Ad-hoc only — never for tracked issues** |
| **`/go --scout`** | **read-only question** | **report comment** | **dedicated, `scout-workers/`** | **none (read-only path)** | Investigation without code changes |
| **`/afk` (default)** | **triaged backlog (tracked issues)** | **Spec → issues** | **fleet, `workers/`** | **headless (park to `ready-for-human`)** | **Modus operandi — all tracked work** |

## Scout isolation, concretely

- **Lane:** the issue carries `lane:scout`, not `ready-for-agent` or `lane:go`. Only the scout worker lists it; the fleet and `/go` workers never see it.
- **Worker root:** `RED_AFK_WORKERS_NAMESPACE=scout-workers` redirects to `.red/tmp/scout-workers/…`.
- **Provenance:** `--origin scout --run-mode scout` stamp the worker state. The `run_mode=scout` is the enforcement point — `process-issue.ts` short-circuits to the report path as soon as the agent emits DONE, before any push/PR/merge code is reached.
- **No-mutation guarantee:** `continuousPush: false` + skip `pushAttempt` + skip `doLanding` + skip `openReviewPr`. Enforced at the code level, not by convention.

## Standard /go isolation

- **Lane:** the issue carries `lane:go`, not `ready-for-agent`. The fleet lists `ready-for-agent`; the `/go` worker lists `lane:go` (`--lane lane:go`). The two pools never overlap.
- **Worker root:** `RED_AFK_WORKERS_NAMESPACE=go-workers` redirects the worker dir + worktree to `.red/tmp/go-workers/…`.
- **Provenance:** `--origin go` is stamped once on the worker state and never mutated.

## Gate behaviour (standard /go — shared with `/afk`, ADR 0081)

The validation gate splits findings two ways:

- **Mechanical** (closed allowlist: formatter, import-organizer, lint-fix, comment-typo, trailing-whitespace, trailing-newline) → auto-applied and committed, always.
- **Intent** (anything else) → escalated. In `/go` the sink is **interactive**: it pauses and asks you to approve, fix, or skip.

## When NOT to use `/go`

- **An issue that is or should be a tracked GitHub issue → `/afk`.** This is the hard boundary: `/go` is **only** for untracked ad-hoc demands, never for issue-form work or when work should live on the backlog.
- A directive you're steering conversationally, no artifact wanted → `/goal`.
- A batch of related work → author a Spec with `/to-spec`, then `/afk`.
- A fire that must jump the queue → file the Ticket with the `priority:urgent` label; `/afk` promotes it ahead of every filter.
- Hand-done work on your own branch that needs only validation + landing → `/retake` (the no-agent landing lane, ADR 0055).

## Name choice: `/go` not `/run`

**`/run` was the first candidate but was rejected** because the dev CLI already uses `run` as its main subcommand (`red-skills-dev run …` is the AFK queue-drain entrypoint). A second `run` skill would create an ambiguous surface: agents that type `/run` intending ad-hoc dispatch would instead invoke the queue drain, or vice versa. `/go` is unambiguous — it names the tier and carries no collision risk with any existing `dev` subcommand or skill.

</supporting-info>
