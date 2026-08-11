---
name: ask-red
description: Ask which RedSkills flow fits the current situation. Use when the operator asks what to do now, which command to run, or how to route a task through RedSkills.
disable-model-invocation: true
---

# Ask Red

You do not need to remember every RedSkills command. Ask the router.

A **flow** is a path through skills, not a single command. RedSkills has one
default lane, one exception lane, and several on-ramps that feed those lanes.

<what-to-do>

## 1. Classify The Situation

**Tracked work defaults to `/afk`.** If the work is already a Ticket, should be a
Ticket, or belongs to a Spec, route it through `/afk`. This is the modus
operandi. `/afk` boot owns the Docs Sweep, so stranded `.red/` glossary/ADR docs
auto-land or halt before worker dispatch rather than becoming a separate route.

**Ad-hoc work goes to `/go`.** Use `/go` only for a concrete one-off demand that
does not already belong on the tracker. It still runs on the `red-castle` engine under
the shared worker root, with `current.kind=go`; read-only investigations use
`/go --scout` with `current.kind=scout`. If the work is already tracked, keep it
in `/afk`; if it is parked, use `/retake` or `/hitl`.

**Ideas become Specs before execution.** For a fuzzy idea that fits in one
conversation, run `/start`, then `/to-spec`, then `/to-tickets`, then `/afk`.
For a huge or foggy effort, start with `/wayfinder`; its children later route
back into `/start`, `/to-spec`, `/to-tickets`, `/afk`, or `/hitl`.

## 2. Route By On-Ramp

- **Incoming bugs, requests, or executable ticket readiness** -> `/triage`, then `/afk` once Tickets become
  ready for agents. `/triage` owns the acceptance-criteria lint for `ready-for-agent` candidates; `/red-doctor` reports the same check read-only when auditing queue health.
- **A bug you can reproduce or diagnose now** -> `/diagnose`; if the user is
  only reporting a bug for later, use `/report-bug`.
- **A parked human decision** -> `/hitl`; if the blocker is resolved and the
  Ticket only needs queue promotion, use `/retake`. A `quarantine` Ticket is
  still owned by the Issue curator; route it to `/hitl` only after the bounded
  curator re-checks have changed it to `ready-for-human`.
- **A manual implementation slice** -> `/implement`, using `/tdd` for the build
  loop and `/code-review` before handing the branch to `/retake`.
- **Validation or visible confirmation** -> `/verify`; for browser-visible state,
  pair it with `/ground-truth`.
- **Writing or editing an agent-read document** -> `/writing-for-agents`,
  including a `SKILL.md`, `AGENTS.md`, `CLAUDE.md`, or reference reached through
  a context pointer.
- **Operations state** -> `/dashboard`, `/daily-review`, `/red-gains`, `/audit-skills`, or
  `/context` depending on whether the question is queue health, period review,
  rsp usage gains, skill quality, or repository context. For operational
  troubleshooting, route to the owning reference: `/afk`, `/go`, `/hitl`, or
  rsp.
- **Host daemon status, provisioning, policy, or lifecycle** -> `/redskilled`.
  It reads the daemon's socket, version, registrations, Workers, ceilings, and
  setting origins; provisions the daemon-owned home; edits host policy; and
  restarts through the survival-reporting stop path. `/dashboard` stays the
  route for this repository's queue health, while `/red-statusline` owns the
  one-line host adapter.
- **"What is the Worker on issue N doing, or why did it never start?"** ->
  `/redskilled <n>` (or `/redskilled #<n>`). The numeric argument selects the
  same skill's read-only debug entry: it resolves the issue to its Worker(s)
  through the redskilled MCP and the documented lane fallback, then writes a
  self-serve dossier — fiche, event sequence, log excerpts with full paths, and
  a diagnosis naming the operator's next commands — to
  `.red/tmp/diagnostics/redskilled-debug-<n>-<timestamp>.md`. A Worker the
  daemon refused at birth still gets one. Reconstructing the Ticket's *work*
  state instead — PRs, branches, worktrees, blocker — stays with `/retake`.
- **A superseded-engine warning** -> run the exact
  `npx -y -p @reddb-io/red-skills@<version> red-skills-dev reconcile-engine`
  command printed by the warning, then retry the dispatch. The
  command warms that published dev bundle and re-points a standing registration
  in one operation; no separate plugin name, version lookup, or re-registration
  is required.
- **Operating project execution** -> the `redskilled` MCP, not a shell command.
  Call its `help` tool first and follow the pasteable next action it derives
  from live host state; it is the sole runtime source of execution choreography
  (ADR 0134). `/afk` and `/go` are clients of that canonical interface. The
  tool protocol is `plugins/dev/skills/engineering/afk/MCP.md`. Repo owners tune worker-slot
  throughput through `/afk` config: `afk.landing.wait` chooses release after
  merge, green CI, or PR-open; route that choice to the AFK config reference.
  A merge-queue ejection, or a clean fleet PR found outside the queue, belongs
  to AFK's automatic `current.kind=repair` Worker lane; route to `/hitl` only
  after that lane attaches a genuinely semantic queue failure to the owning
  Ticket. A mechanical ejection is not a `/retake` or human-requeue task.
  Human-attached `/go` and scout dispatches skip a saturated AFK line through
  the host's bounded interactive reservation; route its default, host override,
  and slot-surface accounting to `/go`.
- **Carrying one effort end to end** -> `/manager`. It is the liaison over the
  lanes above, not a replacement for them: `$dev:manager <intent>` starts or
  continues an effort and `manager status` renders its brief. Routing and
  dispatch still land on `/afk`, `/go`, and the planning on-ramps.
- **Design uncertainty** -> `/prototype`; if the uncertainty is too broad for
  one throwaway answer, use `/wayfinder`.
- **The last reply did not land** -> `/wait-what`. It re-pitches that reply in
  Simplified Technical English and the owning `.red/contexts/<name>/CONTEXT.md`
  vocabulary without starting a new investigation.
- **The needed knowledge belongs to another person** -> `/to-questionnaire`.
  It asks who will receive the questionnaire and what must come back, then writes
  the questions for that recipient; it does not interview the user about the
  missing subject knowledge.
- **A setup or cutover has human-only steps** -> `/wizard`. The agent performs
  the automatable work directly and generates an interactive Bash guide for
  browser actions, credentials, secrets, or confirmations only a human can do.
- **Corpus knowledge graph requests** -> memory plugin surfaces. For "build a
  knowledge graph of this repo", "query the graph of these docs", or similar,
  use `/memory:init` in graph mode when needed, then `/memory:ingest` to graph
  the corpus, `/memory:view` or `memory docs reference-graph` to inspect it,
  `memory communities` / `memory dashboard` / `memory capabilities` for analysis
  reports, and `/memory:export` for a self-contained bundle.

## 3. Answer With The Route

Return the smallest useful flow, in order. Name the first command to run and the
handoff condition for the next command.

Use this form:

```text
Route: /first -> /second -> /final
Start with: /first
Why: <one sentence>
Next handoff: <what must be true before the next command>
```

</what-to-do>

<supporting-info>

## Coverage Inventory

The router must mention every published dev skill so `/red-doctor` can flag drift:
`/afk`, `/ask-red`, `/go`, `/manager`, `/wayfinder`, `/model-tier-policy`, `/curate`,
`/context`, `/daily-review`, `/dashboard`, `/audit-skills`, `/diagnose`,
`/ground-truth`, `/red-doctor`, `/adr-editor`, `/start`, `/triage`, `/hitl`,
`/report-bug`, `/retake`, `/improve-codebase-architecture`,
`/red-setup`, `/red-gains`, `/red-statusline`, `/implement`, `/tdd`, `/to-tickets`,
`/redskilled`, `/to-spec`, `/zoom-out`, `/prototype`, `/verify`, `/code-review`,
`/resolving-merge-conflicts`, `/branch-lock`, `/git-guardrails-claude-code`,
`/migrate-to-shoehorn`, `/setup-pre-commit`, `/research`, `/ff`, `/reflect`,
`/wait-what`, `/to-questionnaire`, `/handoff`, `/writing-for-agents`, `/wizard`.

The LLM Wiki routes ship with the `memory` plugin as `/memory:wiki-init` and
`/memory:wiki`, not with `dev`, so they stay out of this inventory.

Capability references registered by owner:
`redskilled` MCP (the canonical project interface; start with its situational
`help` tool, while `status {scope: worker | project | host}` provides scoped
read-only diagnostics, and a visible project `birth_latch` routes through its
structured `project_reset` repair) ->
`plugins/dev/skills/engineering/afk/MCP.md`;
`/afk` landing-tail throughput (`afk.landing.wait`) ->
`plugins/dev/skills/engineering/afk/docs/CONFIG.md`;
`/afk` local validation authority (`plugins.dev.afk.validation.{iteration,post_done,landing}`) ->
`plugins/dev/skills/engineering/afk/docs/CONFIG.md`;
`/afk` task-class runner routes (`plugins.dev.afk.routes.{validate,simple,complex,think}`),
their override precedence, and `/red-setup` interview ->
`plugins/dev/skills/engineering/red-setup/INTERVIEW.md` and
`plugins/dev/skills/engineering/afk/docs/CONFIG.md`;
`/red-setup` Release standard (`release.*` contract, including the detect–propose–confirm
pass over Version surfaces and the `RELEASE_PAT` triggering-push prerequisite) ->
`plugins/dev/skills/engineering/red-setup/INTERVIEW.md` and
`plugins/dev/skills/engineering/red-setup/config-template.yaml`;
`/afk` ADR 0136 ownership (Landing hands native intent to the Queue Custodian
and ends, Verdict has no classification hook, and the Park exposes one
authority-parameterized requeue door) ->
`plugins/dev/skills/engineering/afk/SKILL.md`;
`/afk` Verdict policy (one capped environment ledger, repeated-signature park,
and the declared sub-second branch-fault escape beside Validation moments) ->
`plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md` and
`plugins/dev/skills/engineering/afk/docs/CONFIG.md`;
`/afk` after-fork reversion/test-line intent finding
(`red.afk.branch-reversion.v1`, with its pasteable restoration repair) ->
`plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md`;
`/go` interactive admission (`REDSKILLED_INTERACTIVE_RESERVATION`) ->
`plugins/dev/skills/engineering/go/SKILL.md`;
`/go` disposable boot-failure diagnosis and its 30-day local retention ->
`plugins/dev/skills/engineering/go/TROUBLESHOOTING.md`;
the host view a terminal can read (the `redskilled` daemon's `dashboard`
command, and the `statusline` line it shares a render with) ->
`plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md`;
engine delivery repair (the `reconcile-engine` dev CLI subcommand) ->
`apps/dev/src/runtime/reconcile-engine.ts`;
territory scoping (`tag:<value>` labels, `/afk --tags`/`--user`) ->
`plugins/dev/skills/engineering/red-setup/triage-labels.md`.

Troubleshooting references registered by owner:
`/afk` -> `plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md`;
`/go` -> `plugins/dev/skills/engineering/go/TROUBLESHOOTING.md`;
`/hitl` -> `plugins/dev/skills/engineering/hitl/TROUBLESHOOTING.md`;
rsp -> `apps/rsp/docs/TROUBLESHOOTING.md`.

Cross-plugin capability route: `corpus-to-knowledge-graph` lives in the
`memory` plugin. Route by the capability description, not by implementation
vocabulary: corpus ingest goes through `/memory:ingest`; graph inspection goes
through `/memory:view`, `memory docs reference-graph`, and
`memory communities`; analysis surfaces include `memory dashboard` and
`memory capabilities`; portable snapshots go through `/memory:export`.

## Standalone And Maintenance Routes

- `/red-doctor` checks RedSkills adoption drift, including whether this router still
  covers the registered skill set, reports/fixes ADR 0098 tmp janitor hygiene, and
  runs the shared operational probe registry that fleet boot also consumes. It
  also reports both detection-only runtime censuses: the process census counts
  active Worker units, daemon-held Workers, stamped orphans, unstamped suspects,
  and dump files (inspect it directly with `npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled reap --report`);
  the lane census reports registered project and host TOONL bytes/lines against
  their ceilings, unregistered lanes, and dead-pid temps,
  and compares configured Validation moment declarations with the lifecycle
  engine registry, so a schedule key the engine would ignore is visible before
  a drain. It also
  reports a project registration that lapsed while executable work remains queued;
  recovery belongs to the daemon's AFK runtime belt. The host toolchain
  drift routes here too: it checks `gh >= 2.47.0` and pinned `tq` read-only, while
  `/red-doctor --fix` gates the user-level asdf upgrade and canonical tq installer.
- `/red-gains` reports whether rsp is paying for itself: latency, throughput,
  token savings, command-family winners, and degradation health from telemetry;
  use `apps/rsp/docs/TROUBLESHOOTING.md` for rsp hook silence, resident/store,
  and store-growth incidents.
- `/red-setup` and `/red-statusline` are setup/adoption routes, not
  feature-work routes. `/red-setup` owns `.red/config.yaml` authoring through its
  shipped config template and post-write loader check, including inspection and
   human confirmation of `plugins.dev.afk.setup` when a repository's package or
   hook manager determines how fresh AFK Worktrees install dependencies, plus
   package-manifest harness discovery and confirmation of the proposed
   `plugins.dev.afk.validation` schedule. Immediately after that schedule it owns
   the Release standard interview and the confirmed top-level `release.*` block;
   runtime release behavior belongs to the release engine, not the router.
- Execution-daemon operation is a host route, not a feature-work one:
  diagnose through the redskilled MCP's read-only `status {scope: host}` first; no
  redskilled tool provisions or reclaims the host.
  `/redskilled` owns provisioning, host policy, status, and lifecycle;
  `/red-doctor` (check 24) reports whether the host is provisioned. The daemon's
  home `~/.red/redskilled/` and host policy file `~/.red/config.yaml` belong to
  the daemon (ADR 0130 Amendment 2). `/red-setup` only calls that provisioner
  while setting up a repository because its own `.red/` authority is
  repository-scoped.
- TOON/TOONL operational reader changes are documentation-maintenance work:
  `/red-setup` owns the pinned `tq` host binary, `/red-doctor` verifies it, and
  `/afk` plus `/daily-review` own the lane-reading examples.
- `/retake` reconstructs one Ticket's real state — PRs, branches, worktrees,
  uncommitted work, blocker — then acts on it: requeue into `ready-for-agent`,
  adopt a hand-done branch through the no-agent gate, or hand off to `/hitl`.
- An on-fire Ticket carries the `priority:urgent` label; the `/afk` queue
  promotes it ahead of every `--spec` / `--issues` filter.
- `/adr-editor` is the proposal-driven reverse grill over the active `.red/adr/`
  collection. It ranks active ADR clusters, recommends where to start, and works
  one cluster per PR. Inside that cluster it confronts each ADR with code, tests,
  documentation, and newer ADR evidence, then presents P01, P02, and so on — one
  proposal per turn — until every active record has an explicit disposition.
  Accepted proposals accumulate behind one full-text/diff preview and one
  destructive-batch confirmation; all eleven ADR operations remain available.
- `/model-tier-policy` answers runner/model tier choices; `runner_list` and
  `runner_detect` on the `redskilled` MCP answer which backend a host resolves to.
- `/zoom-out`, `/research`, `/handoff`, `/ff`, and `/reflect` are understanding
  or productivity routes that feed the main flow.
- `/branch-lock`, `/git-guardrails-claude-code`, `/migrate-to-shoehorn`, and
  `/setup-pre-commit` are targeted utility routes.
- `/code-review` is the two-axis diff review; hand-worked landing routes through
  `/retake`.
- `/curate` is the interactive skill archive route.

</supporting-info>
