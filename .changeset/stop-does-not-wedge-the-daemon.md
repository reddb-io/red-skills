---
"@reddb-io/redskilled": patch
---

A Worker stop no longer takes the host's daemon off the air.

The stop asked `systemctl --user stop <unit>` with `spawnSync` and waited for the
job to finish. A runner that ignores SIGTERM does not finish it until systemd's
`TimeoutStopSec` escalates — ninety seconds by default — and for all of that time
the daemon that owns the machine's only socket answered nothing, so every session
on the host read a routine `--once` Worker recycle as a dead daemon.

- The stop request is placed with `--no-block` and spawned asynchronously, so the
  event loop is never held: `ping`, `host-state` and every other read answer while
  a stop is in flight. The death is still CONFIRMED before the caller is told — the
  daemon escalates to the process-group teardown it already owned, on a five-second
  grace of its own, rather than waiting on the init system's timeout.
- Concurrent stops of the same Worker join one teardown, so a Worker is asked to
  die once, its death reaches the event lane once, and its slot is given back once.
  Stops of different Workers still overlap.
- Worker units are created with `TimeoutStopSec=20`, so a stop the daemon is not
  driving — an operator's, a shutdown's — also resolves in seconds.
