/**
 * daemon — the `redskilled` singleton: one per MACHINE, behind a socket.
 *
 * Three mechanisms guard the singleton, and they answer different questions.
 * **Exclusive bind** answers "who owns the socket right now" — the kernel
 * refuses a second `listen()` on a bound path, so the start race between several
 * projects auto-spawning at once resolves without a vote. **The session lease**
 * answers "who owns this runtime directory across restarts" — a record that
 * survives the process, so a crash is reapable and a pid the OS reused cannot
 * impersonate the holder. **The machine claim** answers the one neither can see:
 * "does this machine already have a daemon somewhere else" — in another OS user's
 * `0700` runtime directory, which is invisible to both of the others (ADR 0130
 * Amendment 3). None is sufficient alone: a lease without a bind lets two daemons
 * both believe they own the socket, a bind without a lease loses the ownership
 * fact the moment the process dies, and both together still permit the second
 * daemon that voids the host budget.
 *
 * **The daemon never leaves by boredom** (ADR 0150 §4). It holds no idle timer
 * and no idle-exit path at all: the OS service `provision` installs is what
 * starts it, and it stays up until an operator, a signal or a replacement takes
 * the session. Leaving by boredom would abandon a budget nobody else is tracking
 * and hand the next client's bundle the choice of which daemon runs (ADR 0143).
 *
 * **A restart costs no work, and no accounting.** Workers are init-system units,
 * so a starting daemon does not find an empty world — it replays its own
 * append-only event lane, re-attaches to every Worker the host still confirms by
 * unit name, and records the deaths of the ones that ended while nobody was
 * watching. Identity and budget come back from the lane rather than from a
 * per-Worker durable record, because the two authorities that already hold the
 * rest of a Worker's story — the tracker and git — would only be contradicted by
 * a third copy.
 *
 * **A death is the host's answer, never the launch client's exit.** The process
 * the daemon watches under the transient-unit backend is `systemd-run --wait`,
 * which its own teardown kills while the init system keeps the Worker running.
 * Writing that exit onto the lane as a death is what let a live Worker escape the
 * host budget for good (#2917) — every successor replayed the death and adopted
 * nothing — so an exit is resolved against the unit before it is believed, and a
 * start additionally asks the host for the Worker units no lane accounts for.
 */
// The public façade over `./daemon/`. A barrel earns its place when several
// modules stand behind it; it earned nothing when it forwarded to one file
// holding the whole daemon. The file-size ratchet is what keeps that from
// growing back.
export * from "./daemon/tunables.js";
export * from "./daemon/types.js";
export * from "./daemon/lifecycle.js";
export * from "./daemon/socket.js";
export * from "./daemon/errors.js";
