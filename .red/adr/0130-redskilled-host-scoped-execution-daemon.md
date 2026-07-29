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

1. **Singleton and scope.** One daemon per user session, reached over a unix
   socket, with `machineIdHash` labelling the host. The vendored red-castle
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

- **Attempt is extinct, and this record supersedes ADR 0128 entirely.** Since
  ADR 0103 made a retry a fresh Worker, a Worker already *is* one worker × one
  ticket × one try; the Attempt was a synonym carrying its own lane, contract
  and retention rule. What 0128 got right survives without it: liveness keeps
  exactly one anchor, and that anchor is now the daemon, which owns process
  death by construction — a stronger authority than the record it replaces, and
  still never a pid file. The janitor's reclaim rule and the re-seed budget of
  **ADR 0129** re-anchor from the Attempt onto the Worker; those are renames,
  not redesigns.

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
