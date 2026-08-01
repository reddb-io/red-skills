# 0130 — `redskilled` is the host-scoped execution daemon; projects are its clients

- **Status**: accepted
- **Date**: 2026-07-29
- **Related**: ADR 0067 (per-directory plugin gate), ADR 0098 (`.red` lifecycle taxonomy), ADR 0104 (long-running supervisor and leases), ADR 0113 (castle owns truth, dev owns the host boundary), ADR 0120 (castle MCP is the canonical interface), ADR 0126 (the resident is the core, every surface is a client), ADR 0128 (the attempt is the unit of truth — **superseded by this record**), ADR 0129 (re-seed is bounded in place)

## Context

Every fleet is scoped to one directory. That is correct for *work* and wrong for
*resources*. Each checkout reads its own host capability profile, concludes the
machine affords N workers, and acts on it alone — so three projects on one
machine run 3N workers and nothing on the host knows the total. The operator
feels this as fragility with no instrument: there is no answer to "what is this
machine currently doing".

The tree already holds three partial answers that do not compose:

- `apps/dev/src/runtime/fleet-scope.ts` (#2697) places each fleet in its own
  transient systemd scope, so a pressure kill lands on the workload instead of
  on the terminal. It budgets *within* a fleet and nothing *across* fleets.
- `packages/red-castle/src/engine/host-capability-profile.ts` already models
  host-scoped admission — `machineIdHash`, `defaultFleetWidth`,
  `evaluateHostGateAdmission` — but the profile is static and stored per repo,
  so every project reads the same permission and spends it independently.
- `packages/red-castle/src/engine/federated-fleet-view.ts` aggregates across
  *hosts*. Nothing aggregates across *projects* on one host, which is the axis
  the operator actually works on.

ADR 0126 already settled the shape of the fix one layer down: the rsp resident
is a core behind a unix socket, and the MCP, the CLI, the wrappers and the hook
are peer clients of it. What it did not do is widen that core past one
repository.

## Decision

**One host-scoped daemon, `redskilled`, owns worker processes across every
project on the machine. The per-project MCP is its client.**

1. **Singleton and scope.** One daemon per **machine** (Amendment 3 — this
   originally read "per user session"), reached over a unix socket, with
   `machineIdHash` labelling the host. The vendored red-castle
   cannot *be* this daemon — every checkout carries its own copy — so the
   daemon is a distinct binary in its own app, consuming the already-shared
   `resident-client` infrastructure.

2. **Authority is over the process, never over the work.** The daemon owns
   birth, death, limits and placement. Which ticket is claimed, which runner
   and tier serve it, what the prompt says, when the gate runs and how a branch
   lands remain with the per-project bundle.

3. **The contract is minimal and frozen.** The daemon carries no castle
   semantics. It receives an argv, a placement target, a budget and an opaque
   project label, and it never derives repository layout — a path it needs is a
   path it was *given* at spawn. This is the property that lets one daemon serve
   checkouts pinned to different bundle versions: version skew stops being
   managed and stops existing.

4. **Placement is a strategy per OS over a uniform floor.** Transient systemd
   service units on Linux, Job Objects on Windows, rlimits and priority on
   macOS. Every backend guarantees the same floor — the daemon samples RSS per
   worker and terminates over budget — and a kernel backend is an upgrade in
   precision and latency, never in existence. Backends therefore differ in the
   quality of their teeth, never in whether they have any.

5. **Workers are not the daemon's children.** They run as transient units owned
   by the init system, so the daemon can restart and re-attach by unit name. A
   singleton whose restart killed every project's work would be a machine-wide
   stop event on every upgrade.

6. **Fail closed.** No daemon, no worker. Failing open would reinstate exactly
   the unbudgeted spawn this record exists to prevent, and would do it silently.
   A minimal frozen core is the kind of dependency that may be depended on
   hard — that is what rule 3 buys.

7. **Start is auto-spawn, with optional supervision.** The first client that
   needs the daemon starts it; an optional user unit adds `Restart=on-failure`.
   This is one behaviour with an optional supervisor, not two spawn paths — the
   binary, the socket and the contract are identical either way. The daemon
   never idle-exits while a worker unit is alive.

8. **Persistence is an append-only host event lane.** Birth, death and
   budget-kill are appended so an incident can be read after the fact. There is
   no per-worker durable record: the tracker owns issue-to-PR, git owns
   branch-to-commits, and the daemon owns worker-to-process, so a third copy
   would only reintroduce a fact two authorities already hold.

9. **Reach is asymmetric: read the host, write the project.** A session sees
   every project's workers, budget and ownership, and may act only on its own.
   Seeing the whole machine is a requirement of the problem; commanding the
   whole machine never was, and the sessions are largely driven by autonomous
   agents.

10. **The MCP serves the statusline, content-first.** It exposes both a rendered
    string and the payload behind it, with the string a pure function of the
    payload so the two surfaces cannot drift. All content is served by the
    daemon; a worker publishes its last activity line on its heartbeat as an
    opaque string, and the daemon reads a worker's log from disk only to
    rehydrate after a restart that left it with no information.

11. **Project identity resolves once and is used everywhere.** A declared
    `project.name` wins, else the git remote's `owner/repo`, else the checkout
    basename. Display uses that name; the filesystem uses
    `slugify(owner--repo)` plus a short hash of the absolute
    `--git-common-dir`, always present — which makes collision between
    independent clones impossible by construction while collapsing a repo's
    worktrees onto the project they belong to. Worker roots are named lanes
    from a closed set (`local` default, `tmp`, `host`, or an explicit parent
    directory), and a target on a memory-backed or auto-cleaned filesystem is
    refused rather than silently accepted.

## Consequences

This record reverses live decisions. Each is named rather than left to be
discovered:

- **Fleet is extinct.** With the budget owned host-wide and one demand producer
  per project applying selectors as an ordered priority, the fleet's remaining
  job — being the unit that owned a width and a cgroup — has no owner left to
  be. `fleet-registry`, `fleet-name`, `fleet-hook-config`,
  `fleet-hook-dispatcher`, the `.red/tmp/supervisors/<fleet>/` lanes and the
  `fleet_*` MCP tools are re-shaped or removed. **This amends ADR 0120**, whose
  tool surface names fleet lifecycle as a domain.

  As executed (#2786), the reshape reads:

  | Removed | Replacement |
  | --- | --- |
  | `fleet_status` | `project_status` |
  | `fleet_create` | `project_start` |
  | `fleet_edit` | `project_resize` |
  | `fleet_stop` | `project_stop` |
  | `fleet_list`, `fleet_register` | *nothing* — both existed only to operate the registry |

  `fleet_list` and `fleet_register` are the only capabilities that do not
  survive, and they are named rather than quietly dropped: with one producer per
  project there is no second fleet to enumerate, and with no registry there is no
  profile to adopt a running supervisor into. Every project tool still declares a
  `fleet` input for exactly one purpose — refusing it with the replacement named,
  so a stale caller reads a migration answer rather than an internal error. The
  same refusal answers `--fleet` on the CLI. The supervisor's runtime lane keeps
  its on-disk name (`.red/tmp/supervisors/default/`) so an existing checkout
  still reads its own state; what changed is that the name is a constant rather
  than a parameter, and the fleet-hook class is gone outright, which removes the
  `on_stall_reap` veto over the hard reap along with it.

- **Attempt is extinct, and this record supersedes ADR 0128 entirely.** Since
  ADR 0103 made a retry a fresh Worker, a Worker already *is* one worker × one
  ticket × one try; the Attempt was a synonym carrying its own lane, contract
  and retention rule. What 0128 got right survives without it: liveness keeps
  exactly one anchor, and that anchor is now the daemon, which owns process
  death by construction — a stronger authority than the record it replaces, and
  still never a pid file. The janitor's reclaim rule and the re-seed budget of
  **ADR 0129** re-anchor from the Attempt onto the Worker; those are renames,
  not redesigns.

- **The cutover, as executed (#2851).** Every component of this record existed
  and nothing called it: the daemon had never run, and `fleet.ts` and
  `supervisor-spawn.ts` carried no reference to it. The crossing wired both
  halves as one change, because removing the old spawn path alone leaves nothing
  spawning and adding the new one alone leaves two things spawning.

  Birth: the per-project runtime states an argv, a workspace, a log path and its
  own opaque label, and asks the host
  (`apps/dev/src/runtime/redskilled-birth.ts`). The old path is gone rather than
  bypassed — `commands/supervise.ts` imports no `child_process` — and the
  `host-owns-birth` ratchet keeps it gone in every gate run, because the local
  spawn is always the convenient answer and what it produces is not a visible
  regression but a Worker outside the budget. The launch reaches the daemon
  before it starts anything and refuses when nothing answers (rule 6): a
  supervisor with no host behind it would tick forever and drain nothing.

  Death: the daemon appends the exit status it witnessed to the host event lane,
  and the project's tick drains it before reading any slot's exit code — so the
  circuit breaker is a policy over the host's facts rather than a second observer
  of the same process, and the daemon holds no breaker policy, exactly as rule 2
  has it.

  Identity: the host's worker id and the work's worker id are ONE string, handed
  down at birth. Without that, `worker_vitals`, the statusline and the lane
  canary would each need a private mapping between the two authorities — which is
  the second-source problem the single liveness anchor exists to remove.

  The MCP lane canary changed with it. Before the cutover a daemon holding no
  record of a live Worker was telling the truth, because the project had spawned
  that Worker itself, so the canary tolerated the answer. It is now the false
  green the canary exists to refuse: a worker running on disk that the host
  cannot vouch for is a birth that never crossed the socket.

  **Not yet crossed:** the supervisor still keeps its slot table, its
  grow/shrink-to-target and its dead-slot bookkeeping. None of them creates a
  process any more — every one routes through the birth port — but the *shape* is
  still the fleet's, where rule 2 wants one demand producer per project
  (`apps/redskilled/src/demand-producer.ts`, written and not yet driving the
  loop). That remains a slice of its own: it is bookkeeping over daemon-owned
  births, not a second launcher.

- **ADR 0113 is amended on rendering.** Its seam 1 reads "produce → castle /
  render → dev" and keeps the statusline render in dev. Rendering moves to the
  MCP. This reverses the letter to serve the intent: 0113 wanted dev thin and
  host-swappable so a second host could reuse the truth without reimplementing
  it, and a tool that returns the finished string means no host reimplements
  anything.

- **Cross-host federation is retired.** `federated-fleet-view` is modelled on
  fleet heartbeats and fleet slots, both extinct here. It existed because the
  shared event lane made the aggregate nearly free, not because a second
  machine demanded it. Should one appear, daemon-to-daemon federation builds on
  the socket, which is a better base than the lane.

  As executed (#2787), the retirement removed the aggregate
  (`engine/federated-fleet-view`), its tool (`federated_fleet_view`), its output
  contract, and the `federation` block of the `statusline_aggregate` payload. No
  surface reports host-grouped state any more, and nothing writes
  `fleet.supervisor.heartbeat` for one to group. The singleton event lane itself
  stays — the webhook wake-source, the resident cron and the host capability
  profile are its remaining, single-host consumers; only the cross-host reader
  of it is gone. The single-host view is untouched: `project_status`,
  `worker_vitals` and `statusline_aggregate` still serve it from the daemon.

- **`afk.state.json` is off-mandate** and becomes TOON/TOONL, with contract
  `red.castle.state.v1` unchanged in meaning.

- **Cost accepted.** Post-mortem forensics loses the single-read answer to "what
  happened to ticket N", falling back to the tracker, the branch and the host
  event lane. A daemon that is down stops all autonomous work on the machine, by
  design.

- **Sequencing.** Archiving ADR 0128 and removing the attempt implementation are
  curation of a live decision and route through a Spec per **ADR 0127**; this
  record fixes the decision, not the migration order.

## Amendment 1 — the daemon polls repository activity (2026-07-29)

Rule 3 above says the daemon carries no castle semantics and receives only an
argv, a placement target, a budget, and an opaque project label. Rendering the
statusline needs one class of fact that rule excludes: repository activity —
open pull requests, open issues, recently closed work — which comes from the
issue tracker rather than from any process the daemon owns.

**Decision: the daemon holds one token and the repository identity of each
registered project, and fetches every project's activity counts in a single
aliased query per interval.**

The frontier moves by exactly two items and no more. The daemon now knows a
repository identity per project — which it already carried as the opaque
project label — and a token. It still does not know what an Issue, a pull
request, a label, a selector, a gate, or a Landing *is*: a count is an integer
it stores and returns without interpreting, exactly as it carries a Worker's
last activity line without parsing it.

Three facts drove this over polling from each project:

1. **GitHub quota is per token, not per process or per host.** Several projects
   polling with the same token already share one budget, so splitting the poller
   across processes saves nothing by itself. What saves is issuing *one* request
   instead of N.
2. **One aliased GraphQL query can span every repository at once.** The
   machinery already exists in the shared batch layer, currently bound to one
   repository per call; widening the parameter is not new capability. Cost then
   becomes flat in the number of projects rather than linear.
3. **Quota exhaustion is not theoretical here.** A single project drove the
   GraphQL quota to zero during one drain session, and the resulting failures
   surfaced as an empty result rather than an error.

**The condition this decision depends on, stated so it is not discovered by
accident: every repository on the host shares one token.** A project needing its
own credential invalidates the decision rather than bending it — the poller then
returns to the projects, which is the only arrangement where each uses its own
credentials. A host-scoped daemon holding one credential that reaches every
registered repository is a security posture, not only an architectural one.

Staleness travels inside the payload, as everywhere else: counts age between
intervals, and a consumer renders the age rather than presenting a stale count
as current.

## Amendment 2 — the host-scoped home is `redskilled`'s, and `/red-setup` provisions through it (#2853)

Rule 7 said a daemon starts on first use and said nothing about what has to
exist before it can. Three things do — the host-scoped home, a published bundle
to run, and a socket that answers — and one of them had no owner at all. Nothing
created `~/.red/redskilled/`, nothing declared it, and `/red-setup` had never
heard of the daemon, so a fresh machine had no route to a working one.

That left an ownership question between two records. ADR 0067 makes
`/red-setup` the **sole creator of a repository's `.red/`**; this home is
operator-scoped and sits outside every checkout, so it was never inside that
authority — and it must not be brought inside it.

**Decision: the home belongs to `redskilled`.** `provisionRedskilledHome` in
`apps/redskilled/src/provision.ts` is the only thing that creates it; every other
surface reads the one namer in `packages/shared/redskilled-home.ts` and never
brings the directory into being. A home only an interactive installer could
create would leave rule 7's auto-spawn failing closed forever on a machine where
setup had never run, with no path back — the daemon would depend on the very
tool that depends on the daemon. ADR 0067's authority is therefore unchanged and
now explicitly **repository-scoped**: it governs a checkout's `.red/`, not the
operator's `~/.red/`.

Setup does not lose a job here, it gains a caller's one. `/red-setup` Section E3
runs `redskilled provision`, which creates the home owner-only (`0700`), starts
the daemon through the ordinary client path, and prints the audit. **Idempotent
by construction**: an existing home is kept with everything in it, and the only
thing a second run can change is a permission bit that drifted wider than
owner-only — a repair, not a rewrite. That is what makes it safe for setup to run
on every pass instead of only when something already looks wrong.

The same section offers the optional supervising unit rule 7 mentions, because
setup is the one interactive, authorized installer in the system. The unit adds
`Restart=on-failure` over the identical binary, socket and contract — still one
behaviour with a supervisor, never a second spawn path — and an existing unit
file is never rewritten, since an operator's edit to it is their configuration.

`/red-doctor` reports the same four checks (`home`, `daemon-entry`, `reach`,
`supervisor-unit`) from the same pure audit, probing the socket **without ever
spawning the daemon it is reporting on**. The optional unit is reported and never
flagged: an absent unit is `ok` with a stated absence, because a doctor that
reddened over an optional thing teaches operators to ignore a red row.

## Amendment 3 — one daemon per machine, and the multi-user case is refused (#2885)

Rule 1 said "one daemon per user session", and `paths.ts` argued the rejected
alternative in its header: keying on the host would make one daemon per machine,
"wrong the moment an operator has two logged-in sessions". **The premise was
wrong, and the conclusion with it.** `XDG_RUNTIME_DIR` is per *user*, not per
login session — every terminal and every login of one operator resolves to the
same `/run/user/<uid>` — so the derivation the rule described already yields one
daemon per user, and always did. Two logged-in sessions were never two daemons.

**Decision: there is exactly one `redskilled` per machine.** The host budget is
the reason the daemon exists, and a second daemon does not degrade it — it
**voids** it, silently, because each one is correct about a total that is not the
machine's. A scope that holds only by accident of a derivation is not a scope; it
is a coincidence waiting for the case that breaks it.

That case is the only one the old wording and the current code actually differ
on: **two different OS users on one machine.** Their runtime directories differ
by construction and are `0700` against each other, so neither daemon can see the
other, and the machine ends up with two arbiters and no error. Four questions had
to be answered in code rather than in prose — where the record lives when it
cannot live in one user's `/run/user/<uid>`, what permissions let a second user
reach it, which user the daemon and therefore every Worker runs as, and whether a
second user is admitted at all.

**The second user is refused, and told why.** The alternatives were considered
and are worse:

1. **Serve the second user from the first user's daemon.** Every Worker it births
   would run as the *first* user, against that user's checkouts and credentials.
   That is a privilege boundary crossed silently, to save one sentence of
   explanation.
2. **Widen the socket to `0666`.** The same crossing, with the kernel's help.
3. **Refuse, and say so.** The budget stays the machine's, Workers stay their
   owner's, and the second user gets a message naming the pid, uid and socket
   that hold the machine.

The mechanism is a **machine claim**: one world-readable TOON record in a shared,
sticky directory (`$TMPDIR/redskilled-<machineIdHash>`, `%PROGRAMDATA%` on
Windows), written `wx` so acquisition is a race exactly one caller wins. It joins
the two guards already there and does not replace either — the exclusive bind
owns "who has the socket right now", the session lease owns "who has this runtime
directory across restarts", and the claim owns the third question neither can
see, because both live inside a directory a foreign session never looks at. A
claim is this daemon's only when pid, start instant **and socket path** all
match: a pid serving a different socket is not the same daemon, and treating it
as one would let a single process admit itself twice.

**A corpse is not a holder, and an unremovable corpse is not an opening.** A
claim whose pid is dead is reaped and retried; a dead claim this process may not
unlink — a foreign uid's file under a sticky directory — ends in a stated refusal
naming the file, because writing a second claim beside it is precisely the second
daemon this record prevents. The refusal is the deliberate answer: a directory
full of corpses must never let the next daemon believe it is the first.

**The daemon reports the scope it holds.** `host-state` carries a `scope` block —
kind, claim path, owner uid, machine and session digests, socket — so an operator
reads the property instead of trusting a comment, and so a second daemon would be
visible rather than inferable from damage. The block is optional on read for the
same reason the upgrade block is: one daemon serves checkouts pinned to different
bundle versions (rule 3), and a field this bundle added must not make an older
daemon's complete answer read as malformed.

`REDSKILLED_MACHINE_DIR` pins the claim directory outright, for an operator who
must state it and for tests that pose as their own machine. It is an explicit
statement, never a silent fallback — which is the line this record draws: a
second daemon is either impossible or announced, and never a surprise.

## Amendment 4 — the daemon owns the demand loop; a project has no process of its own

Rule 2 kept a per-project runtime and named what it retained: trunk mirror
refresh, queue depth, target resolution as a *request*, runner directives, claim
reconciliation, lifecycle hooks. That runtime is a detached long-lived process
per repository, and it turns out to be **a third player nobody can name.**

`project_start` calls it a demand producer. `project_status` answers with the key
`supervisor:`. Its command line is `__supervise` — the same entrypoint as the
supervisor this ADR removed. Three names for one process is not a documentation
problem; it is the shape telling us the thing has no place in the model that
replaced it.

**Decision: there are exactly two players. The project's MCP, alive in a user's
session, which REGISTERS. The daemon, alive on the machine, which POLLS the
tracker and OWNS the demand loop.** The per-project `__supervise` process is
removed; a project contributes a registration, not a process.

Three facts drove it.

**1. The quota argument is the one this ADR already accepted.** Amendment 1
established it for activity counts: GitHub quota is per token, so several
projects polling with the same credential already share one budget and splitting
the poller across processes saves nothing — what saves is one aliased request
instead of N. Queue depth is the *same* fetch against the *same* token, and it is
the larger consumer: activity moves at human speed and is polled accordingly,
while the queue is read every tick. Leaving the bigger half outside the batch
while the smaller half is inside it is an inconsistency, not a boundary.

**2. Only the daemon can see every project at once.** That is already the stated
reason a producer must accept a smaller grant without arguing. A component that
must defer to the host on *how many* Workers exist, while independently deciding
*when* to ask, is deferring on the half it can see and insisting on the half it
cannot.

**3. The loop must outlive the session, and the MCP does not.** The detached
process exists for exactly this reason — `/afk` has to keep draining after the
operator closes the terminal. Under a two-player model the thing that persists is
the daemon, so the loop is the daemon's or it is nobody's.

**Rule 3 survives, and the frontier moves by one item.** Registration carries an
**opaque selector**, an **opaque argv**, and a target. The daemon matches a query
to a result and starts a process with the argv it was handed; it still does not
know what an Issue, a label, a Spec, a gate or a Landing *is* — exactly as
Amendment 1 moved the frontier by a repository identity and a token and no
further. A selector is a string it carries, never a sentence it reads.

**Registration outlives its session, and expires.** A registration that died with
its MCP would defeat the purpose; one that never expires makes a closed laptop
poll forever. So a registration is renewed while a session lives, survives that
session's end, and lapses after a stated interval — and **a project whose queue
drains deregisters itself**, because an empty selector polled on a schedule is
the cost this amendment exists to remove.

**What this costs.** The naming debt is paid by deletion rather than by rename:
`__supervise`, `project_start`'s producer and `project_status`'s `supervisor:`
key all go, instead of converging on a fourth word for a thing that should not
exist. The migration is the harder half — a machine carrying live per-project
runtimes must reach the two-player model without stranding the Workers those
runtimes are holding.

## Amendment 5 — a launch is restated, not frozen

Amendment 4 moves birth onto the registration, and a registration carries **one**
argv. But a Worker's runner, its model tier, its effort, its retire file and its
slot are decided **per birth**, not per project. The runner most of all: a runner
can degrade mid-drain, which is exactly why the directive is applied on a tick
rather than at launch, so a fleet can start on `claude`, meet repeated deaths, and
swap to `codex` for the next birth. **One fixed argv per project cannot express a
decision made per Worker**, and freezing them at registration time would delete
the capability rather than move it.

**Decision: the launch is the one part of a registration a RENEWAL may restate.**
A project states an argv and an env at registration; a tick that decided
something new sends the new pair on the renewal its session already sends every
half-window, and the daemon holds it as the launch for the **next** Worker.
Per-birth facts the project cannot know in advance — the Worker's id, its slot,
its workspace, its log path — are written as `{{worker_id}}`-style placeholders,
and the daemon substitutes the four facts it already owns at birth. Restating is
all-or-nothing: an argv given without an env replaces the env with none, because
a launch half from one tick's decision and half from an older one is a Worker
neither tick asked for.

**Why this shape.** It costs no new op, no round trip and no window. The renewal
is a message a live session already sends, so a swap is a field on a message that
was going to be sent anyway; and a registration that restates nothing is
byte-for-byte the renewal that existed before this amendment.

**The two shapes rejected, and why.**

*Ask the project for the argv per grant.* Preserves everything, and is the shape
closest to what the per-project process does today. It fails on the seam: the
daemon holds **no connection** to a session — every request arrives on its own
socket — so it would need a reverse channel it does not have. It also reinstates
the round trip the demand loop exists to remove, and makes every birth fail while
a session is momentarily blocked, when the whole promise of Amendment 4 is that a
drain outlives its terminal.

*Re-register to swap.* Needs no new field at all. But the daemon **refuses** a
duplicate registration, so a swap is a deregister followed by a register, and the
window between them is a state where the host holds no record of a project that
is still draining — a state that would have to be defined, reported and recovered
from, to buy nothing the renewal does not already buy.

**Rule 3 survives untouched.** The daemon learns nothing about what a runner, a
model or an effort is. It knows four facts about a birth and the only question it
asks a launch word is whether that word mentions one of them; a word that
mentions none is copied. An unknown placeholder is **refused** rather than passed
through, because a Worker started with a literal `{{tier}}` in its argv is a
Worker nobody meant to start.

**What still holds after the move.** A runner directive changes the runner of the
next Worker without anything restarting, and disturbs no Worker in flight. Model
and effort stay out of the launch on purpose: they resolve per tier, per run,
inside the Worker, from the project's own config in the workspace it was born
into — and the one input they take from outside, the runner, is what the launch
carries. The slot-scoped env is composed per birth, from placeholders, so two
Workers of one project can never share a retire file or a build directory.

## Amendment 6 — reaching the two-player model is a re-adoption, not an evacuation (#2910)

Amendment 4 names the migration as its harder half: a machine already running
per-project runtimes has to reach the two-player model without stranding the
Workers those runtimes are holding. The mechanism is **ADR 0105's boot
migration** — the same one `core/red-path-migration.ts` and
`core/castle-cutover-migration.ts` use — planned purely, executed best-effort,
stamped once, and a no-op the second time.

**Decision: the runtime is stopped, the Workers are kept.** A Worker is an
init-system unit, so it outlives the process that asked for it, and the daemon
already re-attaches to it *by unit name*. The previous cutover had to quiesce
Workers because they were born by a path with no unit to be named by; these were
born through the daemon and carry one. Stopping them would strand work the model
can keep, so the migration stops exactly one thing — the removed third player —
and stops it first, so no demand it decides lands behind the migration.

**What travels, and what stays.** The project's label travels with each live
Worker, so a re-adopted Worker appears in `host-state` under the repository it
belongs to rather than under the stated `(unowned)` placeholder. Claims do not
move: the Worker is still working the Ticket, and releasing a live claim would
put a second Worker on the same work. A dead Worker's claim, branch and workspace
stay exactly where they are — the crash reconcile path already returns those
Tickets, and the migration recovers nothing itself.

**The migration never registers the project.** Registering is the MCP's one
contribution to this model, and it carries a selector and an argv only the
project states — a migration that invented either would start Workers on work
nobody asked for. So the migration runs on the registration path, clears the
process that would refuse the registration, and leaves the registering to the
player entitled to make it. It is reported as kept, not as done.

**Idempotent twice over.** The report at `.red/state/castle/two-player.toon` is
also the gate: a second run reads the stamp and touches nothing. Under it, the
plan is idempotent on its own — a dead runtime, a Worker the host already holds,
and a project already registered each produce no action — so a stamp lost to a
wiped state tier costs a re-run, never a second migration's worth of moves.

**It reports both halves.** Everything moved and everything deliberately left
behind is named with its reason, including moves the host refused: an operator's
next step depends on knowing which Worker the host did *not* take.

## Amendment 7 — open work renews a registration, and the daemon owns the renewal (#2973)

Amendment 4 made the registration the thing that keeps a drain alive, and gave it
a deadline. **The deadline shipped and the renewal did not.** `project-renew`
existed on the daemon, was authorized, and was called by nothing: the string
appeared zero times under `apps/dev/src`. A project registered at 22:19 with a
`renew_by` of 22:26 was gone by 22:5x, and the host reported `registrations: 0,
workers: 0` — every drain stopping on its own, silently, within one window.

Both halves are load-bearing and pull against each other: expiry alone stops
every drain, renewal alone makes a closed laptop poll forever. Shipping one
without the other left the daemon strictly worse than the per-project process it
replaced, which at least kept running.

**Decision: a registration is renewed by the project's own OPEN WORK, and the
renewal's owner is the daemon.** Each read of the registration set sustains, at
that same instant, every registration the daemon can see work for — a counted,
positive queue depth from its own poll, or a Worker it is itself holding for that
project — and then lapses whatever is left. The renewal and the lapse are one
decision made from one set of facts, so a project can never be dropped on a fact
some earlier timer left behind.

**Only an observation sustains; silence never does.** A counted **zero** does not
sustain, which is how a project that has finished lapses on schedule and stops
being polled — the deregister-on-drained rule of Amendment 4, arrived at by the
lease rather than by a second mechanism. An outcome no poll could count — an
unreachable tracker, a spent quota — sustains nothing either, and deliberately
so: that is exactly the silence a closed laptop produces, and a registration held
up by silence is the forever-poll the window exists to prevent. A live session
renews straight through such an outage, and a project that has none can register
again in one call.

**A live Worker sustains too, even against a drained selector.** A project whose
last Worker is still landing its Ticket reads as a queue of zero and is manifestly
still draining; retiring the registration out from under it would strand the very
work the deadline is meant to protect.

**The session's own clock is untouched.** `renewed_at` keeps meaning "a session
was heard from", so the three states stay distinguishable and are reported as
such: `renewing` (a live session), `self-renewing` (nobody is watching, and the
daemon is holding this up on the project's own work), `running-on` (nothing is
holding it up, and it will lapse at its deadline).

**The two options rejected, and why.**

*The MCP session renews on a timer while it is alive.* The obvious shape, and it
matches "a registration outlives its session" only until the session ends — so a
drain would still die with the terminal, which is the promise Amendment 4 made and
this would break. It also puts the renewal on the one player that is *not* there
when it matters.

*Renewal as an explicit operator act with a long window.* Simplest and least
surprising, and it leaves the operator holding a timer for a system whose whole
purpose is to run while nobody is watching. A missed renewal would be an operator
error rather than a fact about the work.

**And a lapse is now a stated fact.** A registration that lapsed used simply to
stop being in the set, and every surface then rendered the project as one the host
had never heard of — which is how a stopped drain read as a calm, healthy line.
The daemon keeps a bounded tail of lapses with the instant and the reason, and
`known_projects` is split: a label the host knows because a Worker carries it is
**known by name**, not registered. A statusline that resolved a project from a git
remote and printed `reddb-io/red-skills 0w` over a host holding nothing was
reporting a name as if it were a state.

## Recovering from a bad two-player migration

The way back, for an operator whose machine the migration left confusing. Every
step is safe to run twice, and none of them touches a Worker's branch, workspace
or claim.

1. **Read the report first.** `.red/state/castle/two-player.toon` names what was
   stopped, what was re-adopted, what was registered, and — the field that
   usually explains the symptom — what the host `failed` to take.
2. **Ask the host what it holds.** `redskilled host-state` lists the live Workers
   and their project labels. A Worker running here but absent from that list is
   the one to act on; a Worker present under `(unowned)` was re-adopted without
   its label and can be left running while the project registers again.
3. **Put the project back in the daemon's list.** Re-register from the project's
   MCP (`project_start`). A registration is a record, not a process, so restating
   it costs nothing and a duplicate is refused rather than doubled.
4. **Re-run the migration deliberately.** Remove the stamp
   (`rm .red/state/castle/two-player.toon`) and launch again with
   `RED_TWO_PLAYER_CUTOVER=1`. The plan re-derives from what the machine actually
   carries now, so a move that already succeeded produces no action.
5. **Decline the era to stand still.** Leaving `RED_TWO_PLAYER_CUTOVER` unset
   makes the migration inert: it observes nothing and moves nothing, so a machine
   can be inspected — or left running its Workers — before the cutover is
   declared again.

**What never appears in this list:** stopping a live Worker, deleting a branch,
or releasing a claim. Those are the three things the migration itself refuses,
and a recovery that did them would destroy work the failure did not.
