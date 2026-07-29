# redskilled

The host-scoped execution daemon of ADR 0130: **one singleton per user session,
behind a unix socket**, owning Worker processes across every project on the
machine while each project's bundle keeps owning the work.

The core exists, is reachable, honest about its own life — and **births Workers**:
a project hands over an argv, a placement target, a budget and two opaque
strings, and the daemon launches the Worker into a resource unit of its own.

## Why its own app

The vendored `packages/red-castle` cannot *be* this daemon: every checkout
carries its own copy, so a host-scoped singleton living there would be N
singletons. The rsp core is repository-scoped and deliberately minimal, so the
daemon does not belong inside it either. It lives here and consumes the shared
resident infrastructure (`packages/shared/resident-core.ts`) rather than a copy
of it.

## What it owns

| Concern | Where it lives |
| --- | --- |
| Which session a daemon serves | `src/paths.ts` — session key, socket, lock, lease |
| Who owns the session across restarts | `src/session-lease.ts` — pid + start time, TOON on disk |
| Who owns the socket right now | `src/daemon.ts` — exclusive bind |
| The frozen wire contract | `src/protocol.ts` — `ping`, `host-state`, `worker-start`, `shutdown` |
| Where a Worker's resources are charged | `src/worker-placement.ts` — pure planner over injected probes |
| Birth itself | `src/worker-launch.ts` — plan, spawn once, report the downgrade |
| The host-wide read | `src/host-state.ts` — total shape, empty at this slice |
| Reaching (and starting) the daemon | `src/client.ts` — auto-spawn, loser joins the winner |

## Behaviours worth knowing

- **The start race resolves twice.** The spawn lock stops N clients launching N
  processes; the exclusive bind stops the ones that slip past from both
  believing they own the socket. The loser waits and connects to the winner — it
  never fails.
- **A pid is not an identity.** The lease pins `pid` *and* `start_time`, so a
  former process whose pid the OS reused cannot renew or release the current
  holder's lease. A crash leaves the record behind on purpose; the next acquirer
  reaps it.
- **Idle exit is gated on Workers.** The daemon rearms instead of exiting while
  it believes a Worker is alive (ADR 0130 rule 7).
- **Fail closed.** No daemon, no Worker. A client that cannot reach the daemon
  throws; there is no quiet local fallback, because for a launcher failing open
  costs the machine.
- **The daemon receives paths, never derives them.** No marker file is looked
  for, no parent directory walked, no layout assumed. That is what lets one
  daemon serve checkouts pinned to different bundle versions.
- **A transient service unit, never a scope.** A scope runs inside the caller's
  unit and cannot outlive it, so every Worker would die with the daemon that
  asked for it. A service unit is owned by the init system, which is what later
  lets the daemon restart without taking every project's work down with it.
- **Placement is decided at launch.** Moving a running process between resource
  groups does not move its existing memory charge, so a Worker born in the
  caller's group stays charged there for life no matter what is done afterwards.
- **An unisolated launch is never silent.** When the host affords no transient
  unit the Worker still starts, and the reply — and the host-state record it
  keeps for its whole life — carries a warning naming what was lost. A declared
  budget that cannot be enforced says so as its own warning.

## Commands

```bash
pnpm -C apps/redskilled test        # the focused suite
pnpm -C apps/redskilled typecheck
pnpm -C apps/redskilled serve       # run the daemon on this session's socket
```
