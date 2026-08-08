# 0140 — The host hook is the event lane, and the daemon never dials out

Status: accepted (design; implementation pending)

A program outside RedSkills needs to know when the **redskilled** daemon's state changes
without polling for it (#3503). The first consumer is Redwall (`red-dev#52`), the wallpaper
that draws the live Worker count and must repaint when a Worker is born or dies. The obvious
design — the daemon holds a registry of interested programs and calls them — is the one this
ADR refuses, and the refusal is the whole reason the record exists.

## Decisions

1. **The mechanism is the host event lane, not a new transport.** `~/.red/redskilled/redskilled.log.toonl`
   is already an append-only TOONL record of every host event, already carries `worker-birth`
   and `worker-death`, and already survives daemon restart because it is a file. A consumer
   watches it. The daemon gains a documented contract and no new code path for delivery.
2. **The daemon never dials out and never execs a registered command.** ADR 0130 gives it
   one thing exclusively — authority over Worker birth — and a hook that spawned a
   subscriber's program would put processes on the machine that no admission verdict judged,
   outside the host budget, absent from the host event lane, reported by no surface. The
   protocol stays request/response; there is no `subscribe`.
3. **A declared subset of the lane is public**: `worker-birth`, `worker-death`,
   `worker-budget-kill`. Everything else stays internal and free to change. This is not
   caution — it is proportion: 77% of the lane today is `demand-refusal` and `worker-metrics`
   telemetry (7,335 and 5,236 records against 1,444 births and deaths), and publishing the
   whole file would freeze a shape nobody promised anybody.
4. **A declared set of kinds fires the hook, never "any change to `host-state`".** The host
   state carries RSS samples that move continuously; a consumer woken by all of it is woken
   by nothing in particular. A consumer that wants the whole picture asks `host-state` after
   the change, which is affordable precisely because the changes are rare.
5. **The lane rotates, and a consumer that fell behind re-baselines rather than replays.**
   The event shape was designed for this from the start — every event carries its own
   identity so "a lane whose head was rotated away" still reads (`event-lane.ts`) — but the
   mechanism was never built, and the file now grows without bound and is replayed whole at
   every daemon boot. Rotation must land before consumers depend on positions in it.
6. **The lane is watchable only from the side that writes it.** File-change notification does
   not cross the WSL boundary: a native-Windows consumer watching a WSL-side lane receives
   nothing, forever, with no error. The daemon therefore gains its first WSL detection and
   states that the lane is not observable across the boundary. Silence is the worst answer a
   contract can give, so an unsupported topology is refused out loud rather than served badly.
7. **Drawing belongs to the consumer's repository.** Turning an event into a desktop
   notification, a wallpaper, or any other surface is not this daemon's work, which is the
   same argument #3503 itself makes for keeping wallpaper composition out of redskilled. The
   second half of that issue — OS notifications — is red-dev's, not ours.

## Considered options

- **Daemon execs a registered command per event.** The classic hook. Rejected by decision 2:
  it is the one thing a daemon that owns birth must not do.
- **Socket subscription — the consumer holds a connection and the daemon pushes frames.**
  Workable, and the issue itself argues against it: it couples two repositories to a surface
  that was never public. It also turns thirteen request/response commands into a protocol
  with a lifetime.
- **A per-subscriber socket or fifo fan-out.** Every cost of the above plus a registry to
  keep, and the registry is the thing the lane makes unnecessary.
- **A second lane carrying only public events.** Cheaper for the consumer to read, at the
  price of a second writer for facts that already have one authority. Rejected as an
  optimization for a first-attach cost that tail-watching does not pay in steady state.

## Consequences

- The word "hook" now names two opposite directions. `.red/contexts/dev/CONTEXT.md` fixes
  both senses: a **Host hook** is outbound (daemon → local consumer, this ADR), a **Webhook**
  is inbound (GitHub → daemon, #3387, to stop polling). Neither may be called "hook" bare.
- Rotation (decision 5) is now a prerequisite rather than hygiene, and it lands beside the
  same unbounded-growth fix the death lane needs.
- The daemon acquires WSL awareness it has never had — there is currently no occurrence of
  `wsl` anywhere in `apps/redskilled/src/`.
