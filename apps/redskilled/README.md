# redskilled

The host-scoped execution daemon of ADR 0130: **one singleton per user session,
behind a unix socket**, owning Worker processes across every project on the
machine while each project's bundle keeps owning the work.

This app is the daemon's skeleton — the core exists, is reachable, and is honest
about its own life. No Worker is born here yet.

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
| The frozen wire contract | `src/protocol.ts` — `ping`, `host-state`, `shutdown` |
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
- **The daemon receives paths, never derives them.** That is what lets one daemon
  serve checkouts pinned to different bundle versions.

## Commands

```bash
pnpm -C apps/redskilled test        # the focused suite
pnpm -C apps/redskilled typecheck
pnpm -C apps/redskilled serve       # run the daemon on this session's socket
```
