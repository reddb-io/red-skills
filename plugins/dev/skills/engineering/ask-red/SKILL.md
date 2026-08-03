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
does not already belong on the tracker. It still runs on the castle engine under
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
  still owned by the castle curator; route it to `/hitl` only after the bounded
  curator re-checks have changed it to `ready-for-human`.
- **A manual implementation slice** -> `/implement`, using `/tdd` for the build
  loop and `/code-review` before handing the branch to `/retake`.
- **Validation or visible confirmation** -> `/verify`; for browser-visible state,
  pair it with `/ground-truth`.
- **Operations state** -> `/dashboard`, `/daily-review`, `/red-gains`, `/audit-skills`, or
  `/context` depending on whether the question is queue health, period review,
  rsp usage gains, skill quality, or repository context. For operational
  troubleshooting, route to the owning reference: `/afk`, `/go`, `/hitl`, or
  rsp.
- **"What is this host running right now?"** -> the `redskilled` daemon's own
  `dashboard` command, not a plugin surface. It is the host view — every Worker
  on the machine, whichever project owns it — at terminal density, so it answers
  where no plugin is installed. `/dashboard` stays the route for this
  repository's queue health; `/red-statusline` owns the one-line form and
  documents both in its host notes.
- **Operating the castle itself** -> the `castle` MCP, not a shell command.
  Fleet lifecycle, worker dispatch, runners and live steer, gate, landing,
  claim, worktrees, hygiene, and observability are all tools on one canonical
  interface (ADR 0120); `/afk` and `/go` are its clients. The tool surface is
  `plugins/dev/skills/engineering/afk/MCP.md`. Repo owners tune worker-slot
  throughput through `/afk` config: `afk.landing.wait` chooses release after
  merge, green CI, or PR-open; route that choice to the AFK config reference.
- **Carrying one effort end to end** -> `/manager`. It is the liaison over the
  lanes above, not a replacement for them: `$dev:manager <intent>` starts or
  continues an effort and `manager status` renders its brief. Routing and
  dispatch still land on `/afk`, `/go`, and the planning on-ramps.
- **Design uncertainty** -> `/prototype`; if the uncertainty is too broad for
  one throwaway answer, use `/wayfinder`.
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
`/to-spec`, `/zoom-out`, `/prototype`, `/verify`, `/code-review`,
`/resolving-merge-conflicts`, `/branch-lock`, `/git-guardrails-claude-code`,
`/migrate-to-shoehorn`, `/setup-pre-commit`, `/research`, `/ff`, `/reflect`,
`/handoff`, `/write-a-skill`.

The LLM Wiki routes ship with the `memory` plugin as `/memory:wiki-init` and
`/memory:wiki`, not with `dev`, so they stay out of this inventory.

Capability references registered by owner:
`castle` MCP (the canonical castle interface) ->
`plugins/dev/skills/engineering/afk/MCP.md`;
`/afk` landing-tail throughput (`afk.landing.wait`) ->
`plugins/dev/skills/engineering/afk/docs/CONFIG.md`;
the host view a terminal can read (the `redskilled` daemon's `dashboard`
command, and the `statusline` line it shares a render with) ->
`plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md`;
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
  runs the shared operational probe registry that fleet boot also consumes. The host toolchain
  drift routes here too: it checks `gh >= 2.47.0` and pinned `tq` read-only, while
  `/red-doctor --fix` gates the user-level asdf upgrade and canonical tq installer.
- `/red-gains` reports whether rsp is paying for itself: latency, throughput,
  token savings, command-family winners, and degradation health from telemetry;
  use `apps/rsp/docs/TROUBLESHOOTING.md` for rsp hook silence, resident/store,
  and store-growth incidents.
- `/red-setup` and `/red-statusline` are setup/adoption routes, not
  feature-work routes. `/red-setup` owns `.red/config.yaml` authoring through its
  shipped config template and post-write loader check.
- Execution-daemon provisioning is a setup route, not a feature-work one:
  `/red-setup` (Section E3) provisions `redskilled` by running `redskilled
  provision`, and `/red-doctor` (check 24) reports whether the host is
  provisioned. The daemon's home `~/.red/redskilled/` belongs to `redskilled`
  itself (ADR 0130 Amendment 2), never to `/red-setup`, whose `.red/` authority
  is repository-scoped.
- TOON/TOONL operational reader changes are documentation-maintenance work:
  `/red-setup` owns the pinned `tq` host binary, `/red-doctor` verifies it, and
  `/afk` plus `/daily-review` own the lane-reading examples.
- `/retake` reconstructs one Ticket's real state — PRs, branches, worktrees,
  uncommitted work, blocker — then acts on it: requeue into `ready-for-agent`,
  adopt a hand-done branch through the no-agent gate, or hand off to `/hitl`.
- An on-fire Ticket carries the `priority:urgent` label; the `/afk` queue
  promotes it ahead of every `--spec` / `--issues` filter.
- `/adr-editor` is the totipotent editor over the `.red/adr/` collection. It
  opens by asking which subject to work on, offering the collection's real INDEX
  themes and title-term clusters with counts, then reports and mutates that slice:
  list, group by subject, surface inconsistencies, add, remove, rewrite, merge,
  split, archive, renumber, and re-index all apply in-session. One confirmation
  gates a destructive or wide batch; `/to-spec` is an offered escape hatch for
  genuinely large batches, never a required route.
- `/model-tier-policy` answers runner/model tier choices; `runner_list` and
  `runner_detect` on the `castle` MCP answer which backend a host resolves to.
- `/zoom-out`, `/research`, `/handoff`, `/ff`, and `/reflect` are understanding
  or productivity routes that feed the main flow.
- `/branch-lock`, `/git-guardrails-claude-code`, `/migrate-to-shoehorn`, and
  `/setup-pre-commit` are targeted utility routes.
- `/code-review` is the two-axis diff review; hand-worked landing routes through
  `/retake`.
- `/curate` is the interactive skill archive route.

</supporting-info>
