# 0150 — Four Working modes, an always-on daemon, and skills that name their mode

- **Status**: accepted
- **Date**: 2026-08-18
- **Related**: ADR 0081 (`/go`), ADR 0099 (docs sweep — client boot phase, retired), ADR 0130 (host-scoped daemon), ADR 0143 (resident-by-accident — superseded), ADR 0144 §5 (client checkout is never an input), ADR 0147, ADR 0149
- **Sources**: the `/start` grilling session of 2026-08-18

## Context

Work enters RedSkills in four ways, and the skill texts described none of them
as such: a human iterating in a coder CLI on a fresh worktree; `/start` →
`/to-spec` → `/to-tickets` → `/afk` handing a queue to the daemon; `/go` handing
one ad-hoc demand to the daemon; `/adr-editor` landing ADR changes from a
worktree. `/afk` and `/go` ran boot phases on the client (docs sweep, boot
sweeps, salvage, trust gate) that read the human's checkout — exactly the input
ADR 0144 forbids — and composed the Worker argv project-side. The daemon was
born on demand by the first client and exited after five idle minutes, so
whichever bundle a client happened to carry decided which daemon ran.

## Decision

1. **Four Working modes are the vocabulary** (glossary: *Working mode*):
   **interactive**, **spec-driven**, **ad-hoc**, **ADR-editing**. Interactive
   and ADR-editing worktrees stay under the client checkout's
   `.red/tmp/worktrees/manual` because a human returns to them; spec-driven and
   ad-hoc work is coordinated by `redskilled` and its Workers live in OS
   temporary storage (ADR 0149).
2. **Every skill names its mode** in its header, and the `dev` plugin's agent
   instructions carry the four-mode table. A Worker exports a mode marker
   (`RED_MODE`) for spec-driven and ad-hoc runs so a mode-1 skill invoked
   inside a Worker fails loudly instead of running.
3. **`/afk` and `/go` are thin**: register the Project, arm the drain or call
   `go_dispatch(demand)` — the daemon mints the Ticket, admits the Worker and
   returns its id in one call — and observe. Client boot phases become daemon
   admission or die.
4. **The daemon is always on.** `/red-setup` (or `/redskilled`) installs it as
   an OS service — systemd user unit, launchd, Windows service — with no idle
   exit. A client that finds no daemon fails closed with the repair hint; **no
   client ever spawns the daemon.** Even the interactive worktree is created by
   the daemon through a tool (`worktree_add`) into the registered client
   checkout's manual lane, so `worktree_list` is the one inventory.

## Considered options

- Keep client boot phases because they read the human's checkout. Rejected:
  that is the forbidden input, and it is why a dirty checkout could steer a
  Worker.
- On-demand daemon birth with idle exit (today). Rejected: it is ADR 0143's
  "resident by accident" — the client's bundle version picks the daemon.
- Infer the mode from `cwd`. Rejected alone: declaration is what makes the
  skill text represent the need; the marker is the cross-check.
