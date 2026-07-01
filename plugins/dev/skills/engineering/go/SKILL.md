---
name: go
description: Semi-structured front door between `/goal` and `/afk` — `/go "<demand>"` mints a disposable tracking issue in an isolated lane, spins a dedicated worker, reuses the whole AFK engine, and brings back a PR. Add `--scout "<question>"` for a read-only investigation that posts a report comment and mutates nothing (no branch/PR/merge). Works with or without a fleet running.
argument-hint: "\"<demand>\" [--runner claude|codex|opencode] | --scout \"<question>\" [--runner ...]"
---

# /go

**One demand in, one clean PR out — no PRD, no triage, no queue.** `/go` is the middle tier of the dispatch spectrum: `/goal` (unstructured directive) → **`/go` (concrete demand)** → `/afk` (structured backlog). See ADR 0081.

Add `--scout` to investigate without touching any code: the agent reads the codebase and posts a markdown report as a comment. Nothing commits, nothing pushes, nothing merges — enforced by the engine, not by convention.

<what-to-do>

**Run the bundle — do not read its source.** This SKILL.md is the contract; the `dev` bundle's `go` command is a build artifact.

Invoke the dev CLI's `go` command with the demand as a single quoted argument:

```
# Standard /go — ships a PR
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev go "<demand>" [--runner <runner>]

# Scout mode — read-only investigation, posts a report comment, no branch/PR/merge
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev go --scout "<question>" [--runner <runner>]
```

Set `RED_AFK_RUNNER` to your own host runner (`claude` from Claude Code, `codex` from Codex). Use `--runner` only when the user explicitly pinned a backend.

**What standard `/go` does, in order (all reused from the AFK engine):**

1. **Mints a disposable tracking issue** in the isolated `lane:go` lane — labelled `lane:go` and **never** `ready-for-agent`, so a running fleet's candidate listing can never surface it.
2. **Spins a dedicated namespaced worker** under `.red/tmp/go-workers/` (separate from `/afk`'s `.red/tmp/workers/`) via `RED_AFK_WORKERS_NAMESPACE=go-workers` — no collision with the fleet.
3. **Processes the issue in an isolated worktree**, stamping `origin=go` on the worker so the monitor/statusline show it as a distinct source.
4. **Runs the shared validation gate** with the **interactive** (pause/ask) escalation sink: mechanical findings auto-apply + commit; an intent finding pauses and asks you to approve / fix / skip.
5. **Brings back a PR**; the disposable issue **auto-closes on merge** (the engine's PR body carries `Closes #N`).

**What `--scout` does differently:**

1. **Mints a disposable issue** in the isolated `lane:scout` lane (never `ready-for-agent` or `lane:go`).
2. **Spins a dedicated scout worker** under `.red/tmp/scout-workers/` (`origin=scout`, `run_mode=scout`).
3. **Runs the agent in read-only mode** — the SCOUT_EXIT_PROTOCOL explicitly forbids commits. `continuousPush` is disabled so no branch is pushed during the run.
4. **Skips push / feedback gate / PR / landing entirely** — the engine enforces this at the `run_mode=scout` check in `process-issue.ts`.
5. **Posts the agent's markdown report** as a comment on the disposable issue, then closes it. Nothing lands on main.

**Hard rules:**

- ✅ **Do** pass the demand/question as ONE quoted argument.
- ✅ **Do** use `--scout` when you want an audit, investigation, or read-only analysis — not a code change.
- ✅ **Do** let `/go` reuse the AFK engine end-to-end. It is the same worker / monitor / heartbeat / envelope path, only namespaced and mode-gated.
- ✅ **Do** run it whether or not a fleet is up — `/go` is a self-sufficient front door.
- ❌ Do **not** add `ready-for-agent` to the minted issue — lane isolation breaks.
- ❌ Do **not** hand-mint the issue or hand-spawn a worker — call `go`, which does the lane + namespace + origin wiring as one unit.
- ❌ Do **not** reach for `/go` for a directive you keep green conversationally (that is `/goal`) or for a whole backlog (that is a PRD → `/afk`).

</what-to-do>

<supporting-info>

## Where `/go` sits

| Tier | Input | Artifact | Worker | Gate sink |
| --- | --- | --- | --- | --- |
| `/goal` | unstructured directive | none | none | n/a |
| **`/go`** | **one concrete demand** | **disposable `lane:go` issue + PR** | **dedicated, `go-workers/`** | **interactive (pause/ask)** |
| **`/go --scout`** | **read-only question** | **report comment** | **dedicated, `scout-workers/`** | **none (read-only path)** |
| `/afk` | triaged backlog | PRD → issues | fleet, `workers/` | headless (park to `ready-for-human`) |

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

- A directive you're steering conversationally, no artifact wanted → `/goal`.
- A batch of related work → author a PRD with `/to-prd`, then `/afk`.
- A fire that must jump the queue → `/urgent`.
- Hand-done work on your own branch that needs only validation + landing → requeue (the no-agent landing lane, ADR 0055).

</supporting-info>
