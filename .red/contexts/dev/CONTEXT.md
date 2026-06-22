# RedSkills Dev

The `dev` context names the engineering workflow language for RedSkills:
triage, AFK execution, handoffs, branch safety, codebase explanation, and
operator-controlled mutations.

## Language

**Issue tracker**:
The repo's GitHub Issues; RedSkills policy is GitHub, never a local tracker or alternate provider.
_Avoid_: backlog manager, backlog backend, issue host, local-markdown tracker

**Issue**:
A single tracked unit of work inside the **Issue tracker**: bug, task, PRD, or implementation slice.
_Avoid_: ticket, except when quoting external systems

**Label family**:
A coherent class of **Issue** labels with one job: current state, permanent type, priority, relationship/dependency, or operational diagnostic.
_Avoid_: loose label, tag bucket

**HITL queue**:
The operator-facing set of non-PRD **Issues** that need human decision resolution, selected by `ready-for-human`.
_Avoid_: human backlog, HITL backlog

**HITL resolution**:
A maintainer-led session that resolves the human decision pending on an **Issue** and, when delegation becomes safe, moves it to `ready-for-agent` with an updated `## Agent brief`.
_Avoid_: manual implementation, human fix session

**HITL selection**:
The hybrid rule for choosing a **HITL queue** item: recommend the next Issue automatically by priority/age, while allowing the maintainer to `skip` to another candidate.
_Avoid_: random pick, manual-only shortlist

**HITL decision extraction**:
The rule for finding the human decision pending on a selected **Issue**: infer it from the issue body, `## Agent brief`, comments, and latest **Envelope** when possible; ask the maintainer to state it when the pending decision is ambiguous.
_Avoid_: decision mining, implicit blocker

**HITL decision recording**:
The rule for persisting a resolved human decision: write an auditable **Directive block** comment, and update `## Agent brief` when the **Issue** becomes delegable to an agent.
_Avoid_: silent brief edit, unaudited decision

**HITL unresolved disposition**:
The final state after a **HITL resolution** that records a decision but still leaves the **Issue** non-delegable: keep `ready-for-human` and record the next pending decision clearly.
_Avoid_: quiet limbo, unpaged human follow-up

**HITL delegable disposition**:
The final state after a **HITL resolution** that makes the **Issue** delegable: add `ready-for-agent` and remove `ready-for-human` so the Issue leaves the **HITL queue**.
_Avoid_: dual-queued issue, stale HITL tag

**Triage role**:
A canonical state-machine label applied to an **Issue** during triage.
_Avoid_: status label, workflow stage

**Directive block**:
A `<details data-kind="directive">...</details>` element written by a human in an issue body or comment.
_Avoid_: instruction, directive comment

**Human guidance**:
The authoritative handoff channel populated from **Directive blocks**; latest guidance wins on conflict.
_Avoid_: HITL comment

**Thread discussion**:
Issue comments that are human-authored, contain no **Directive block**, and are advisory only.
_Avoid_: chatter, background comment

**Envelope**:
A structured `<details data-attempt-status="...">` issue-thread ledger entry posted after an AFK attempt.
_Avoid_: report, attempt log, audit comment

**Task mirror**:
A read-only reflection of AFK worker state onto a runner-native background-task surface.
_Avoid_: native agent, subagent

**Branch lock**:
A local opt-in pin (`.red/tmp/branch-lock.yaml`) that blocks the interactive agent from switching away from one branch in the **Primary checkout**, and — when set — overrides the **Pinned branch** as AFK's base/merge target (precedence lock > pin > main) and toggles the landing: locked work merges into the locked branch for human promotion, unlocked work lands via an admin-merged PR (ADR 0030/0031).
_Avoid_: pinned branch

**Pinned branch**:
The branch an **Issue** or PRD declares that AFK must base work on and merge back into.
_Avoid_: branch lock

**Landing**:
How a completed **Attempt**'s worker branch is integrated into its base, toggled by the **Branch lock** (ADR 0030/0031): a locked branch is merged locally into the locked branch for human promotion (`landMerge`, with a one-shot self-resolve of merge conflicts), an unlocked branch lands via an admin-merged PR carrying the attempt history (`landPr`). Owns the push → integrate → land → post-merge sequence as one operation.
_Avoid_: merge, merge-back, integrate (these are sub-steps of Landing, not the operation)

**Ship (interactive landing)**:
The `/ship` finalizer for already-committed work in an exempt `.red/tmp/work-ship-*/` worktree. It pushes the branch early, opens or reuses a PR, monitors checks and reviews with a time cap, and uses a pure merge gate to either approve/merge normally or park the linked Issue and PR in the **HITL queue**. Contrasts with AFK's autonomous admin-merge landing: Ship respects branch protection and requested changes instead of bypassing review gates.
_Avoid_: AFK landing, admin merge, manual merge

**Primary checkout**:
The developer's main working clone of the repo, contrasted with an AFK **Worktree**.
_Avoid_: main repo, root checkout

**Worker**:
A single AFK orchestrator instance, identified by `w` + 4 characters (e.g. `wZ2R4`). It owns `.red/tmp/workers/{wid}/` and a single `worker.pid` liveness anchor, written once at bootstrap and removed on exit.
_Avoid_: agent, slot, runner

**Worker state reader**:
The single owner of "read a **Worker**'s `afk.state.json`" — `readWorkerState(path)` wraps `parseState` (with the legacy shim), liveness (`isStateActive`), and stage extraction for one file, and `readWorkerStates(root)` globs every worker and maps to normalized, liveness-tagged records. The monitor, statusline, dashboard, **Task mirror**, boot facts, and the **Fleet supervisor** stall-reaper all read through it instead of each re-globbing, re-parsing, and re-deriving liveness — closing the divergent hand-rolled parse path that skipped the schema/shim.
_Avoid_: state glob, status reader (these are the per-consumer loops the Worker state reader replaces)

**OpenCode auth env precedence**:
The order in which AFK selects an API key for the OpenCode runner when multiple are set in the worker process: `OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`. The first set entry wins and the auth key rides in `OpenCodeOptions.env`; OpenCode itself dispatches on the leading segment of the model slug (`openai/...`, `minimax/...`, `openrouter/<vendor>/...`). A user with no key set is fail-closed — the agent spawns without an auth `env` block, OpenCode surfaces its own auth error, the run routes through the normal failure path.
_Avoid_: hardcoded OpenRouter, base-url map, endpoint-specific code

**Endpoint-agnostic provider**:
The design property that the OpenCode runner does not know or care which OpenAI-compatible endpoint it ultimately talks to. AFK propagates only the auth key (per *OpenCode auth env precedence*); OpenCode owns endpoint resolution from the `<provider>/<model>` slug. Adding a new endpoint never requires changes to AFK code — the operator sets the corresponding env-var and a matching slug.
_Avoid_: provider-specific config block, base-url per runner, multi-endpoint fan-out

**Agent runner / Runner spec**:
The provider-facing runner set (`AgentRunner` = claude | codex | opencode | claude-minimax) and the single descriptor table that owns each runner's provider policy — its accepted efforts, whether effort rides the numeric `effort` knob or OpenCode's free-form `variant` channel, any forced model (claude-minimax → MiniMax-M3), and its auth-env resolver. `toAgentRunner` projects the broader orchestrator **Runner** (which also includes the runner-neutral `hermes`) onto this set, collapsing any provider-less runner to `claude`. Adding a provider becomes one table row instead of parallel edits across `buildAgent`, `effortForProvider`, and the tier-table coercion.
_Avoid_: runner detection (that resolves *which* Runner to use; a Runner spec defines *what each provider runner accepts*)

**Attempt**:
One numbered AFK execution of an **Issue**, materialised at `.red/tmp/workers/{wid}/{issue}-a{n}/`. The `a{n}` counter is per-**Issue** across all **Workers**, so each retry — even by a different worker — is a fresh attempt directory.
_Avoid_: iteration, run, retry dir

**Attempt Outcome**:
How an **Attempt** ended, and what that ending *means* for the **Issue**: the single concept (owned by `core/attempt-outcome.ts`) that maps a terminal result to its `blocked:<reason>` label (`blockedLabelFor`), its envelope status (`envelopeStatusFor`), and its bounded-recovery policy key (`recoveryReasonFor`). The historical three-enum smear (`ProcessOutcome` / `BlockedReason` / `RecoveryReason`) is resolved — adding an outcome now touches one set of exhaustive switches.
_Avoid_: process outcome, blocked reason, recovery reason (these were the three views now unified, not separate concepts)

**Attempt disposition**:
What AFK *does* about an **Attempt Outcome** — the single owner that composes the outcome's recovery decision (retry vs escalate, from the cap policy plus the real attempt number), its typed `blocked:*` label, its envelope status, and the standard escalation announcement into one pure descriptor. The worker per-issue path (`routeRecovery`), the no-agent **reconcile** path, and the **Fleet supervisor** stall-reaper all consume the same disposition instead of each re-deriving labels, statuses, and comments. It owns the total `outcome → policy key` map (including `stalled`, which the per-issue `recoveryReasonFor` view deliberately omits).
_Avoid_: recovery routing, park logic (these are the per-site applications of one Attempt disposition)

**Worktree**:
An isolated `git worktree` created by AFK per **Attempt** under `.red/tmp/workers/{wid}/{issue}-a{n}/worktree/`.
_Avoid_: afk clone, sandbox checkout

**Fleet supervisor**:
The OS-process manager behind `/afk fleet`, maintaining a target number of independent AFK workers.
_Avoid_: Claude fleet, task mirror, auto-monitor loop

**Auto-monitor loop**:
An optional session-level observability loop that periodically renders AFK monitor state.
_Avoid_: fleet supervisor, worker scheduler

**Codex monitor agent**:
A Codex TUI sub-agent used only as a read-only AFK state presentation surface.
_Avoid_: AFK worker, supervisor

**Execution environment**:
A non-interactive runtime that drives `/afk --issues N --runner opencode --once` for one attempt per invocation. The two target surfaces are the GitHub Actions lane (the published `reusable-afk-attempt.yml` reusable workflow in `reddb-io/red-skills`) and the k8s lane (a container image + `Job` manifest the team runs on a self-hosted cluster). Both share the same runtime contract — one attempt, one issue, one PR, no fleet — and differ only in trigger and secret-injection surface. Issue [#631](https://github.com/reddb-io/red-skills/issues/631) (ADR 0059) tracks the k8s piece; the GHA piece lands in this slice.
_Avoid_: GHA-only, k8s-only, CI lane, production lane

**Actions lane**:
The GitHub Actions surface of the **Execution environment** — the published `reusable-afk-attempt.yml` reusable workflow in `reddb-io/red-skills/.github/workflows/`. The file exposes **three triggers in one**: `workflow_call` (caller invokes directly), `workflow_dispatch` (manual from the Actions UI), and `issues: types: [labeled]` (auto-fires when the `ready-for-agent` label is applied; the `if:` filter restricts to exactly that label). The trust gate is rigorous by default (author + label-applier must be in the caller-supplied allowlist). Per invocation: one attempt, one issue, one PR, no admin-merge.
_Avoid_: GHA, reusable workflow (when referring to the lane), CI job

 slot

**Skill**:
An agent-loadable behavior package rooted at a `SKILL.md` plus optional support files.
_Avoid_: command, plugin

**Codebase understanding surface**:
A `dev` workflow surface for explaining repository architecture and change impact from graph-backed project knowledge.
_Avoid_: wiki graph, understand plugin

**Zoom-out answer**:
The map-first answer shape for `zoom-out`: modules, relationships, critical paths, and risks before raw evidence.
_Avoid_: graph dump, architecture chat

**Impact-aware zoom-out**:
The `zoom-out` deepening that explains structural and observed change impact for a focused file, symbol, module, skill, or concept.
_Avoid_: impact skill, PR dashboard, graph-only impact

**Ask surface**:
A deferred `dev` skill surface for natural-language engineering questions over project knowledge.
_Avoid_: understand, codebase chat

**Skill curator**:
The `dev` mutating curator workflow that consumes Memory recommendations and archives approved curatable skills.
_Avoid_: memory cleaner, silent curator

## Relationships

- An **Issue tracker** holds many **Issues**.
- An **Issue** carries one **Triage role** at a time.
- Every **Issue** label should belong to a clear **Label family**; labels outside state, type, priority, relationship/dependency, or operational diagnostic families are candidates for removal or deprecation.
- The **HITL queue** contains non-PRD **Issues** selected by the `ready-for-human` state.
- **HITL selection** chooses one recommended **Issue** from the **HITL queue** and lets the maintainer `skip` when that Issue is not the right decision target.
- **HITL decision extraction** identifies the pending decision for the selected **Issue** before **HITL resolution** begins.
- **HITL decision recording** preserves the maintainer's answer as **Human guidance** and prepares the **Issue** for delegation when possible.
- A **HITL resolution** consumes one **Issue** from the **HITL queue** and may produce a `ready-for-agent` **Issue**.
- A non-delegable **HITL resolution** keeps the **Issue** in `ready-for-human` with the next pending decision stated explicitly.
- A delegable **HITL resolution** moves the **Issue** to `ready-for-agent` and removes all labels that keep it in the **HITL queue**.
- An **Issue** accumulates **Envelopes**, **Directive blocks**, **Human guidance**, and **Thread discussion**.
- A **Fleet supervisor** maintains AFK workers; **Auto-monitor loop**, **Task mirror**, **Codex monitor agent**, and `monitor.sh` only observe.
- A **Worker** owns many **Attempts**; each **Attempt** resolves exactly one **Issue** and holds one **Worktree**. The **Worker**'s `worker.pid` is the single liveness signal consumers read.
- A **Branch lock** constrains the **Primary checkout**; AFK **Worktrees** remain exempt.
- A **Pinned branch** constrains AFK base and merge target; a **Branch lock**, when set, overrides it (precedence lock > pin > main) and additionally toggles how completed work lands (locked → local locked branch; unlocked → admin-merged PR).
- **Ship (interactive landing)** consumes a prepared ship **Worktree** tail and may move the linked **Issue** into the **HITL queue** when reviews, branch protection, checks, or the time cap block a normal merge.
- The **Codebase understanding surface** may read Memory graph evidence, but it does not own graph storage or ingest.
- The mutating **Skill curator** belongs to `dev`; telemetry evidence and reports belong to the Memory context.

## Example dialogue

> **Dev:** "This **Issue** is `ready-for-agent`; should AFK pick it up?"
> **Domain expert:** "Yes, unless a newer **Directive block** changes the brief. The worker should create a **Worktree**, post an **Envelope**, and merge back to the **Pinned branch**."

## Flagged ambiguities

- "backlog" previously meant both the issue-hosting tool and the body of work; resolved: use **Issue tracker** for the tool and avoid "backlog" as a domain term.
- "branch lock" and "pinned branch" were previously conflated; resolved: **Branch lock** is the operator's local opt-in (interactive enforcement *plus* the higher-precedence AFK base/landing toggle, ADR 0030/0031), while **Pinned branch** is the per-Issue/PRD base declaration the lock overrides when present.
