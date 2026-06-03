# ADR 0051 — AFK attempt-progress guard resets on worktree edits, not just commits

## Status

accepted. Refines ADR 0044 (commit-anchored attempt-progress guard) and ADR 0045 (externalized proof-of-life). Depends on the heartbeat/monitor worktree-path fix (the `worktreePathUnder` / real-worktree diff) so the line-volume signal is real and not a `+0 -0` phantom.

## Context

ADR 0044 armed an attempt-progress guard that aborts an attempt when **no new commit** lands on the worker branch within a wall-clock cap (default 45 min). That was correct for the Claude runner, which commits incrementally as it works.

The **codex runner does not commit mid-run** — it edits the worktree, runs the gates, and commits only at the end (and even then sometimes not at all, see ADR 0050). So for codex, "time since last commit" is not a progress signal: on any issue that takes longer than the cap, the guard aborts a fully-productive agent.

This was observed live on reddb (2026-06-03), twice in one fleet run:

- **#894** (WAL fdatasync): codex produced +228 lines, then the guard aborted it at the 45-min mark for "no commit."
- **#895** (skip DWB on CoW): codex produced **+497 lines**, passed `cargo check` and `cargo fmt`, and was on the **final** focused test when the guard aborted it at 46m20s. The work was essentially complete.

Both attempts were parked `blocked:stalled` → `ready-for-human`, and because the abort is a `timeout` (not `done`/`no-sentinel`), the ADR 0050 salvage did not run — so 725 lines of green work were stranded in the worktrees. The guard, meant to catch a stuck agent, was instead killing the most productive ones.

## Decision

The guard gains a **second progress signal**: the worker worktree's changed-line **volume** (added + removed vs the merge-base, committed AND uncommitted — the same real-worktree diff the heartbeat now reads). Each poll, the deadline resets when **either**:

- a new commit landed (HEAD changed — the ADR 0044 signal), **or**
- the line-volume **changed** since the previous poll (the agent edited the worktree).

A change in either direction counts (an edit that nets to fewer lines is still activity). The guard fires only when **neither** a commit nor an edit has happened within the cap — i.e. the agent is genuinely producing nothing, which is the real "stalled" condition.

The edit signal is supplied via an optional `progressProbe`; when absent (or when it rejects), the guard degrades to the pure commit-anchored behaviour of ADR 0044, so no caller regresses and a probe failure can never cause a false *reset*.

## Consequences

- A productive-but-not-committing runner (codex) is no longer falsely stalled. #895 would have reset its deadline on every poll while the +497 lines accrued.
- The guard still catches a truly stuck agent: a chatty agent producing no code edits, or a hung process, leaves both signals flat and aborts at the cap — the ADR 0044 intent is preserved, just made precise ("no progress" = no commit AND no edit, not merely "no commit").
- Completes the trio against the codex-doesn't-commit hazard: AGENT-PROMPT step 5 (prevent), ADR 0050 salvage (cure a DONE-without-commit), and this (stop killing the agent before it can finish). It also reduces stranded-work incidents, since fewer attempts reach the un-salvaged `timeout` terminal.
- Relies on the real-worktree diff (sandcastle worktree, not the `{attemptDir}/worktree` phantom); a regression there would silently drop the edit signal back to commit-anchored, which is safe but reintroduces the false-stall.

Memory-NoIngest: ADR + runtime fix; the canonical guard contract claim stays with ADR 0044.
