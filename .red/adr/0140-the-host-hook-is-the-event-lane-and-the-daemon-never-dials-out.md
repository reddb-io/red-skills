# 0140 — The host hook is the event lane, and the daemon never dials out

Status: accepted

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
   identity so "a lane whose head was rotated away" still reads (`event-lane.ts`). Rotation
   shipped in #3512 with a 4 MiB writer-triggered ceiling, and #3540 amortized compaction so a
   full lane does not pay a whole-generation rewrite on every subsequent append. The writer
   atomically compacts when an append would cross the ceiling. A daemon boot still replays the
   whole visible generation; rotation bounds that replay rather than making it incremental.
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
- Rotation (decision 5) is shipped (#3512, #3540): the writer enforces the 4 MiB ceiling and
  amortizes compaction. Boot still replays the whole bounded lane, so the ceiling limits replay
  cost without changing the boot model.
- The daemon acquires WSL awareness it has never had — there is currently no occurrence of
  `wsl` anywhere in `apps/redskilled/src/`.

## Amendment 1 — the daemon may call out, scoped to the project that registered the hook

Decision 2 above is stronger than the invariant that supports it, and the
maintainer rejected it the same day it was written. What follows is the reasoning
of the turn, because the reasoning is the part worth keeping.

**The error.** Decision 2 argues the daemon must never execute a registered
command because that would put "processes on the machine that no admission
verdict judged — outside the host budget, absent from the host event lane,
reported by no surface". That sentence conflates two different prohibitions:
*must not create an unaccounted third-party process* with *must not create a
process*. The daemon births Workers continuously; creating processes is precisely
the authority ADR 0130 gives it exclusively. The real invariant was never that
the daemon does not spawn — it is that **everything it creates is admitted,
budgeted, and on the lane**. A hook that goes through admission satisfies that
invariant rather than violating it, and the original decision mistook one
sufficient way of honouring the rule for the rule itself.

**A hook is scoped to the registering project.** Declared inside the project's
registration, it has an owner, it is charged to that project's budget, and it is
refusable when the host has no headroom — the same three properties that make a
Worker legitimate rather than a stray process. A hook nobody registered is still
refused; what changes is that a project may now ask for one.

**Its shape is a `RedskilledLaunchTemplate` keyed by event kind.** An argv and an
env with `{{…}}` placeholders, where the daemon substitutes the facts only it
knows and **refuses an unknown placeholder rather than starting**, exactly as it
already does at Worker birth (Amendment 5 of ADR 0130). This reuses the path that
exists instead of opening a parallel one, and it preserves the frozen contract:
the daemon reads no word of the command and still does not know what a runner is.

**`async` is the default**, carrying the doctrine the demand producer already
states in code — *a hook is a notification, never a veto*. The daemon does not
wait, and a consumer that throws, hangs, or dies changes nothing about the work.

**`sync` is a WAIT, and the daemon is one per machine.** A stalled hook stalls
Worker birth for *every* project on the host, not only for the project that
registered it — the single point in this design where the cost of a mistake does
not land on whoever made it. A sync hook therefore requires a mandatory (never
optional) deadline, an entry in `DECLARED_WAITS` naming its subject, deadline and
escalation, and an expiry that proceeds and records rather than continuing to
wait. `unbounded` is legal elsewhere under the declared-wait contract; here it is
not.

**A project-scoped webhook is the same mechanism under a different transport** —
a URL where the launch template carries an argv. Same scoping, same admission,
same wait rule. It is not a second design and must not grow one.

Decisions 1 and 3 through 7 stand unchanged. The lane remains the outbound
mechanism for an external consumer that registers nothing; daemon hooks are a
**second** extension point for a project that does, never a replacement for the
first.

## Amendment 2 — machine policy may declare admitted host event sinks

The operator may declare asynchronous launch templates under
`plugins.dev.redskilled.hooks.<public-kind>` in `~/.red/config.yaml`. This is a
third ownership case beside an unregistered lane reader and a project-scoped
hook: the synthetic owner is `redskilled/host-events`, its workspace is the
host-scoped daemon home, and every invocation passes ordinary admission,
placement, accounting and event-lane recording. It therefore satisfies
Amendment 1's invariant without inventing an untracked process. Refusal is a
notification failure and never changes the Worker whose lifecycle fired it.

The hook receives the full versioned `host-state` JSON document on stdin and the
kind in `REDSKILLED_HOST_EVENT`. The daemon captures that document after applying
the triggering state change but before birthing the sink Worker; this prevents a
Worker-count consumer from painting its own refresh process into the count.
Sink Worker lifecycle events never recurse into machine policy.

`plugins.dev.redskilled.notifications` declares public kinds for a second sink.
The daemon selects the platform-native desktop command and births it through the
same admitted path with the same state payload. Drawing and wallpaper composition
remain consumer concerns; emitting the requested native notification belongs to
the daemon sink the operator explicitly selected.

Machine declarations are re-read from operator policy on every daemon start and
are never copied into the daemon-written registration-intent snapshot. They thus
survive restart while preserving the policy/state ownership boundary requested
by #3503. The public event lane remains the extension point for consumers that
register nothing.
