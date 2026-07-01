---
name: go
description: Semi-structured front door between `/goal` and `/afk` — `/go "<demand>"` mints a disposable tracking issue in an isolated lane (out of `ready-for-agent`, so a running fleet can never claim it), spins a dedicated namespaced worker under `.red/tmp/go-workers/`, reuses the whole AFK engine end-to-end with `origin=go` and the interactive gate, and brings back a PR. The disposable issue auto-closes on merge. Works with or without a fleet running. Use when you have one concrete demand and want a clean PR without authoring a PRD or triaging issues.
argument-hint: "\"<demand>\" [--runner claude|codex|opencode]"
---

# /go

**One demand in, one clean PR out — no PRD, no triage, no queue.** `/go` is the middle tier of the dispatch spectrum: `/goal` (unstructured directive) → **`/go` (concrete demand)** → `/afk` (structured backlog). See ADR 0081.

<what-to-do>

**Run the bundle — do not read its source.** This SKILL.md is the contract; the `dev` bundle's `go` command is a build artifact.

Invoke the dev CLI's `go` command with the demand as a single quoted argument:

```
RED_AFK_RUNNER=<claude|codex|opencode> red-skills-dev go "<demand>" [--runner <runner>]
```

Set `RED_AFK_RUNNER` to your own host runner (`claude` from Claude Code, `codex` from Codex). Use `--runner` only when the user explicitly pinned a backend.

**What `go` does, in order (all reused from the AFK engine — not a parallel path):**

1. **Mints a disposable tracking issue** in the isolated `lane:go` lane — labelled `lane:go` and **never** `ready-for-agent`, so a running fleet's candidate listing can never surface it.
2. **Spins a dedicated namespaced worker** under `.red/tmp/go-workers/` (separate from `/afk`'s `.red/tmp/workers/`) via `RED_AFK_WORKERS_NAMESPACE=go-workers` — no collision with the fleet.
3. **Processes the issue in an isolated worktree**, stamping `origin=go` on the worker so the monitor/statusline show it as a distinct source.
4. **Runs the shared validation gate** with the **interactive** (pause/ask) escalation sink: mechanical findings auto-apply + commit; an intent finding pauses and asks you to approve / fix / skip.
5. **Brings back a PR**; the disposable issue **auto-closes on merge** (the engine's PR body carries `Closes #N`).

**Hard rules:**

- ✅ **Do** pass the demand as ONE quoted argument — `go "fix the flaky login test"`, not loose tokens.
- ✅ **Do** let `/go` reuse the AFK engine end-to-end. It is the same worker / monitor / heartbeat / envelope / reconcile path, only namespaced and interactive.
- ✅ **Do** run it whether or not a fleet is up — `/go` is a self-sufficient front door; it never depends on a supervisor.
- ❌ Do **not** add `ready-for-agent` to the minted issue, or the fleet could claim it and the lane isolation breaks.
- ❌ Do **not** hand-mint the issue or hand-spawn a worker — call `go`, which does the lane + namespace + origin wiring as one unit.
- ❌ Do **not** reach for `/go` for a directive you keep green conversationally (that is `/goal`) or for a whole backlog (that is a PRD → `/afk`).

</what-to-do>

<supporting-info>

## Where `/go` sits

| Tier | Input | Artifact | Worker | Gate sink |
| --- | --- | --- | --- | --- |
| `/goal` | unstructured directive | none | none | n/a |
| **`/go`** | **one concrete demand** | **disposable `lane:go` issue** | **dedicated, `go-workers/`** | **interactive (pause/ask)** |
| `/afk` | triaged backlog | PRD → issues | fleet, `workers/` | headless (park to `ready-for-human`) |

## Isolation, concretely

- **Lane:** the issue carries `lane:go`, not `ready-for-agent`. The fleet lists `ready-for-agent`; the `/go` worker lists `lane:go` (`--lane lane:go`). The two pools never overlap.
- **Worker root:** `RED_AFK_WORKERS_NAMESPACE=go-workers` redirects the worker dir + worktree to `.red/tmp/go-workers/…`. The fleet supervisor (no env) keeps seeing `.red/tmp/workers/`, so it never manages — or trips over — a `/go` worker.
- **Provenance:** `--origin go` is stamped once on the worker state and never mutated. The monitor and statusline render the `go` source count from that field.

## Gate behaviour (shared with `/afk`, ADR 0081)

The validation gate is one shared stage reached automatically. It splits findings two ways:

- **Mechanical** (closed allowlist: formatter, import-organizer, lint-fix, comment-typo, trailing-whitespace, trailing-newline) → auto-applied and committed, always.
- **Intent** (anything else — a rename, a test-expectation change, a dependency bump) → escalated. In `/go` the sink is **interactive**: it pauses and asks you to approve, fix, or skip. (In `/afk` the same finding parks to `ready-for-human` instead.)

A green gate (every finding mechanical or approved) proceeds to the PR and merge via the existing landing path.

## When NOT to use `/go`

- A directive you're steering conversationally, no artifact wanted → `/goal`.
- A batch of related work → author a PRD with `/to-prd`, then `/afk`.
- A fire that must jump the queue → `/urgent`.
- Hand-done work on your own branch that needs only validation + landing → requeue (the no-agent landing lane, ADR 0055).

</supporting-info>
