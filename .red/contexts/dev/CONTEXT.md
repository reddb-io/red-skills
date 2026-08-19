# RedSkills Dev

The `dev` context names the engineering workflow language for RedSkills:
triage, AFK execution, handoffs, branch safety, codebase explanation, and
operator-controlled mutations.

## Language

**Issue tracker**:
The repo's GitHub Issues; RedSkills policy is GitHub, never a local tracker or alternate provider.
_Avoid_: backlog manager, backlog backend, issue host, local-markdown tracker

**Ticket**:
A single tracked unit of work inside the **Issue tracker**: bug, task, **Spec**, or implementation slice. GitHub materialises a Ticket as an Issue.
_Avoid_: issue, except when naming the GitHub object itself (upstream v1.1.0 rename, adopted; historical ADRs/envelopes keep "issue")

**Spec**:
The specification document for a body of work — problem, solution, user stories, human and implementation decisions — published to the **Issue tracker** as a parent **Ticket** and sliced into child Tickets.
_Avoid_: PRD, except when reading historical ADRs, labels, or envelopes (upstream v1.1.0 rename, adopted)

**Label family**:
A coherent class of **Ticket** labels with one job: current state, permanent type, priority, relationship/dependency, or operational diagnostic.
_Avoid_: loose label, tag bucket

**Tag label (`tag:<value>`)**:
The territory-scoping **Label family** (`tag:backend`, `tag:infra`) that partitions one shared `ready-for-agent` pool between several humans' **Demand producers**. A **Work selector**'s `tags` facet ANDs over them — a **Ticket** must carry every requested tag label, so an untagged Ticket sits outside every tag-scoped selector — while an unfiltered `/afk` still drains everything. Stamped at creation time (`/go --tags`, `/to-spec`, `/to-tickets` with Spec→Ticket inheritance; missing labels auto-created); never drives lifecycle transitions. Always the two-word name.
_Avoid_: territory (as a label name), bare "tag", topic label, fleet tag (the Fleet is extinct, ADR 0130 — a tag scopes a **Work selector**)

**HITL queue**:
The operator-facing set of non-Spec **Tickets** that need human decision resolution, selected by `ready-for-human`.
_Avoid_: human backlog, HITL backlog

**Quarantine**:
An issue-local AFK safety hold (`quarantine` with `ready-for-agent` removed) applied when a boot probe finds state that requires judgment, or when the **Heal ledger** refuses a third repair in 24 hours. The probe appends its diagnosis to the Ticket body; healthy siblings keep draining.
_Avoid_: global probe halt, needs-triage fallback, test quarantine

**Issue curator**:
The project MCP resident's periodic reconciliation owner for **Quarantine**. It re-runs issue coherence, restores `ready-for-agent` when the defect dissolves, and parks `ready-for-human` for **HITL resolution** after three failed re-checks.
_Avoid_: supervisor sweep, manual quarantine cleanup

**Heal ledger**:
Durable per-Ticket repair history in the project **State tier**. It permits at most two mechanically provable heals per rolling 24-hour window; the third repair request becomes **Quarantine** with the history included in the diagnosis.
_Avoid_: retry counter, attempt ledger

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
A structured `<details data-attempt-status="...">` issue-thread ledger entry posted by an AFK **Worker**. The attribute name is frozen wire vocabulary from before ADR 0130 extinguished the Attempt; readers still parse that literal string, and it describes the Worker's run, not a live unit called an attempt.
_Avoid_: report, worker log, audit comment; attempt envelope, attempt status (the attribute keeps the retired word, the concept does not)

**Task mirror**:
A read-only reflection of AFK worker state onto a runner-native background-task surface.
_Avoid_: native agent, subagent

**Branch lock**:
A local opt-in pin (`.red/state/branch-lock.yaml`) that blocks the interactive agent from switching away from one branch in the **Primary checkout**, and — when set — overrides the **Pinned branch** as AFK's base/merge target (precedence lock > pin > **Trunk**) and toggles the landing: locked work merges into the locked branch for human promotion, unlocked work lands via an admin-merged PR (ADR 0030/0031). Legacy readers may still recognize the old tmp location during migration, but the canonical home is the state tier.
_Avoid_: pinned branch

**Pinned branch**:
The branch an **Issue** or Spec declares that AFK must base work on and merge back into.
_Avoid_: branch lock

**Trunk**:
The repo's configured focal branch — the default base every AFK **Worktree** forks from and the default target a **Landing** integrates into, always read as its fresh-fetched remote ref, never as the local working-tree branch. Defaults to `main` but is repo-configurable (e.g. `develop`); a **Pinned branch** or **Branch lock** overrides it (precedence lock > pin > trunk).
_Avoid_: main (as a hardcoded assumption), default branch, primary branch

**Landing**:
How a completed **Worker** hands its branch toward its base, toggled by the **Branch lock** (ADR 0030/0031, write target moved to the remote by ADR 0083): a locked branch is integrated on `origin/<locked-branch>` for human promotion by pull (`landMerge`, with a one-shot self-resolve of merge conflicts); an unlocked branch opens an admin PR carrying the Worker history, arms the forge's native merge intent, records the custody hand-off, and ends. Never writes to the **Primary checkout**. **Landing does not wait for the PR to merge**: the **Queue Custodian** owns that durable outcome after hand-off, including a vanished intent, while the forge closes the Ticket when the merge lands. A Worker that resumes polling, classifying an ejection, or closing the Ticket after hand-off is taking custody back and creating a second owner.
_Avoid_: merge, merge-back, integrate (these are sub-steps of Landing, not the operation)

**Baseline comparison**:
The feedback gate's evidence probe for a FAILED branch gate: failing checks are re-run against the base worktree solely to supply the **Verdict** with base/environment facts. A probe that OOMs, crashes, or cannot be set up is an environment round; the next round re-materialises the uncached baseline before judging the branch. Comparison-only by construction: it files nothing, downgrades nothing, and never blocks another branch's **Landing**.
_Avoid_: baseline probe as a main-health check, pre-existing-failure downgrade, tracked-red

**Verdict**:
The one pure owner of a failed Validation round: check records, round history, and environment facts enter; fault (`branch`, `environment` with a cause, or `base`), budget effect, and park-now leave. Every environment cause consumes one capped, per-cause ledger; an identical signature fast-parks, exhaustion parks as infra, and neither can charge the branch. A repository whose declared suite legitimately fails in under one second declares `plugins.dev.afk.validation.subsecond_failures_are_branch_fault: true` beside its Validation moments; no runtime classification hook exists.
_Avoid_: classifier stack, infra override hook, correction ledger, validation-infra retry budget

**Park**:
The Ticket's one durable non-executable state and the one door out of it. `blocker-state` alone parses, writes, and clears the active `## Current blocker`; a `status: blocked` block with missing required fields remains active and names `malformed-blocker-state` instead of failing open. Every return to `ready-for-agent` crosses the same `applyRequeue` transition — freshness check, claim sweep, blocker archive, Directive audit, and labels — with `machine` or `human` authority as an input, never a rival applier. Machine authority accepts only mechanical kinds; human authority may resolve any kind through that same door.
_Avoid_: label-only requeue, local blocker parser, caller-owned requeue sequence, a second requeue helper

**Main-red repair lane — RETIRED (#2380)**:
The historical post-merge lane in which the baseline probe auto-filed a `priority:urgent` "main-red repair" issue and **Landing** refused to admin-merge until that issue existed (`blocked:main-red-untracked`). Retired because it contradicts the doctrine that **all problems are resolved in the PR before merge**: branch protection enforces green required checks on an up-to-date branch, so a code-caused red trunk is impossible by construction, and every repair issue the lane ever filed was a false positive that froze the pipeline (probe OOM, stale feedback worktree). What replaced it is **Baseline comparison** — evidence for one branch's verdict, never a tracked issue and never a global land block. If real CI on the **Trunk** turns red from a flake or infra fault, that is a human notification concern, not an auto-filed land-blocker.
_Avoid_: main-red repair issue, tracked-red gate, post-merge repair, `blocked:main-red-untracked`

**Docs Sweep**:
The `/afk` boot phase that enforces origin-visible `.red/` documentation before any worker dispatch. It detects stranded glossary docs (`.red/CONTEXT.md`, `.red/CONTEXT-MAP.md`, `.red/contexts/**`) and ADRs (`.red/adr/**`) from dirty, untracked, ignored, and ahead-of-origin state; auto-lands one `docs:` PR through the ADR 0092 isolated lane when publishable; and halts boot with the explicit relative file list when origin reachability or landing fails.
_Avoid_: handoff doc injection, best-effort docs warning

**Ship (interactive landing) — RETIRED (ADR 0081)**:
The historical `/ship` finalizer for already-committed work in an exempt `.red/tmp/work-ship-*/` worktree. Retired by ADR 0081: its roles are subsumed by the dispatch tiers — hand-done work routes through **requeue** (the no-agent landing lane, ADR 0055), and the review→test→lint→PR→CI line is the shared internal validation gate reached automatically by `/go` and `/afk`. The term survives only for reading historical envelopes and ADRs; never suggest `/ship` as a live command.
_Avoid_: suggesting `/ship` for new work (use `/go`, `/afk`, or requeue)

**Primary checkout**:
The developer's main working clone of the repo, contrasted with an AFK **Worktree**.
_Avoid_: main repo, root checkout

**Working mode**:
One of the four ways work enters RedSkills, and the fact every skill text must name rather than leave the reader to infer: **interactive** (a human drives a coder CLI in a fresh **Worktree**, iterates, and lands a PR), **spec-driven** (`/start` lands ADRs from a Worktree, `/to-spec` and `/to-tickets` publish **Tickets**, `/afk` hands the queue to **redskilled**), **ad-hoc** (`/go` mints one Ticket and hands it to redskilled at once), and **ADR-editing** (`/adr-editor` lands ADR changes from a fresh Worktree). Interactive and ADR-editing Worktrees stay under the client checkout's `.red/tmp/` because a human returns to review them; spec-driven and ad-hoc work is coordinated by redskilled and its **Workers** live in daemon-placed OS temporary storage, never in the checkout.
_Avoid_: scenario, flow, lane (a lane is a label on a Ticket, not the way work entered), manual mode (interactive is the human's own coder session, not a fallback)

**Worker**:
A disposable, project-versioned workload admitted, budgeted, observed, and eventually reaped by **redskilled**. A Worker performs bounded work in an isolated **Worktree** and carries no durable project-control authority: Workers are cattle, while their outcomes and recoverable evidence survive in the control plane and the Issue tracker.
_Avoid_: Project coordinator Worker, resident, daemon, durable Worker, pet process

**Plugin MCP**:
The one thin, stateless MCP adapter a RedSkills plugin ships (`rs_dev`, `rs_memory`, `rs_brain`), an ACP client of **redskilled** that publishes tool schemas and forwards every call; it holds no engine, store, GitHub client, or fallback, so a session or **Worker** may mount it without paying for a heavy process. The daemon carries the weight once per host; the adapter is what a host multiplies per session.
_Avoid_: castle MCP, "redskilled MCP" (as the plugin adapter's name), resident MCP, heavy MCP, per-plugin daemon

**Forge passthrough**:
The one tool `rs_github` publishes — a method, a path, a body and headers, forwarded whole to **redskilled**'s Project-bound gateway. It is cross-plugin rather than any one plugin's, because every plugin asks about the same repository through the same credential profile. An observing method joins the gateway's existing demand, so two sessions asking the same question at the same moment cost one upstream call, and the answer states how old the value it served is; a mutating one is scheduled through the durable write outbox under a key derived from the request, so the retry after a timeout re-reaches the first receipt instead of publishing twice. The MCP itself holds no credential and no cache — a per-session copy of either is the cost the **Plugin MCP** exists to remove.
_Avoid_: GitHub proxy, forge tunnel (nothing arbitrary crosses — a request that maps to no declared read or outbox write is refused by name), per-endpoint GitHub tools

**Project control state**:
The stateful per-project partition inside **redskilled** that understands the project's workflow policy, maintains queue consumption, and decides which disposable **Workers** to request. It is daemon state, not a separate project process, resident, or special Worker.
_Avoid_: Project coordinator Worker, Castle resident, Demand producer, Project listener, project daemon

**Project**:
One logical GitHub repository under **redskilled** control, canonically keyed by GitHub's stable repository identity rather than by a checkout path or mutable `owner/repo` spelling. One Project owns one queue view, GitHub cache and budget ledger, pending-write outbox, **Drain intent**, and daemon-managed **Project workspace**.
_Avoid_: checkout, Git common directory, worktree, project clone, `owner/repo` as immutable identity

**Project workspace**:
The one canonical repository workspace that **redskilled** owns and maintains for a **Project** under daemon-managed storage. It supplies the mirror, base commits, and isolated **Worktrees** in which disposable **Workers** execute. Editor checkouts and other local clones are clients that identify and control the Project; they are never execution authorities or alternate workspace pools.
_Avoid_: Primary checkout, editor checkout, registered clone, workspace pool, client-owned worktree root

**GitHub credential profile**:
A daemon-owned GitHub authentication identity and its rate-budget domain. Each **Project** binds to one named profile; **redskilled** alone resolves and uses its secret for cache refreshes and durable writes. MCPs, ACP clients, and **Workers** refer only to the Project and never forward a GitHub token per call. A host may keep several profiles for distinct organizations, installations, or access scopes without fragmenting one Project across credentials.
_Avoid_: client token, Worker credential, per-request authentication, project secret copy

**GitHub gateway**:
The sole managed path from a host's RedSkills workflows to GitHub. **redskilled** owns REST, GraphQL, and authenticated Git transport under the Project's **GitHub credential profile**: it coalesces and caches API reads, budgets and serializes API writes, refreshes the managed repository, and publishes Worker commits or branches. Workers operate only on their local **Worktree** and request refresh or publication through ACP; they never receive GitHub credentials or independently fetch, push, open PRs, or mutate Issues.
_Avoid_: Worker `gh`, delegated Git token, direct Worker push, API-only gateway, per-client GitHub access

**Client checkout**:
A human- or editor-owned clone that resolves its GitHub repository identity and connects a client surface to the corresponding **Project** in **redskilled**. Its uncommitted files, local branches, and Git common directory do not become Worker input or project-control truth; deliberate work enters through GitHub or an explicit control-plane operation.
_Avoid_: Project workspace, Worker root, execution checkout, daemon mirror

**Client authority**:
The capability scope granted to one authenticated **redskilled** connection. A project-scoped MCP or editor client may mutate only the **Project** resolved from its **Client checkout**; an explicitly administrative client may observe and operate host-wide state. Socket access alone never silently upgrades a project client into host administration.
_Avoid_: Docker-socket authority, ambient host admin, client-declared project trust, all-or-nothing local access

**Project authority split**:
The deliberate boundary between durable workflow truth and operational control truth. GitHub's **Issue tracker** owns Tickets, labels, dependencies, discussions, and human decisions; **redskilled** owns the registered drain intent, GitHub cache and cursors, pending-write outbox, local claims, Worker lifecycle, budgets, and placement. On disagreement, redskilled reconciles its operational state toward fresh GitHub truth without discarding still-pending writes or pretending stale cache is current.
_Avoid_: redskilled issue tracker, GitHub runtime state, dual workflow truth, cache as truth

**Project policy precedence**:
The three-layer resolution of a **Project**'s effective execution policy: host-owned policy sets non-negotiable permissions, budgets, and placement limits; explicit durable control intents choose behaviour within those limits; tracked `.red/config.yaml` from the **Project workspace**'s refreshed Trunk supplies versioned defaults and requirements. **Client checkout** state never participates. Same-major compatible changes reconcile live; a cross-major change requires a **Major handover**.
_Avoid_: client config upload, dirty-checkout policy, daemon-only project config, project override of host limits

**Drain intent**:
The durable instruction in a **Project control state** that eligible Issues should continue being consumed until an explicit stop changes that desired state. It outlives the MCP, CLI, editor, or ACP session that created it; client presence may tune observation cadence but never silently cancels the drain.
_Avoid_: client lease, session drain, connected-mode execution, idle cancellation

**Attempt / Attempt record — EXTINCT (ADR 0130)**:
The retired name for one **Worker** × one **Ticket** × one try, and for the durable per-try record that carried its narrative on `.red/state/castle/attempts.toonl`. Neither named a fact the **Worker** did not already carry: ADR 0103 had made a retry a fresh Worker, so a Worker *is* that unit, and the record was a third copy of pointers the **Issue tracker** and git already own. ADR 0130 removed the noun, the lane, the `red.castle.attempt.v1` contract and the retention rule together; what the record got right moved rather than died — process liveness re-anchored onto the **Liveness anchor**'s daemon read, and reclaim onto the **Worker reclaim rule**. The **redskilled** host event lane keeps the one fact no other authority holds, Worker-to-process: birth, death, and a budget-driven kill. The term survives only for reading the archived ADR 0128, ADR 0129, and historical **Envelopes**; never describe live execution with it.
_Avoid_: attempt, attempt record, attempt id, attempt ordinal, attempt lane, attempt state, per-attempt budget, attempt accounting, attempt usage (the supervisor's accounting and its budget vocabulary are keyed to the **Worker** — `worker-accounting.ts`, `worker-budget.ts`, `WorkerUsage`, `WorkerBudgets`; issue #2850), attempt worktree, `attempts.toonl` (every one is extinct — say **Worker**, and the **Worker outcome** for how its run ended); try, run, execution (these name a phase of a Worker's run, never a unit of its own); worker log (the `worker.log.toonl` **Tmp tier** lane is disposable and worker-written, and was never this record)

**Worker reclaim rule**:
When the janitor may reclaim what a **Worker** left behind, stated once: an artifact is reclaimable only when the daemon says the Worker that owns it is gone. The **redskilled** daemon owns birth and death by construction, so it cannot be out of date about a process it holds — a stronger authority than the extinct **Attempt record**, which could only repeat what it had last been told, and never a pid file, whose absence is what deleted the live lane while the dead ones survived (#2679). Three verdicts, and the third is load-bearing: `alive` (the daemon names the Worker — nothing it owns may go), `unknown` (the daemon did not answer, its answer is stale, or something else still sees the Worker — retained, because failing to reach the authority is not evidence of death), and `dead` (the daemon answered currently and does not name it — only here may bytes go). What a dead Worker leaves splits by *cost*: `workspace` is expensive and regenerable and goes, `evidence` is cheap and irreplaceable and stays (it is what a human reads to rescue orphaned work, #2701), `pointer` names a branch/PR/commit and holds no bytes, and an unrecognised `unknown` kind is retained and reported rather than guessed at. Two artifact-level overrides beat a dead Worker's release — `reclaimable: false` pins one, `reclaim_after` holds one until that instant. The planner is total: every artifact lands in exactly one of reclaim, retain, or dropped, so a cap or an unaccounted path is reported and never silently truncated.
_Avoid_: retention tier, attempt record retention (both extinct with the **Attempt** — the daemon's verdict and the artifact's cost class replace them); pid liveness, `worker.pid` check, mtime age (each is the anchor inversion this rule exists to forbid); TTL, grace period (inputs to `reclaim_after`, not the rule)

**Session evidence**:
The runner's own session artifact (the inner agent's persisted transcript) retained under the **Worker reclaim rule** as `evidence` — cheap, irreplaceable, and what makes orphaned work rescuable with warm context instead of a cold `prev-failure-reason` line. Retention only: resuming a dead Worker's session in a fresh one is a separate, unproven capability and no rule may assume it.
_Avoid_: worker log (the disposable `worker.log.toonl` narrative lane is not this), trajectory, session resume (a future capability, not this artifact)

**Re-seed**:
Re-instructing the implementer **in place** — same **Worker**, same **Worktree**, same branch — after a **Gate stage order** stage blocked the work, so the committed branch is carried forward instead of rebuilt. It is the deliberate opposite of the ADR 0103 re-queue (fresh Worker, clean worktree from **Trunk**, `prev-failure-reason` in the prompt), and the contrast is the term's whole job: a re-queue discards, a Re-seed resumes. A Re-seed never mints a new **Worker**; the rounds are events inside the running one.
_Avoid_: attempt, new attempt (extinct — the **Worker** is the unit, and a Re-seed happens inside one running Worker), retry, attempt ordinal (retired by ADR 0103), correction retry

**Re-seed budget**:
The bound on how many **Re-seed** rounds one **Worker** may spend. A single ceiling per lane holds sub-caps per cause — a failing gate stage, a repeated failure signature escalating the tier, a blocking review finding — and the review's round is a **reservation**, not a quota, so gate churn cannot consume it. Exhaustion with anything still outstanding parks `ready-for-human` + `blocked:validation`, uniformly and regardless of cause; landing with a known blocking finding is not reachable by config value. An operator tunes only the gate's share (`dev.reseed.afk.gate_budget`); the ceiling and the reservation belong to the lane, so a raised setting can neither buy an unbounded run nor starve the review's round.
_Avoid_: correction budget, convergence budget, stall convergence budget (the `afk.stallConvergenceBudget` key names the retired shape), heal ledger (that is the per-Ticket repair history, a different object), attempt ledger, per-attempt budget (the rounds are events inside one running **Worker**, never a new unit of work)

**Worker kind**:
The provenance stamp that distinguishes why a **Worker** exists while all Workers share one daemon-placed workspace root (ADR 0149): `current.kind=afk` for the **Demand producer**'s queue-draining work, `current.kind=go` for approved one-off `/go` dispatch, `current.kind=scout` for read-only `/go --scout` investigations, and `current.kind=repair` for the mechanical merge-queue lane that merges the fresh base, regenerates declared mirrors, publishes, and re-queues without waking the owning Worker. The legacy `.red/tmp/go-workers/` and `.red/tmp/scout-workers/` roots are read only as transitional observability inputs until they age out; they are not the live isolation contract.
_Avoid_: worker namespace, go-workers root, scout-workers root

**Worker state reader**:
The single owner of "read a **Worker**'s `afk.state.json`" — `readWorkerState(path)` wraps `parseState` (with the legacy shim), liveness (`isStateActive`), and stage extraction for one file, and `readWorkerStates(root)` globs every worker and maps to normalized, liveness-tagged records. The monitor, statusline, dashboard, **Task mirror**, boot facts, and the **Demand producer**'s stall-reaper all read through it instead of each re-globbing, re-parsing, and re-deriving liveness — closing the divergent hand-rolled parse path that skipped the schema/shim.
_Avoid_: state glob, status reader (these are the per-consumer loops the Worker state reader replaces)

**OpenCode auth env precedence**:
The order in which AFK selects an API key for the OpenCode runner when multiple are set in the worker process: `OPENAI_API_KEY` > `MINIMAX_API_KEY` > `OPENROUTER_API_KEY`. The first set entry wins and the auth key rides in `OpenCodeOptions.env`; OpenCode itself dispatches on the leading segment of the model slug (`openai/...`, `minimax/...`, `openrouter/<vendor>/...`). A user with no key set is fail-closed — the agent spawns without an auth `env` block, OpenCode surfaces its own auth error, the run routes through the normal failure path.
_Avoid_: hardcoded OpenRouter, base-url map, endpoint-specific code

**Endpoint-agnostic provider**:
The design property that the OpenCode runner does not know or care which OpenAI-compatible endpoint it ultimately talks to. AFK propagates only the auth key (per *OpenCode auth env precedence*); OpenCode owns endpoint resolution from the `<provider>/<model>` slug. Adding a new endpoint never requires changes to AFK code — the operator sets the corresponding env-var and a matching slug.
_Avoid_: provider-specific config block, base-url per runner, multi-endpoint fan-out

**OpenCode host**:
The developer-facing OpenCode-compatible TUI surface that runs interactively (`opencode .` or `redcode .`) on the same repo where AFK's inner-agent OpenCode runner executes headless. Treated as a **third host** alongside Claude Code and Codex (ADR 0075), with `plugins/<name>/` definitions shared across all three — the `apps/host-opencode/` adapter emits opencode-native config (`opencode.json` `provider>` + `mcp:` from Slice 3, `.opencode/skills/<name>/SKILL.md` via flat symlink from `plugins/<name>/skills/<bucket>/<name>/SKILL.md`, `.opencode/plugin/<event>.ts` from `plugins/<name>/hooks/<host>.hooks.json` and a per-plugin `session-status.ts` for the AFK statusline + toasts from Slice 4) from the same `.red/config.yaml` AFK already reads. The installer targets `~/.config/opencode/` and `~/.config/redcode/` independently, so both CLIs can coexist. Reuses the ADR 0059 env-precedence and `<provider>/<model>` slug verbatim (Amendment 3 of 0059). Slice 1 = provider block (ADR 0075); Slice 2 = skills (ADR 0076) + hooks (ADR 0077); Slice 3 = MCP passthrough (ADR 0079); Slice 4 = statusline + toasts (ADR 0080); Slice 5 = remote install.
_Avoid_: hand-authored `opencode.json` per project, second source of truth for the same model/auth config, duplicating `SKILL.md` into opencode-native skills, regenerating hook JSON into TS by hand (use the adapter)

**Agent runner / Runner spec**:
The provider-facing runner set (`AgentRunner` = claude | codex | opencode | claude-minimax) and the single descriptor table that owns each runner's provider policy — its accepted efforts, whether effort rides the numeric `effort` knob or OpenCode's free-form `variant` channel, any forced model (claude-minimax → MiniMax-M3), and its auth-env resolver. `toAgentRunner` projects the broader orchestrator **Runner** (which also includes the runner-neutral `hermes`) onto this set, collapsing any provider-less runner to `claude`. Adding a provider becomes one table row instead of parallel edits across `buildAgent`, `effortForProvider`, and the tier-table coercion.
_Avoid_: runner detection (that resolves *which* Runner to use; a Runner spec defines *what each provider runner accepts*)

**Agent transport**:
The communication mode by which an **Agent runner** exchanges prompts, session state, control requests, and events with its underlying coding agent, independently of the runner's identity and policy.
_Avoid_: ACP runner, transport runner, agent provider

**RedSkills identity**:
The public product identity presented by agent-facing surfaces, independent of the underlying **Agent runner**, **Agent transport**, Castle resident, MCP, or **redskilled** daemon.
_Avoid_: Codex identity, runner identity, Castle identity, redskilled identity

**ACP conformance**:
The product property that the **RedSkills identity** satisfies both ACP agent and ACP client contracts through separate surfaces with independently verified protocol behaviour.
_Avoid_: ACP opt-in, ACP runner, ACP-compatible mode

**ACP draft revision**:
The RedSkills-namespaced wire identifier that distinguishes incompatible ACP v2 drafts which share the same `protocolVersion: 2` major.
_Avoid_: ACP protocol version, SDK version, artifact version

**RedSkills wire major**:
The product-contract major exchanged independently of the ACP protocol version. A **redskilled** daemon, its MCP adapters, and its **Workers** interoperate whenever this RedSkills major matches; minor and patch differences are compatible by contract and never form a routing or admission boundary. A cross-major peer is refused before work or session state can cross the wire. Supporting ACP v1 and ACP v2 does not imply supporting two RedSkills wire majors.
_Avoid_: ACP major, exact package version handshake, minor-version routing, bundle equality

**Major handover**:
The quiescent, single-authority cutover between two **RedSkills wire majors**. The old **redskilled** major stops new Worker admissions, drains or terminally accounts for its live Workers, flushes pending GitHub writes, persists a migration checkpoint, and exits before the new major migrates state and assumes the one host endpoint. Workflow traffic never crosses majors and two majors never concurrently own project state, Workers, or the GitHub budget.
_Avoid_: rolling mixed-major operation, parallel major daemons, cross-major Worker compatibility, kill-and-replace upgrade

**ACP workflow session**:
An ACP agent session through which a client directs and observes **redskilled** workflows while every concrete change remains isolated in a **Worker**'s **Worktree**.
_Avoid_: editor workspace session, direct coding session, ACP Worktree

**RedSkills ACP extension**:
The capability-advertised family of typed ACP extension methods under the `_redskills/*` namespace for deterministic control-plane operations such as Project drain, stop, status, Worker control, and governed GitHub access. Methods use ACP's standard JSON-RPC extension mechanism and advertise their schemas or capability versions in `_meta.redskills`; MCP and CLI adapters translate to them rather than opening a private daemon wire.
_Avoid_: private RPC, Castle wire, ACP-like protocol, prompt-encoded control API, unnamespaced custom method

**ACP core parity**:
The guarantee that a generic ACP client can reach the complete RedSkills workflow through standard sessions, prompts, slash commands, plans, tool-call updates, cancellation, and permissions without understanding the **RedSkills ACP extension**. `_redskills/*` provides deterministic typed access to the same governed capabilities; it never unlocks a workflow that is impossible through ACP core or creates a second implementation.
_Avoid_: extension-required mode, read-only generic client, MCP-only capability, prompt-only duplicate implementation

**Worker-backed Agent**:
The split behind the public RedSkills ACP Agent: **redskilled** owns sessions, deterministic operations, permissions, routing, and durable control state, while every generative turn runs in an admitted, budgeted, replaceable **Worker**. A Worker may act as an ACP Client of child agents; “Manager” names at most a temporary Worker role and never a third architectural player or model runtime embedded in the daemon.
_Avoid_: daemon model, redskilled runner, Manager service, resident agent, unadmitted generation

**Workflow Worker**:
A **Worker** whose lifetime is bounded by one active workflow rather than by an ACP connection or one prompt turn. It may serve several related turns while retaining one Ticket and isolated **Worktree**, then ends on workflow completion, idle policy, budget verdict, or replacement. An **ACP workflow session** may route and observe several Workflow Workers over time; its **ACP session journal** preserves continuity above them.
_Avoid_: session Worker, turn Worker, project Worker, persistent manager, one Worker per editor

**ACP session journal**:
The daemon-owned durable record of one ACP session's observable prompts, relevant updates, plans, permission decisions, workflow pointers, and replacement checkpoints. **redskilled** uses it to reconstruct a **Worker-backed Agent** after Worker death without making a runner-native resume feature authoritative. Provider-native transcripts remain **Session evidence** and may optimize a warm resume, but their absence never erases the public session identity or governed workflow state.
_Avoid_: runner session as truth, Worker-owned transcript, chain-of-thought store, disposable ACP session

**Detached permission rule**:
How **redskilled** resolves an ACP permission request when no authorized interactive client can answer. Project and host policy may pre-authorize the action; anything outside that policy terminates or checkpoints the Worker and records the pending decision through the ordinary **HITL resolution** path. A Worker never holds admission indefinitely awaiting reconnection, and absence of a client is never implicit approval. When an authorized client is attached, redskilled may project the same request upstream without bypassing its **Client authority**.
_Avoid_: permission zombie, auto-approve-on-disconnect, client-presence requirement, private Worker prompt

**Linux ACP rendezvous**:
The local transport layout in which clients reach the one **redskilled** authority through its known Unix socket and redskilled reaches each independently managed **Worker** through a daemon-assigned per-Worker Unix socket. Editor-facing adapters may accept ACP over stdio, and a Worker may launch a direct child agent over ACP stdio, but both are transport projections of the same protocol and own no state or workflow logic.
_Avoid_: Castle socket, private daemon RPC, shared Worker bus, stdio-owned lifecycle, adapter service

**Local ACP endpoint**:
The platform abstraction for reconnectable host-local ACP: a Unix socket on Linux and a Windows Named Pipe on Windows. **redskilled** owns one known endpoint and assigns one endpoint to each independently managed **Worker**; endpoint permissions enforce the first local boundary before ACP authentication and **Client authority** narrow the connection further. Loopback TCP is not the default local control plane.
_Avoid_: cross-platform TCP port, socket-only contract, Windows stdio fallback, transport-specific workflow API

**Worker placement driver**:
The host implementation that materializes an admitted **Worker** as a native process or through Docker or Podman while preserving the same lifecycle, budget, workspace, and ACP contracts. A Project may declare execution requirements or preferences; **redskilled** chooses a compatible driver under host policy and refuses admission when none qualifies. A placement driver is an internal mechanism, never a Worker kind or public architectural player.
_Avoid_: container Worker, Docker agent, native Worker identity, sandbox as protocol, project-selected host authority

**Worker ACP chain**:
The recursive interaction model in which **redskilled** acts as an ACP Client of each **Worker**, each Worker is an ACP Agent to its parent, and a Worker may itself act as an ACP Client of child agents. Protocol interaction is ACP throughout; Worker admission, placement, budgets, project state, and reaping remain control-plane responsibilities of redskilled.
_Avoid_: Castle wire, internal MCP chain, Project coordinator Worker

**Implementer environment**:
The loaded surface (plugins, MCP servers, hooks, rsp) an inner agent receives when a **Worker** spawns it. Derived strictly from the repo's `.red/config.yaml` activation gates — a plugin or rsp rides along only when its existing `enabled: true` key says so (ADR 0067 strict opt-in is the payload declaration); everything else stays out of the spawn. Minimal by construction, never by a separate list.
_Avoid_: implementer payload list, full-environment inheritance

**Worker outcome**:
How a **Worker**'s execution of an **Issue** ended, and what that ending *means* for the **Issue**: the single concept that maps a terminal result to its `blocked:<reason>` label, its envelope status, and its bounded-recovery policy key. The historical three-enum smear (`ProcessOutcome` / `BlockedReason` / `RecoveryReason`) is resolved — adding an outcome now touches one set of exhaustive switches.
_Avoid_: attempt outcome (extinct with the **Attempt** — a **Worker**'s run ends in a Worker outcome), process outcome, blocked reason, recovery reason (these were the three views now unified, not separate concepts)

**Worker disposition**:
What AFK *does* about a **Worker outcome** — the single owner that composes the outcome's recovery decision (retry vs escalate, from the cap policy), its typed `blocked:*` label, its envelope status, and the standard escalation announcement into one pure descriptor. The worker per-issue path, the no-agent **reconcile** path, and the **Demand producer**'s stall-reaper all consume the same disposition instead of each re-deriving labels, statuses, and comments.
_Avoid_: attempt disposition (not a term, and the **Attempt** is extinct — a **Worker** carries an outcome, and disposition is what AFK does about it), recovery routing, park logic (per-site applications of one disposition)

**Worktree**:
An isolated `git worktree` created by AFK per **Worker** execution, inside the worker's workspace under `.red/tmp/workers/{wid}/{issue}/`. One worker = one issue execution = one worktree; a retry is a fresh worker, not a numbered sub-directory (ADR 0103).
_Avoid_: afk clone, sandbox checkout, attempt worktree

**Red lifecycle tier**:
One of the canonical `.red/` lifecycles from ADR 0098: tracked knowledge/config, plugin stores, durable machine state under `.red/state/`, or disposable scratch under `.red/tmp/`. The lifecycle decides whether a path is versioned, plugin-owned, durable-local, or safely deletable.
_Avoid_: tmp as a catch-all, state mixed with scratch

**Contracts home**:
The tracked knowledge/config directory at `.red/contracts/`, versioned in the repo and owned by the **dev** plugin. It holds test and validation fixtures (such as `.red/contracts/fixtures/quality-gate/`), contract assertions, and reference data that document interface boundaries and acceptance criteria. Content here is not disposable and must be backed by an Issue/Spec/ADR that states why the fixtures exist.
_Avoid_: test data (use with care; contracts are *vetted* boundaries, not ad-hoc test input), fixtures root (this is the contracts home, not a general-purpose fixtures directory)

**Config tombstone**:
An entry in `DELETED_CONFIG_KEYS` naming a config key that USED to mean something (ADR 0117). The loader drops a tombstoned key and warns `RETIRED`; an unknown key stays silent for forward compatibility. Silence means "not yet", a warning means "not any more".
_Avoid_: deprecated key (a tombstoned key does not still work), unknown key

**Gate stage order**:
The gate's stages in cheap → expensive order — feedback, backpressure, review (ADR 0119; the `trust` stage went with the sensitive-path removal in #2417). `gateVerdict` folds stage outcomes into one `ok` naming the earliest blocker, so a later stage never runs once an earlier one blocked, and a stage with nothing to run is skipped rather than failed.
_Avoid_: validation order (the gate stages are not the suite's internal order), pipeline stage

**Appraisal**:
The holistic quality score the gate's review stage attaches to a finished branch: one 0–1 answer to "beyond discrete findings, is this good enough to land," produced in the same reviewer pass that already judges correctness and acceptance-criteria conformance — never a second judge over the same diff. Advisory at birth: the score lands in the Envelope for measurement, and only a deliberate operator flip makes a low score consume a reserved **Re-seed** round the way a blocking review finding does.
_Avoid_: critic, quality gate (the gate is the whole pipeline; the Appraisal is one field of one stage), second review stage (the score rides the existing pass)

**Preflight**:
The gate's cheap feedback commands surfaced inside the runner session before the Worker may declare DONE, so a would-be **Re-seed** round becomes a same-session fix. Strictly the same command set the feedback stage runs — never a stricter self-imposed suite (ADR 0106) — and adopted only behind measurement: it stays experimental until observed Re-seed savings justify keeping it.
_Avoid_: pre-commit hook (host-side git machinery; Preflight is runner-session surfacing of gate commands), stricter local checks, early gate (the gate still runs; Preflight previews one stage of it)

**State tier**:
The gitignored durable machine-state tier at `.red/state/`. Named lanes include `afk/`, `rsp/`, `statusline/`, `branch-lock.yaml`, and `red-skills.rdb`. It is never mass-deletable and must survive `rm -rf .red/tmp`.
_Avoid_: cache, tmp state

**Tmp tier**:
The gitignored disposable scratch tier at `.red/tmp/`. It is safe to remove by contract; no durable state may live there, and every writer must use a named lane.
_Avoid_: durable tmp, loose tmp-root files

**Lane registry**:
The ADR 0098 registry of named writer-owned paths under `.red/state/`, `.red/tmp/`, and `.red/researches/`. A new writer must use a registered lane or extend the registry before writing.
_Avoid_: ad-hoc path convention, loose file namespace

**Researches home**:
The gitignored durable generated-knowledge home at `.red/researches/`, used for date-disambiguated `/research` reports until they are curated into tracked docs or the wiki.
_Avoid_: tmp research reports

**redskilled**:
The host-scoped, stateful RedSkills control-plane daemon. Exactly one instance per machine owns disposable **Worker** admission, birth, death, limits, placement, observation, and reaping across projects; holds one **Project control state** per registered project on that host; and guarantees that eligible Issues continue to be consumed. MCP servers, CLIs, editors, and other surfaces are clients rather than alternate owners. It is also the sole GitHub gateway for managed workflows on the host: requests are coalesced and budgeted centrally, reads are served from an age-stamped cache, writes are serialized or durably scheduled, and no local client or Worker independently spends the shared API rate limit. Another host may manage the same GitHub repository through its own daemon; the daemons do not form a cluster, and GitHub claims plus durable workflow state remain their coordination boundary. Workers run as transient init-system units rather than as daemon children, so redskilled can restart and re-attach without taking their work with it; when redskilled is unreachable no Worker is born.
_Avoid_: thin supervisor, fleet supervisor, Castle resident, Demand producer, alternate GitHub client, fleet (extinct — ADR 0130)

**Budget grace**:
The bounded checkpoint window between the **redskilled** daemon's budget verdict and the kill: the daemon signals, the Worker gets a fixed deadline to commit, push, and write its Envelope, and then dies regardless. Never a live pause — a Worker holding a slot and a claim while awaiting a human decision is the zombie the daemon exists to prevent. "Extend the budget?" is an extractable HITL decision on the parked Ticket, answered through the ordinary requeue door, never by resuscitating the process.
_Avoid_: budget pause, throttling (a live held state; the grace ends in death by construction), kill delay (the point is the checkpoint, not the delay)

**Host-scoped daemon home**:
`~/.red/redskilled/` — where the **redskilled** daemon keeps what belongs to the operator rather than to a checkout, including the durable event lane, the registration-intent snapshot, and the `host` **Worker workspace** preset. **It has exactly one owner**: `provisionRedskilledHome` in `apps/redskilled/src/provision.ts` creates it and nothing else may (ADR 0130 Amendment 2). The daemon owns it rather than **red-setup** because start is auto-spawn — a home only an interactive installer could create would leave a fresh machine failing closed forever, with the daemon depending on the tool that depends on the daemon. ADR 0067's sole-creator authority is therefore repository-scoped: it governs a checkout's `.red/`, never the operator's `~/.red/`. **Provisioning is idempotent**: the home is created owner-only (`0700`), an existing one keeps everything in it, and a second run can only narrow a permission bit that drifted wider — a repair, not a rewrite. `/red-setup` provisions by *calling* the owner (`redskilled provision`), and `/red-doctor` reports the four checks (`home`, `daemon-entry`, `reach`, `supervisor-unit`) read-only, probing the socket without ever spawning the daemon it reports on.
_Avoid_: the repo's `.red/` (a different directory under a different authority), setup-owned home, daemon state dir (the session's runtime dir under `XDG_RUNTIME_DIR` holds only socket-local coordination: socket, spawn lock and lease — that is not this)

**Host hook**:
How a program **outside** RedSkills learns that the **redskilled** daemon's state changed, without polling for it (#3503). Two consumers share the public `worker-birth` / `worker-death` / `worker-budget-kill` vocabulary. An unregistered consumer watches the rotating host event lane and re-baselines through `host-state` when its generation is stale. An operator may instead declare an event-keyed argv under `plugins.dev.redskilled.hooks` in `~/.red/config.yaml`; the daemon births it asynchronously as an admitted, budgeted `redskilled/host-events` **Worker** and writes the complete versioned `host-state` JSON document to its stdin. The snapshot is taken before the sink Worker is counted. `notifications` is the parallel native desktop sink for the same declared kinds. These declarations survive restart because machine policy is operator-owned and re-read at daemon start, never copied into the daemon-written registration snapshot. A registered project may also declare its own callback under Amendment 1 of ADR 0140, charged to that project. **A Host hook is a notification, never a veto**: failure or refusal changes nothing about the triggering Worker, and sink Worker events do not recurse. The lane remains the zero-registration extension point and all non-public event kinds remain internal. First consumer: **Redwall** (`red-dev#52`), the wallpaper that draws the live **Worker** count.
_Avoid_: **Webhook** (that is the opposite direction — see below), subscriber, daemon push, socket subscription (the protocol is request/response and stays that way), agent hook (that names the Claude/Codex/opencode lifecycle hooks a plugin installs), lifecycle hook (that names the **Demand producer**'s in-process `onLifecycle` seam), unadmitted callback process

**Castle resident — RETIRED**:
The discarded per-project process boundary from ADR 0143. Its useful responsibilities — workflow truth, project registration, GitHub adapters, and background belts — belong to **redskilled**'s **Project control state**, without a second resident process or control wire. ADR 0143 requires supersession before implementation follows this glossary decision.
_Avoid_: reviving a project resident, Project coordinator Worker, project daemon

**Webhook**:
How the **redskilled** daemon learns that something changed at GitHub, **inbound**, so its queue polling can stop asking on a timer (#3387, #2425/#2365). The opposite direction from a **Host hook**, which is why the two keep separate names: one is the world telling this machine, the other is this machine telling its own desktop. Transport, credential scope and the fallback ladder back to polling are still open under the Wayfinder map (#3381).
_Avoid_: **Host hook**, hook unqualified (the bare word has meant both directions and that is the collision these two entries exist to end)

**Demand producer — RETIRED**:
The discarded standalone owner of per-project queue demand. Queue sampling, selector policy, claims, elastic target resolution, and continued consumption now belong to the project's **Project control state** inside **redskilled**, beside the daemon's admission authority. There is no producer process or second control loop to rendezvous with.
_Avoid_: producer process, Project coordinator Worker, fleet supervisor, project resident

**Launch template**:
What a project states its NEXT **Worker** should be started with — an argv and an env, both opaque to the **redskilled** daemon (ADR 0130 Amendment 5). It exists because a Worker's runner, model tier, effort and slot-scoped env are decided *per birth* while a registration carries *one* launch, and one frozen argv cannot express a decision made per Worker. **It is restated, never frozen**: a tick that swapped the runner sends the new pair on the renewal its session already sends, so a swap costs no new op, no round trip, and no window where the host holds no record of a project that is still draining. Facts the project cannot know in advance — the Worker's id, its slot, its workspace, its log path — are stated as `{{worker_id}}`-style placeholders and substituted by the daemon at birth, which is the whole of what the daemon contributes: it reads no word, refuses an unknown placeholder rather than starting a Worker with it, and still does not know what a runner is. Model and effort stay *out* of the launch on purpose — they resolve per tier, per run, inside the Worker, from the project's own config.
_Avoid_: spawn spec (that names the whole **Worker** launch the daemon builds from this), profile (that named the extinct Fleet's resource unit), argv alone (the env is half of it), macro/template language (four host facts substituted textually, never a language the daemon evaluates)

**Work selector**:
Which slice of the backlog a producer is allowed to drain — `{spec, lane, label, issues, tags, user}`, every present facet narrowing the pool, an empty selector meaning the whole backlog. It is **work policy, not a resource unit**, which is why it outlived the named fleet that used to own it (ADR 0130): the registry that stored `name -> profile` is gone, and the selector is handed to `project_start` and matched against candidates in the drain.
_Avoid_: fleet selector (the noun it hung off is extinct), filter (that names the `--spec`/`--issues` argv forms this generalises), territory (that names the `tag:`/`user` facets alone)

**Liveness anchor**:
The single resolution every management surface asks "is this **Worker** there, and how current is what I am reading?" — a Worker's process liveness resolves through the **redskilled** daemon, which owns birth and death, and a **Demand producer**'s through its own identity read (ADR 0128 §5, which survived its record's archiving into ADR 0130). One call answers both questions, from one read, so a payload cannot carry `alive: false` beside a fresh heartbeat — the contradiction behind #2698 and #2679. Two rules make it hold: an unattributable heartbeat is **orphaned** and therefore stale at any age, and the verdict travels *inside* the payload so a consumer renders staleness rather than re-deriving it. `project_status`, `project_stop`, `monitor`, `worker_vitals` and the statusline are migrated consumers; a migrated reader that reintroduces a private source fails the ratchet test.
_Avoid_: pid file, heartbeat snapshot, `state.toon` (each is an *anchor of the same identity*, never a source a reader picks between); attempt record, attempt liveness (extinct — the anchor a Worker's process verdict came from is the daemon, ADR 0130); liveness probe (the raw pid check the anchor uses)

**Spin**:
A live **Worker** whose inner agent is emitting but not advancing: the same action meeting the same observation again and again, an action met by a streak of errors, a monologue with no observations between messages, an alternating ping-pong of two action-observation pairs, or context-window thrash. Spin is invisible to liveness by construction — heartbeats stay healthy and every stall surface reads `live=true` — so it is detected engine-side by deterministic pattern evaluation over the runner stream, never by an LLM pass. The response enters the existing ladder: one steer naming the detected pattern where the runner has a steering channel, a **Re-seed** carrying the pattern when the steer does not take, then the normal escalation. A round lost to Spin reaches the **Verdict** as a `spin:<pattern>` fault rather than a generic exhaustion.
_Avoid_: stall (liveness vocabulary — a stalled Worker goes quiet, a spinning one emits futilely), stuck (ambiguous between the two), infinite loop (an engine wait concern, governed by declared waits)

**AFK polling cadence rule**:
The prompt-cache-aware rule for recurring AFK lane cadences: default recurring polls should be cache-warm at 270 seconds or less, or intentionally amortized at 20 minutes or more. Do not add defaults in the dead zone around 300 seconds. The current recurring-cadence inventory is: **Demand producer** health tick `RED_AFK_POLL_S` 15s before/after; event-driven supervisor fallback `RED_AFK_WAKE_FALLBACK_S` 60s before/after; worker proof-of-life heartbeat `RED_AFK_HEARTBEAT_S` 60s before/after; periodic dependency Unblock Sweep `RED_AFK_UNBLOCK_SWEEP_INTERVAL_S` 60s before/after; **redskilled** registration sustain/recovery belt 60s after; adaptive queue discovery at no more than 100s after; statusline local git facts under their own micro-TTL ~5s after (the statusline/monitor `gh` count cache and its `RED_AFK_STATUSLINE_CACHE_TTL_S` knob are gone with ADR 0141 decision 2 — the remote counters ride the **redskilled** poll); stale-claim refresh `RED_AFK_CLAIM_REFRESH_S` 300s before, 270s after. The registration belt is deliberately independent from queue discovery: the former owns lease liveness while the latter supplies bounded-fresh work evidence, and neither cadence may silently lengthen the other. Supervisor watchdog values such as `RED_AFK_SUPERVISOR_STALE_S` and `RED_AFK_SUPERVISOR_RESTART_WINDOW_S` are recovery windows rather than polling cadences; keep them above their safety thresholds instead of treating them as recurring polls.
_Avoid_: 300s default poll, prompt-cache dead-zone cadence

**Auto-monitor loop**:
An optional session-level observability loop that periodically renders AFK monitor state.
_Avoid_: demand producer, fleet supervisor (extinct, ADR 0130), worker scheduler

**Codex monitor agent**:
A Codex TUI sub-agent used only as a read-only AFK state presentation surface.
_Avoid_: AFK worker, supervisor

**Execution environment**:
A non-interactive runtime that drives `/afk --issues N --runner opencode --once` for one issue per invocation. The two target surfaces are the GitHub Actions lane (the published `reusable-afk-attempt.yml` reusable workflow in `reddb-io/red-skills`) and the k8s lane (a container image + `Job` manifest the team runs on a self-hosted cluster). Both share the same runtime contract — one issue, one PR, no **Demand producer** — and differ only in trigger and secret-injection surface. Issue [#631](https://github.com/reddb-io/red-skills/issues/631) (ADR 0059) tracks the k8s piece; the GHA piece lands in this slice.
_Avoid_: GHA-only, k8s-only, CI lane, production lane

**Actions lane**:
The GitHub Actions surface of the **Execution environment** — the published `reusable-afk-attempt.yml` reusable workflow in `reddb-io/red-skills/.github/workflows/`. The file exposes **three triggers in one**: `workflow_call` (caller invokes directly), `workflow_dispatch` (manual from the Actions UI), and `issues: types: [labeled]` (auto-fires when the `ready-for-agent` label is applied; the `if:` filter restricts to exactly that label). The trust gate is rigorous by default (author + label-applier must be in the caller-supplied allowlist). Per invocation: one Worker, one issue, one PR, no admin-merge.
_Avoid_: GHA, reusable workflow (when referring to the lane), CI job

 slot

**Skill**:
An agent-loadable behavior package rooted at a `SKILL.md` plus optional support files.
_Avoid_: command, plugin

**Path brief**:
A skill-carried brief injected into a Worker's session the first time its inner agent touches a file matching the skill's declared `paths:` globs — knowledge delivered at the moment of relevance, the layer between "always loaded" and "ratchet fails after the mistake." The `paths:` frontmatter field on SKILL.md is the one source; repo-wide invariants get extracted into small guard-brief skills so CLAUDE.md points instead of repeating, and existing skills may declare `paths:` where they already own the surface.
_Avoid_: path trigger (mechanism name; the concept is the brief delivered), auto-loaded skill (always-on is exactly what this is not), context stuffing

**Manager**:
The single operator-facing `dev` **Skill** that acts as liaison over RedSkills' existing execution and control surfaces: it routes work through the appropriate workflow, supervises the resulting **Workers**, escalates only genuine operator decisions, and reports outcomes without replacing the underlying workers, queues, or landing contracts. The operator explicitly starts or resumes it; once activated, it remains the liaison for the session until the managed effort completes or the operator ends management. Its local **Manager portfolio** is authoritative for portfolio membership, unmaterialised intent, and coordination across repositories; each published artifact remains authoritative for its own work state, decisions, and delivery evidence.
_Avoid_: FirstMate (the external reference), second **Demand producer**, parallel orchestrator

**Manager runtime**:
The deterministic support surface behind the **Manager** Skill for portfolio records, effort leases, checkpoints, Manager-map publication and reconciliation, event consumption, and Manager-brief rendering. It enables a functional end-to-end liaison but never claims work, runs agents, validates changes, or lands delivery in place of the existing owner workflows.
_Avoid_: SKILL.md-only implementation, execution engine, worker scheduler

**Manager host parity**:
The first-slice contract that Claude Code, Codex, and OpenCode expose the same **Manager** Skill and deterministic runtime behavior. A host uses its event adapter when it supports meaningful wakes and otherwise reconciles on `resume` and `status`; event capability may change responsiveness but never portfolio correctness.
_Avoid_: Codex-only Manager, host-specific semantics, wake required for correctness

**Manager acceptance journey**:
The first-slice dogfood that proves RedSkills-native FirstMate equivalence: one intent spans two repositories, materialises their **Manager maps**, routes through existing owner workflows, pauses and resumes after restart, exports and imports a checkpoint, crosses HITL or failure, reconciles delivery, and reaches **Manager effort completion** without lost or duplicated work. Contract and integration tests plus Claude Code, Codex, and OpenCode parity smokes bind the journey.
_Avoid_: feature-count parity, SKILL.md review only, store unit tests only

**Manager portfolio**:
The durable authority in one operator-and-host-scoped local store independent of any repository, covering the set of efforts managed by the **Manager**, intent that has not yet become a published artifact, and coordination relationships spanning **Issue trackers**. It binds an effort's repository-owned **Manager maps** into one cross-repository whole, but never overrides the work state, decisions, or delivery evidence owned by those maps and their child artifacts.
_Avoid_: repository-scoped portfolio, federated portfolio stores, global task database, issue mirror, replacement tracker

**Manager portfolio record**:
The minimal structured state retained for one managed effort: stable identity and destination, lifecycle state, repository and **Manager map** references, cross-repository coordination relationships, summaries of unmaterialised intent, reconciliation cursors, and checkpoint metadata. Credentials, raw conversations, source code, diffs, worker logs, and execution evidence never belong in the record; published artifacts retain their own detail.
_Avoid_: transcript archive, source snapshot, execution log, freeform document store

**Manager effort boundary**:
The membership rule for a managed effort: new intent joins an active effort only when it shares that effort's destination and acceptance boundary. Intent with a different destination becomes a separate effort; ambiguity is an HITL decision rather than silent scope expansion.
_Avoid_: session equals effort, similarity-only grouping, implicit scope growth

**Manager effort ID**:
The opaque immutable identifier generated locally for one managed effort, distinct from its mutable human name. Every repository-owned **Manager map** publishes the ID in a structured marker so checkpoint import and reconciliation can join the maps without using a title, repository, or first-map URL as identity.
_Avoid_: title key, coordinator-Issue identity, repository-scoped identifier

**Manager checkpoint**:
A portable point-in-time export of the **Manager portfolio** to an operator-controlled destination for recovery or transfer to another host. Import establishes the destination host's store as the single active writer; checkpoints are never a bidirectional synchronization channel or a second live authority.
_Avoid_: live sync, multi-writer portfolio, cloud control plane

**Manager effort lease**:
The single-writer claim over one effort in the **Manager portfolio**. Separate sessions may manage different efforts concurrently, and read-only status remains available, but a generation check prevents two sessions from writing the same effort or silently overwriting a newer transition.
_Avoid_: whole-portfolio lock, last-write-wins, parallel writers on one effort

**Manager trusted directive**:
Operator guidance received through the active **Manager** liaison or an owning HITL workflow from an identity authorised to change an effort's intent, authority, or dispatch. Tracker state and evidence participate in **Manager reconciliation**, but untrusted Issue, comment, PR, or other external content can never become an executable directive by itself.
_Avoid_: issue body as command, public comment as authority, ignoring tracker evidence

**Manager routing**:
The selection and invocation of an existing owner workflow through `ask-red`'s canonical routing inventory. The **Manager** adds portfolio membership, continuity, supervision, and completion around the selected route; it neither copies the route classifier nor asks the operator to choose a Skill when the inventory already determines one.
_Avoid_: second router, copied Skill rules, tool-choice prompt

**Manager lifecycle surface**:
The conversation-first operator interface for management: `$dev:manager <intent>` starts or continues an effort, while only `resume`, `status`, `end`, `checkpoint export`, and `checkpoint import` are explicit lifecycle operations. Owner-workflow names remain routing internals rather than Manager subcommands.
_Avoid_: one subcommand per Skill, ambient auto-activation, hidden end or transfer

**Manager session focus**:
The one managed effort used as the default referent in a session that may supervise several efforts concurrently. Events and mutations remain keyed by **Manager effort ID**; when human language does not identify its target unambiguously, the Manager asks before writing instead of guessing from the current focus.
_Avoid_: one effort per session, whole-portfolio implicit target, ambiguous write

**Manager effort lifecycle**:
The five-state lifecycle owned by a **Manager portfolio record**: `inbox` for intent that remains local, `active`, `paused`, `completed`, and `abandoned`. `end` releases the **Manager effort lease** and pauses a non-terminal effort; `resume` reactivates it. HITL, dependency blocking, failure, and underway work are reconciled projections from owner workflows, never duplicate effort states.
_Avoid_: issue-state mirror, end means delete, HITL as portfolio lifecycle

**Manager pause**:
The cessation of Manager-initiated action for a non-terminal effort after `end`. Already-dispatched owner workflows continue under their own contracts, and their events remain available for later **Manager reconciliation**; stopping or parking that work requires a separate trusted directive to its owning workflow.
_Avoid_: implicit worker cancellation, wait-until-idle exit, lost completion events

**Manager durability boundary**:
The earliest point at which locally held intent must be materialised in the relevant **Issue tracker**: before work is dispatched, management crosses a session boundary, another collaborator or HITL decision is involved, or persistent coordination depends on it. The operator may also request materialisation earlier. Purely exploratory conversation may remain local until one of these conditions occurs.
_Avoid_: publish every message, approval gate for every Issue, invisible dispatched work

**Manager authority envelope**:
The Manager's authority to materialise, route, dispatch, reconcile, and report autonomously while acting within published intent and the policies of the **Skills** that own each workflow. It must enter HITL when a choice changes the destination, scope, or requirements, requires authority not already granted, or the owning workflow itself requires a human decision.
_Avoid_: confirmation for every routine transition, autonomous product decisions, bypassing owner Skills

**Manager reconciliation**:
The deterministic refresh of a managed effort from its **Manager portfolio**, repository-owned **Manager maps**, published artifacts, and existing execution-state projections. It runs when management starts or resumes and before the Manager reports or ends; while supervision is active, only meaningful transitions such as completion, failure, HITL, dependency release, or frontier change wake the liaison. Unchanged state never wakes an LLM merely to poll.
_Avoid_: periodic agent polling, invocation-only snapshot, second worker monitor

**Manager brief**:
The stable bounded projection shown when the **Manager** starts, resumes, or reports status: destination and overall state; repository-owned **Manager maps**; actionable frontier; work underway; pending human decisions; risks; and recently delivered outcomes. Each actionable section shows at most five named items linked to their owning artifacts plus the count omitted, never a full graph dump or a fresh unstructured narrative.
_Avoid_: issue dump, raw worker log, freeform status essay

**Manager effort completion**:
The terminal state of a managed effort after its destination has acceptance evidence, no work or HITL remains active, and every in-scope artifact has an explicit terminal disposition: delivered, cancelled, superseded, or removed from scope. Any artifact intended to remain active is detached into another effort before the current effort and its repository-owned **Manager maps** complete.
_Avoid_: all Issues closed mechanically, operator-declared done with live work, closed map with stranded children

**Manager map**:
The repository-facing parent **Ticket** that projects one effort from the **Manager portfolio** into an **Issue tracker** from initial intent through final delivery. An effort has at most one Manager map in each participating repository, created only once that repository receives its first published artifact. Its direct children are only roots of existing work subgraphs — Wayfinder maps, **Specs**, and independent **Tickets** — whose own children remain under the artifact that owns their semantics. Validation and landing evidence remains with the artifact that produced it rather than becoming a Manager-map child. Native hierarchy and dependency relationships expose the actionable frontier. The map does not replace its artifacts or restate the detail they own. Unlike a Wayfinder map, it continues after the route becomes clear; unlike a **Spec**, it may begin before the solution is sufficiently defined. Its local projection of published work is reconstructible from the **Issue tracker**.
_Avoid_: Wayfinder map (decision-only), Spec (solution contract), task list, universal task format

**Manager map body**:
The stable low-resolution contract published in a **Manager map**: a structured **Manager effort ID** marker, destination, that repository's role, applicable acceptance criteria, standing notes, and pointers to the final outcome or disposition. Native children and dependencies provide live state; the body never mirrors their frontier, workers, blockers, or decision detail.
_Avoid_: dynamic dashboard, copied child status, identifier-only stub

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

**Elision**:
The removal of bytes from a command's output before an agent reads it. An Elision is never a deletion: it always mints an **Elision handle**, so the removed bytes stay retrievable.
_Avoid_: compression, filtering, trimming, when the bytes are gone for good

**Elision handle**:
The reference an elided output carries back to its full original in the **Repo store**. Handle and Elision are equivalent: an output carries a handle if and only if bytes were elided from it.
_Avoid_: tee file, cache key, blob id

**Passthrough**:
The delivery of a command's output to the agent byte-for-byte, with its exit code and stderr intact. Passthrough is the default; a surface earns the right to elide by measured saving, never by existing.
_Avoid_: raw mode, bypass, no-op filter

**Normalization**:
The silent removal or re-encoding of bytes that carry no information for an agent — ANSI colour codes, carriage-return progress bars, trailing whitespace, repeated blank lines, and the lossless transcode of valid JSON to TOON guarded by an on-the-spot round-trip check (`decode(encode(x)) === x`; any failure → **Passthrough**). Normalization is a closed allowlist and mints no **Elision handle**, because nothing is lost. Anything outside the allowlist is an **Elision**.
_Avoid_: cleanup, sanitizing, light filtering

**Fidelity assertion**:
A question the elided output must still answer, recorded in a filter's fixture beside the raw output it elides. Fidelity gates saving: a filter that saves tokens while failing an assertion has destroyed information, and it fails. Tokens saved is never reported alone.
_Avoid_: accuracy check, snapshot test, golden file

**Repo store**:
The single local RedDB file the repo's plugins share, provisioned by `/red-setup` at `.red/state/red-skills.rdb` (ADR 0098 amends ADR 0095's original root location). Plugins separate logically inside it by collection — the governed memory graph and the **Elision** records never mix — not by opening separate files.
_Avoid_: graph.rdb, the memory database, elision cache

**rsp**:
The single shared binary that wraps engineering CLIs behind agent-ergonomic subcommands (`rsp git status`, `rsp test`) and carries the interception hook's rewrite table in the same artifact, so the two can never version-skew. It lives in a neutral package consumed by `dev` and `memory`; its hook activates only in a repo whose `.red/config.yaml` opts in (ADR 0067 posture). Wrapper output is TOON per the public spec; every lossy level mints an **Elision handle**.
_Avoid_: proxy, drop-in replacement, compression layer, when naming the whole surface — interception is only one of its three parts

**TOONL**:
The append-only streaming extension of TOON (`github:reddb-io/toon`, spec v0.1): segment headers declare a schema once, rows follow positionally, an optional verified trailer closes a segment, and a crash-truncated open tail is valid ("unverified", never corrupt). TOONL is the on-disk format for every uniform RedSkills append stream (ADR 0097); TOON covers snapshots.
_Avoid_: TOON lines, JSONL replacement (it replaces JSONL here, but the term names the format, not the migration)

**tq**:
The jq-for-TOON CLI published from `github:reddb-io/toon`: query, convert (TOON/TOONL/JSON any-to-any), and stream. A required host binary — `/red-setup`, CI and `/red-doctor` use the exact catalog version from the official `reddb-io-tq` crate on crates.io. The installed binary must come from an official package channel; sibling checkout paths, local `target/` builds and unpublished release installers are forbidden. Skills docs teach `tq` pipelines with no jq fallback lane.
_Avoid_: jq (for TOON/TOONL files), the toon CLI, local tq build, sibling toon checkout

**Release watcher**:
The automation that observes upstream `github:reddb-io/toon` releases and opens the RedSkills auto-bump PR for the toon toolchain. It updates the pnpm catalog version and every derived or guard-checked `tq`/`@reddb-io/toon` pin site together; the catalog remains the single version truth, and the watcher PR is the normal route for routine upstream releases.
_Avoid_: manual version sweep, toon bump script, vendored-package repinner

**Release standard**:
The formalized release flow `/red-setup` provisions for a consumer repository (decided and being designed): changesets accumulate on the trunk, a **Version-PR** consumes them, its merge triggers the tag, and the tag publishes a Release carrying generated human notes plus a **Release manifest**. One product version rides the whole workspace (single train); the scheme is semver or calendar (`YYYY.M.MICRO`, deliberately semver-parseable). The interview lives in `/red-setup` after the validation moments; the engine ships as its own binary, pinned in thin generated workflows, with a vendored single-file mode for restricted CI.
_Avoid_: release pipeline (names any CI job, not this contract), changelog flow

**Version-PR**:
The open pull request the release engine maintains against the trunk: it consumes every pending changeset, bumps the declared **Version surfaces**, and renders the upcoming notes. Merging it IS the release trigger — the tag, the Release, and the assets follow from that merge. Under the `auto` trigger mode the same queue is consumed directly on push instead, with no PR ceremony.
_Avoid_: Version Packages PR (the changesets/action artifact this generalizes), release branch

**RC graduation**:
The pre-release model of the **Release standard**: a release candidate is cut from the **Version-PR**'s own branch state (`X.Y.Z-rc.N` — same bump, same changesets), so the merge promotes byte-for-byte what the RC tested to the stable version. A pre-release never diverges from the release it precedes.
_Avoid_: snapshot release (the continuous `-next.<sha>` firehose, a separate opt-in), pre mode

**Release manifest**:
The machine-readable asset attached to every published Release — version, date, impact-classified changes, authors, PRs — emitted as JSON (interop) and TOON (house) side by side. Together with the rendered Release notes it is the canonical changelog surface; no committed `CHANGELOG.md` exists under the standard.
_Avoid_: CHANGELOG.md, committed release feed

**Version surfaces**:
The set of files that carry the product version in a consumer repository (workspace manifests, extra declared paths, or a repo-owned sync command for exotic carriers). `/red-setup` detects the set, the operator confirms it, and the confirmed list is saved in `.red/config.yaml`; at release time the engine re-derives the real workspace and refuses the release when it diverges from the declared list, naming the orphan.
_Avoid_: sync targets, version files list

**Impact class**:
A changeset's declared bump type (`major`/`minor`/`patch`) read as change classification rather than arithmetic. Under semver it still drives the number; under calver the number comes from the date and the impact class only groups notes, flags breaking changes, and feeds the **Release manifest**. One changeset format stays valid under both schemes.
_Avoid_: bump type (implies it always bumps), severity

**Vendored source package**:
A workspace package whose source tree is committed directly in this monorepo while preserving an upstream marker for provenance. `packages/worker` (`@reddb-io/worker`) is the canonical example after ADR 0101: `.upstream` tracks the reviewed sandcastle upstream SHA, `NOTICE` carries the MIT attribution, and no archived repo supplies a live submodule pin. ADR 0148 renamed the package from `packages/red-castle` — the rename moved the code, never the lineage.
_Avoid_: submodule, pointer bump, two-repo flow

**Declared optimization**:
The output contract every TOON/TOONL producer obeys (ADR 0089 Amendments 2–3): explicitly lossless output preserves `decode(encode(x)) === x` (cell safety is encoder quoting, never pre-encode mutation); reduction — projection, capping, truncation — is marked in-band with what was reduced and how to recover it (an **Elision handle** where bytes are stored; `--full` or a lossless re-run where re-derivable). RSP's named **Automatic reduction** regime may activate only at deterministic size-and-repetition thresholds after original bytes are stored. Silent lossy normalization remains forbidden.
_Avoid_: compact mode (names the flag, not the contract), lossy output

**Automatic reduction**:
RSP's completed-command output regime (ADR 0089 Amendment 3): small or non-repetitive structure stays complete, while fixture-pinned size and repetition thresholds may produce a declared, recoverable summary. This is distinct from the **lossless** level; every automatic lossy result stores the exact original first, emits exactly one **Elision handle**, and offers `--full` suppression.
_Avoid_: lossless mode (when describing threshold-driven output), silent truncation

**Adversarial Review**:
The **Gate stage order**'s third stage: one or more reviewer agents inspect the WORKTREE diff against the merge base for defects and for conformance to the originating **Ticket** (was what the Ticket asked for actually implemented?), post their findings to the Ticket, and — when a finding is blocking — request a **Re-seed** back to the implementer with the diff and the critiques. It runs BEFORE any pull request exists and only once the earlier stages are green; a reviewer that crashes yields a skipped stage, which never blocks. Its verdict is binary — blocking or not-blocking — because the budget and the exhaustion rule live in the **Re-seed budget**, whose reserved review round gate churn cannot consume and whose exhaustion parks uniformly. One reviewer by default (any blocking finding triggers a Re-seed), configurable to a voting quorum; model, effort, and runner are configurable.
_Avoid_: code review (the advisory human-facing clarity pass), gate (machine validation — tests/lint/typecheck), lint, "runs on the PR diff" / "correction budget" (both retired with ADR 0129)

**Archived ADR**:
An ADR moved to `.red/adr/archive/` (via history-preserving `git mv`) once its decision reaches a terminal state — superseded by a newer ADR, deprecated, or fully shipped and inert. The original Decision is never rewritten: ADRs are immutable records, and only status, `Related`/`superseded-by` links, and stale-path prose are edited in place. Merge and split are supersede-and-replace — new ADRs carry the current decision while the originals are archived with a successor pointer, never combined or divided in place. Every archived number stays documented in the ADR **INDEX**, and a governance guard fails CI if any ADR number disappears or an archived ADR loses its successor pointer: archiving never deletes history.
_Avoid_: deleted ADR, rewritten decision, superseded (the status/pointer, not the physical relocation)

**Shared render**:
ADR 0130 rule 10's no-drift guarantee delivered as ONE renderer implementation rather than ONE rendered string. The **redskilled** daemon serves the payload; a render module outside it draws that payload at parameterized densities — a one-line statusline, a host panel, a full dashboard — so the statusline, the herdr plugin, the VS Code extension and the terminal dashboard cannot diverge while still differing in density. A single rendered string cannot serve a line and a TUI at once, which is the constraint that moved layout out of the daemon; keeping it out also keeps rule 3 intact, because a process forbidden to know what a phase is must not be drawing a phase bar. Modularized so each surface composes only the parts it shows.
**Stateless and encoding-agnostic**: it holds nothing between calls and owns no transport — it is a pure function from one decoded payload to one drawn surface, so the same module serves a socket read, a piped file and a fixture. It accepts JSON, JSONL, TOON and TOONL on the way in, matching the decoder that already sniffs JSON-or-TOON; what it EMITS still obeys the repo's TOON mandate, which governs writers, not readers.
_Avoid_: statusline string (the artifact, not the owner), daemon-rendered dashboard, "the daemon renders" (true only of the degraded one-liner), stateful panel

**Statusline Bedrock**:
The first segment of the statusline's header line, built exclusively from what answers with zero network and zero daemon: the Claude Code stdin payload (model·effort, context tokens/percent, `5h=`/`7d=` subscription windows), local git (repo basename, branch, local diff), and the running bundle version from build-info. Bedrock renders on every invocation regardless of **redskilled**'s state; everything remote — tracker counters, worker vitals — belongs to the redskilled-fed tail, never here. The bedrock/tail boundary is a fixed layout today, deliberately drawn so segments can become operator-composable later without redrawing the data ownership.
_Avoid_: local statusline (ambiguous with the whole command), first line (the tail shares it), offline mode (bedrock is not a fallback — it is the permanent first segment)

**Statusline Lifecycle**:
The visible state machine of the statusline's connection to **redskilled**, rendered so the operator always knows what stands between the line and its data: `bedrock-only` (daemon unreachable or plugin disabled), `connecting` (socket probe in flight), `registering` (project registration handshake pending), `live` (payload rendering, staleness inline), and `degraded` (payload served but stale beyond its declared window). States describe the statusline↔daemon relationship only; data staleness inside a live payload stays a per-token age, not a lifecycle state.
_Avoid_: connection status (untyped), loading (names no distinct state), spinner (a rendering, not the machine)

**Phase duration model**:
The measured cost of each macro-lifecycle phase, recorded on `.red/state/castle/phase-durations.toonl` — one row per phase a **Worker** LEAVES — and the only admissible basis for a published ETA (ADR 0132 decision 3). The terminal-event ledger beside it (`.red/state/castle/history.toonl`) records one `duration_s` per issue-level event, so the finest answer it can give is issue-grained ("issues like this took ~22 min on this runner") and it can say nothing about a Worker three minutes into `validating`. The estimate is the median of the current phase plus the median of every phase ahead, scoped to the Worker's runner where that runner has enough of its own history; the median rather than the mean, because one hour-long gate-lock wait drags a mean into fiction. **A phase short of samples refuses the WHOLE estimate**: `null` is the honest answer, and a floor assembled from the phases that happened to be measured would print with the same confidence as a complete one. **A linear extrapolation from `phase_index/phase_total` is refused outright** — it moves with the bar, so it looks precise while being systematically wrong, and `coding` and `validating` do not cost the same. Computed by the PROJECT and by nobody else: the **Shared render** is stateless and cannot accumulate history, and **redskilled** is forbidden the semantics to know what a phase is, so the estimate travels to the host as an opaque count exactly as a token count does.
_Avoid_: progress percentage, remaining-work estimate from the bar, ETA (unqualified — the term names the model, not the number it yields), attempt duration (the extinct noun; a **Worker** spends the phase)

**GitHub surface routing**:
The rule deciding which GitHub API answers a given call, owned by one module (`packages/github`) that both the **redskilled** daemon and the project bundle import. **The principle is cardinality, not frequency**: an individual single-object read (`issue view`, `pr view`) prefers REST, while a multi-node listing, a multi-repository aggregate, or a coalesced cold burst of same-kind objects goes to GraphQL. Coalescing does not make a lone operation balance-dependent: the burst is a newly observed multi-node operation, admitted only when its count exceeds a threshold derived from both pools' authoritative headroom. A held ETag removes the read from that trade and keeps it on conditional REST, where an unchanged answer is free. GitHub budgets the two surfaces separately — REST by request, GraphQL by node points, Search by minute — so the alias saves requests and never makes k returned objects flat in points. The authoritative **balance is asked, never counted**: each declared execution owner reads the token-wide answer at the package-owned adaptive cadence, never once per operation; the independent `rsp` resident is one such owner and does not couple its proxied reads to **redskilled**. A per-process inference about a shared token would be the same blindness that makes per-process RSS miss a cgroup's real total. A separate append-only attribution ledger records local evidence about who issued routed calls; it never becomes the balance. The inner agent crosses that same boundary through a private `gh` shim on its PATH, and each issued call is attributed to its **Worker**, so fleet width cannot create an invisible GitHub caller.
_Avoid_: rate limiter (the boundary admits against GitHub's answer; it does not invent a token bucket), "the GraphQL client", per-process inferred balance, raw Worker `gh`

**Semi-offline mode**:
The posture the engine adopts when the combined GitHub budget — REST requests, GraphQL points, Search minutes — is spent: a circuit breaker opens, reads fall back to prefetched state, and writes are dammed into a durable queue replayed when quota returns. **The claim is the one write that never dams.** Claiming is a three-layer scheme (local `mkdir` lock, GitHub label pre-check, stale-lock boot sweep), and damming the middle layer leaves only a host-local lock — safe on one machine, and two Workers on one branch the moment a second host drains the same backlog. Every other write is narrative: a late progress comment is cosmetic, a late claim is a collision. Prefetch is chosen by the PROJECT and executed by the daemon, because selecting issues by chained or similar dependencies means reading `req:N` and `blocked:dependency`, which is project execution semantics the daemon may not carry — a body it stores is opaque, a dependency graph it reasons over is not.
_Avoid_: offline mode (reads still need warm state), "queue the claim", degraded mode (names the symptom, not the contract)

**Default fleet width**:
How many Workers a project registers for when nobody says — **one**. It is machine budget, not project preference, so the **redskilled** daemon's host-scoped `defaultFleetWidth` is its ceiling and a project declares its own in `plugins.dev.afk.target` beneath that. One is the floor a maintainer can reason about: a second Worker doubles GitHub polling, doubles memory against a host ceiling every Worker is already granted in full, and is a decision worth making deliberately rather than inheriting. The rule this exists to enforce is that **every surface announces the same number** — a default advertised as `2` by an MCP schema, absent from config documentation and remembered as `1` by the maintainer is three defaults, and the drift is invisible until someone counts running Workers.
_Avoid_: concurrency, parallelism (both describe the effect, not the declared number), "the fleet size" (the Fleet is extinct)

**Front door (`drain`)**:
The `rs_dev` MCP's one entry verb for the common intent — "make this project drain": daemon reachable, project registered at the requested target, queue flowing. **Ensure semantics with a difference report**: calling it is never an error; an unchanged state answers with a report, a different target resizes, a lapsed registration is re-created, and the response always states what changed versus what already stood. The one refusal it keeps is a **runner** change, the single genuinely destructive switch. Specialized verbs remain for surgical use; the front door is where an agent starts without knowing the choreography.
_Avoid_: wrapper tool, macro verb, "the happy-path helper"

**Situational help**:
The `rs_dev` MCP's `help` tool: it reads the host's real state — daemon, registration, queue, workers, last refusal — and answers "you are HERE; the next step is THIS verb with THESE args", followed by a short intent map of the surface. **The one live source of choreography**: MCP prompts and skills point at it rather than restating it, because two sources of operating instructions drift and the drifted one is always the one somebody follows.
_Avoid_: manual tool, docs tool, static usage dump

**Repair (structured)**:
The machine-readable half of every redskilled refusal and empty-state: `repair: {tool, args, why}` — a cure the agent can invoke directly, beside the human sentence. The field exists so the stated cure and the executable cure cannot diverge: a message that names a label no code reads (the `triage:summon` incident) is impossible when the named cure IS the call. A refusal with no cure declares `repair: none` with its reason; a ratchet holds every new refusal to one or the other.
_Avoid_: hint, suggestion, "see the error message"

**Queue Custodian**:
The one module that owns "this pull request ends merged": it arms the native intent, watches for the intent vanishing, heals the mechanical causes, and escalates only genuinely semantic failures to the owning Ticket. **Native primary, driver recovery**: GitHub's auto-merge holds the intent — so a merge survives a dead resident — and the driver-style loop wakes only when that intent has vanished (the ejection). Every other "make sure this PR is queued" site is a caller, never a second implementation.
_Avoid_: merge helper, auto-merge wrapper, "the landing retry" (landing is the Worker's act; custody outlives the Worker)

**Brand grammar**:
The rule set every painted surface (statusline, VS Code dashboard, herdr panes) obeys under strict token compliance (ADR 0137): **the glyph is the truth** — state always survives in characters, so the NO_COLOR/plain render is the semantic baseline and color never carries meaning alone; **`red.500` is the only spotlight** — the published brand accent marks "look here" and nothing else; everything else is the neutral ramp read as intensity. Functional green/yellow are inexpressible until the brand publishes feedback tokens. Values come only from the vendored brand tokens package; emitting no value (terminal default, editor `ThemeColor`, named ANSI slot) is also compliant.
_Avoid_: "theme", hand-tuned hex, success/warning/danger colors (the brand has not decided them)

**Fork grant**:
The base SHA the redskilled daemon hands a Worker in its admission payload (ADR 0138): the daemon performs the one single-flight trunk fetch for the admission burst, and the Worker forks exactly the granted commit — it never fetches the trunk itself. **The fork point is part of the judged admission**: an unreachable remote refuses the birth (no Worker, no park, retry next cycle), and the granted SHA is the anchor for drift stamps ("base +N") and stale-base attribution downstream.
_Avoid_: "the worker's fetch", staleness stamp/threshold (the grant has no fetch-to-fork window to measure), fleet trunk mirror as something workers maintain

**Validation moment**:
A named point in a Worker's lifecycle where operator-declared validation commands run — post-DONE, correction, landing, with the merge queue documented as the CI-side final moment. **The declaration defines the moment; an undeclared moment is skipped, loudly** — the engine never guesses a command and never refuses to run for lack of one; every surface that narrates the run states which moments ran, which were skipped, and why. Post-DONE validates the branch against its **fork point**; freshness against the live base belongs exclusively to the merge queue, and a queue ejection is healed by the repair lane, not by re-validating in every Worker.
_Avoid_: gate stage (the gate is the semaphore, not the schedule), "the feedback loop", hardcoded default

## Relationships

- An **Issue tracker** holds many **Issues**.
- An **Issue** carries one **Triage role** at a time.
- Every **Issue** label should belong to a clear **Label family**; labels outside state, type, priority, relationship/dependency, or operational diagnostic families are candidates for removal or deprecation.
- The **HITL queue** contains non-Spec **Issues** selected by the `ready-for-human` state.
- **HITL selection** chooses one recommended **Issue** from the **HITL queue** and lets the maintainer `skip` when that Issue is not the right decision target.
- **HITL decision extraction** identifies the pending decision for the selected **Issue** before **HITL resolution** begins.
- **HITL decision recording** preserves the maintainer's answer as **Human guidance** and prepares the **Issue** for delegation when possible.
- A **HITL resolution** consumes one **Issue** from the **HITL queue** and may produce a `ready-for-agent` **Issue**.
- A non-delegable **HITL resolution** keeps the **Issue** in `ready-for-human` with the next pending decision stated explicitly.
- A delegable **HITL resolution** moves the **Issue** to `ready-for-agent` and removes all labels that keep it in the **HITL queue**.
- An **Issue** accumulates **Envelopes**, **Directive blocks**, **Human guidance**, and **Thread discussion**.
- A **Project control state** chooses eligible work and **redskilled** births disposable **Workers**; **Auto-monitor loop**, **Task mirror**, **Codex monitor agent**, and `monitor.sh` only observe.
- An **ACP workflow session** routes explicit commands deterministically and delegates free-form prompts to a **Manager**.
- There is exactly one **Project control state** per registered project and one **redskilled** daemon per host; each **Worker** resolves exactly one **Issue** and holds one **Worktree**, and its process liveness resolves through the **Liveness anchor**'s daemon read, never a pid file.
- One **Project** represents one logical GitHub repository and owns one daemon-managed **Project workspace**; any number of **Client checkouts** may control it without becoming execution roots or duplicating its queue, cache, **Drain intent**, or GitHub budget.
- MCP servers, CLIs, and editors are clients of **redskilled**; they never own project state or call GitHub independently on behalf of a managed workflow.
- **redskilled** is the sole GitHub gateway for managed workflows, coalescing reads and enforcing the shared API budget across every project client and **Worker**.
- The **Project authority split** keeps durable Ticket semantics in GitHub and operational consumption state in **redskilled**; neither side is a full duplicate of the other.
- **Project policy precedence** resolves host limits before explicit durable intents and tracked Trunk defaults; uncommitted **Client checkout** configuration is never an input.
- A **redskilled** daemon, its MCP adapters, and its **Workers** must share one **RedSkills wire major**; minor and patch differences interoperate, while ACP protocol-version negotiation remains a separate concern.
- A **Major handover** reaches quiescence before a new **RedSkills wire major** assumes the host endpoint; mixed-major workflow operation is never a supported state.
- A **Drain intent** survives every client disconnect and changes only through an explicit control-plane operation.
- **redskilled** authority is host-local: daemons never cluster or share live control state, and separate hosts coordinate work only through GitHub's durable workflow and claim facts.
- Every **Project** binds to one daemon-owned **GitHub credential profile**; local clients and **Workers** never possess or select the underlying token per request.
- The **GitHub gateway** gives **redskilled** exclusive ownership of managed REST, GraphQL, fetch, and push operations; Workers only edit and commit locally before requesting publication through ACP.
- **Client authority** scopes every connection before operations begin: project clients mutate one **Project**, while host-wide control requires an explicit administrative capability.
- Deterministic control-plane calls use the **RedSkills ACP extension**; MCP and CLI adapters are ACP clients and never introduce a second daemon protocol.
- **ACP core parity** keeps generic editors fully functional; the **RedSkills ACP extension** is a typed projection of the same operations, not an opt-in feature gate.
- The public RedSkills ACP Agent is a **Worker-backed Agent**: **redskilled** owns control and durable routing, while admitted **Workers** perform all generative execution.
- An **ACP session journal** lets **redskilled** replace a dead Worker while preserving the public session and its governed workflow pointers; provider-native session artifacts are subordinate evidence or resume optimizations.
- A **Workflow Worker** may serve several related prompt turns, but remains bounded to one Ticket and **Worktree**; ACP session lifetime never determines Worker lifetime.
- The **Detached permission rule** applies policy first, projects eligible decisions to an attached authorized client, and routes uncovered detached decisions to HITL without retaining a blocked Worker.
- The **Linux ACP rendezvous** uses one Unix socket per authority boundary and ACP stdio only at process-launch edges; every hop carries ACP even when its transport differs.
- A **Local ACP endpoint** is a Unix socket on Linux and a Windows Named Pipe on Windows; both transport the same ACP contract and support daemon/Worker reattachment.
- A **Worker placement driver** may use a native process, Docker, or Podman without changing Worker identity or ACP behaviour; final placement authority remains with **redskilled**.
- A **Worker reclaim rule** verdict decides what a dead **Worker**'s artifacts cost to keep; the daemon's answer is the only authority that releases them.
- A **Worker kind** distinguishes `/afk`, `/go`, and `/go --scout` inside the shared Worker root without creating separate live worker namespaces.
- A **Branch lock** constrains the **Primary checkout**; AFK **Worktrees** remain exempt.
- A **Pinned branch** constrains AFK base and merge target; a **Branch lock**, when set, overrides it (precedence lock > pin > main) and additionally toggles how completed work lands (locked → local locked branch; unlocked → admin-merged PR).
- **Ship (interactive landing)** is retired (ADR 0081); hand-done work reaches the shared validation gate via requeue, and dispatch happens through `/go` or `/afk`.
- A **Red lifecycle tier** defines whether `.red/` content is tracked, plugin-owned, durable-local, or disposable; the **Lane registry** assigns each non-tracked writer a named path inside the right tier.
- The **State tier** survives tmp cleanup; the **Tmp tier** is safe to delete by contract.
- A **Worker** measures into the **Phase duration model** as it leaves each phase and estimates from it; **redskilled** stores the estimate and the **Shared render** prints it, neither reading what it means.
- The **Codebase understanding surface** may read Memory graph evidence, but it does not own graph storage or ingest.
- The mutating **Skill curator** belongs to `dev`; telemetry evidence and reports belong to the Memory context.
- The **Release watcher** observes toon releases, updates the catalog, and lets the consuming workspace lockfile choose the exact catalog-resolved toon version.
- A **Vendored source package** keeps source local to RedSkills while using an explicit upstream marker for provenance.

## Example dialogue

> **Dev:** "This **Issue** is `ready-for-agent`; should AFK pick it up?"
> **Domain expert:** "Yes, unless a newer **Directive block** changes the brief. The worker should create a **Worktree**, post an **Envelope**, and merge back to the **Pinned branch**."

## Flagged ambiguities

- "backlog" previously meant both the issue-hosting tool and the body of work; resolved: use **Issue tracker** for the tool and avoid "backlog" as a domain term.
- "branch lock" and "pinned branch" were previously conflated; resolved: **Branch lock** is the operator's local opt-in (interactive enforcement *plus* the higher-precedence AFK base/landing toggle, ADR 0030/0031), while **Pinned branch** is the per-Issue/Spec base declaration the lock overrides when present.
