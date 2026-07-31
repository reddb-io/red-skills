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
The castle resident's periodic reconciliation owner for **Quarantine**. It re-runs issue coherence, restores `ready-for-agent` when the defect dissolves, and parks `ready-for-human` for **HITL resolution** after three failed re-checks.
_Avoid_: supervisor sweep, manual quarantine cleanup

**Heal ledger**:
Durable per-Ticket repair history in the castle **State tier**. It permits at most two mechanically provable heals per rolling 24-hour window; the third repair request becomes **Quarantine** with the history included in the diagnosis.
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
How a completed **Worker**'s branch is integrated into its base, toggled by the **Branch lock** (ADR 0030/0031, write target moved to the remote by ADR 0083): a locked branch is integrated on `origin/<locked-branch>` for human promotion by pull (`landMerge`, with a one-shot self-resolve of merge conflicts), an unlocked branch lands via an admin-merged PR carrying the worker history (`landPr`). Never writes to the **Primary checkout**. Owns the push → integrate → land → post-merge sequence as one operation.
_Avoid_: merge, merge-back, integrate (these are sub-steps of Landing, not the operation)

**Baseline comparison**:
The feedback gate's classifier for a FAILED branch gate: the failing checks are re-run against the base worktree solely to decide who owns the failure. A failure absent from the base is `branch-fault`; a failure reproduced on the base is `inconclusive`; a probe that OOMs, crashes, or cannot be set up is inconclusive and silently logged. Every verdict except `clean` fails the gate and parks that ONE branch `blocked:validation` with the comparison evidence on the sidecar. Comparison-only by construction: it files nothing, downgrades nothing, and never blocks another branch's **Landing**.
_Avoid_: baseline probe as a main-health check, pre-existing-failure downgrade, tracked-red

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

**Worker**:
A single AFK orchestrator instance, identified by `w` + 4 characters (e.g. `wZ2R4`). It owns `.red/tmp/workers/{wid}/` and a single `worker.pid` liveness anchor, written once at bootstrap and removed on exit.
_Avoid_: agent, slot, runner

**Attempt / Attempt record — EXTINCT (ADR 0130)**:
The retired name for one **Worker** × one **Ticket** × one try, and for the durable per-try record that carried its narrative on `.red/state/castle/attempts.toonl`. Neither named a fact the **Worker** did not already carry: ADR 0103 had made a retry a fresh Worker, so a Worker *is* that unit, and the record was a third copy of pointers the **Issue tracker** and git already own. ADR 0130 removed the noun, the lane, the `red.castle.attempt.v1` contract and the retention rule together; what the record got right moved rather than died — process liveness re-anchored onto the **Liveness anchor**'s daemon read, and reclaim onto the **Worker reclaim rule**. The **redskilled** host event lane keeps the one fact no other authority holds, Worker-to-process: birth, death, and a budget-driven kill. The term survives only for reading the archived ADR 0128, ADR 0129, and historical **Envelopes**; never describe live execution with it.
_Avoid_: attempt, attempt record, attempt id, attempt ordinal, attempt lane, attempt state, per-attempt budget, attempt accounting, attempt usage (the supervisor's accounting and its budget vocabulary are keyed to the **Worker** — `worker-accounting.ts`, `worker-budget.ts`, `WorkerUsage`, `WorkerBudgets`; issue #2850), attempt worktree, `attempts.toonl` (every one is extinct — say **Worker**, and the **Worker outcome** for how its run ended); try, run, execution (these name a phase of a Worker's run, never a unit of its own); worker log (the `worker.log.toonl` **Tmp tier** lane is disposable and worker-written, and was never this record)

**Worker reclaim rule**:
When the janitor may reclaim what a **Worker** left behind, stated once: an artifact is reclaimable only when the daemon says the Worker that owns it is gone. The **redskilled** daemon owns birth and death by construction, so it cannot be out of date about a process it holds — a stronger authority than the extinct **Attempt record**, which could only repeat what it had last been told, and never a pid file, whose absence is what deleted the live lane while the dead ones survived (#2679). Three verdicts, and the third is load-bearing: `alive` (the daemon names the Worker — nothing it owns may go), `unknown` (the daemon did not answer, its answer is stale, or something else still sees the Worker — retained, because failing to reach the authority is not evidence of death), and `dead` (the daemon answered currently and does not name it — only here may bytes go). What a dead Worker leaves splits by *cost*: `workspace` is expensive and regenerable and goes, `evidence` is cheap and irreplaceable and stays (it is what a human reads to rescue orphaned work, #2701), `pointer` names a branch/PR/commit and holds no bytes, and an unrecognised `unknown` kind is retained and reported rather than guessed at. Two artifact-level overrides beat a dead Worker's release — `reclaimable: false` pins one, `reclaim_after` holds one until that instant. The planner is total: every artifact lands in exactly one of reclaim, retain, or dropped, so a cap or an unaccounted path is reported and never silently truncated.
_Avoid_: retention tier, attempt record retention (both extinct with the **Attempt** — the daemon's verdict and the artifact's cost class replace them); pid liveness, `worker.pid` check, mtime age (each is the anchor inversion this rule exists to forbid); TTL, grace period (inputs to `reclaim_after`, not the rule)

**Re-seed**:
Re-instructing the implementer **in place** — same **Worker**, same **Worktree**, same branch — after a **Gate stage order** stage blocked the work, so the committed branch is carried forward instead of rebuilt. It is the deliberate opposite of the ADR 0103 re-queue (fresh Worker, clean worktree from **Trunk**, `prev-failure-reason` in the prompt), and the contrast is the term's whole job: a re-queue discards, a Re-seed resumes. A Re-seed never mints a new **Worker**; the rounds are events inside the running one.
_Avoid_: attempt, new attempt (extinct — the **Worker** is the unit, and a Re-seed happens inside one running Worker), retry, attempt ordinal (retired by ADR 0103), correction retry

**Re-seed budget**:
The bound on how many **Re-seed** rounds one **Worker** may spend. A single ceiling per lane holds sub-caps per cause — a failing gate stage, a repeated failure signature escalating the tier, a blocking review finding — and the review's round is a **reservation**, not a quota, so gate churn cannot consume it. Exhaustion with anything still outstanding parks `ready-for-human` + `blocked:validation`, uniformly and regardless of cause; landing with a known blocking finding is not reachable by config value. An operator tunes only the gate's share (`dev.reseed.afk.gate_budget`); the ceiling and the reservation belong to the lane, so a raised setting can neither buy an unbounded run nor starve the review's round.
_Avoid_: correction budget, convergence budget, stall convergence budget (the `afk.stallConvergenceBudget` key names the retired shape), heal ledger (that is the per-Ticket repair history, a different object), attempt ledger, per-attempt budget (the rounds are events inside one running **Worker**, never a new unit of work)

**Worker kind**:
The castle engine provenance stamp that distinguishes why a **Worker** exists while all new workers share `.red/tmp/workers/`: `current.kind=afk` for the **Demand producer**'s queue-draining work, `current.kind=go` for approved one-off `/go` dispatch, and `current.kind=scout` for read-only `/go --scout` investigations. The legacy `.red/tmp/go-workers/` and `.red/tmp/scout-workers/` roots are read only as transitional observability inputs until they age out; they are not the live isolation contract.
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
The developer-facing opencode TUI surface that runs interactively (`opencode .`) on the same repo where AFK's inner-agent OpenCode runner executes headless. Treated as a **third host** alongside Claude Code and Codex (ADR 0075), with `plugins/<name>/` definitions shared across all three — the `apps/opencode-host/` adapter emits opencode-native config (`opencode.json` `provider>` + `mcp:` from Slice 3, `.opencode/skills/<name>/SKILL.md` via flat symlink from `plugins/<name>/skills/<bucket>/<name>/SKILL.md`, `.opencode/plugin/<event>.ts` from `plugins/<name>/hooks/<host>.hooks.json` and a per-plugin `session-status.ts` for the AFK statusline + toasts from Slice 4) from the same `.red/config.yaml` AFK already reads. Reuses the ADR 0059 env-precedence and `<provider>/<model>` slug verbatim (Amendment 3 of 0059). Slice 1 = provider block (ADR 0075); Slice 2 = skills (ADR 0076) + hooks (ADR 0077); Slice 3 = MCP passthrough (ADR 0079); Slice 4 = statusline + toasts (ADR 0080); Slice 5 = remote install.
_Avoid_: hand-authored `opencode.json` per project, second source of truth for the same model/auth config, duplicating `SKILL.md` into opencode-native skills, regenerating hook JSON into TS by hand (use the adapter)

**Agent runner / Runner spec**:
The provider-facing runner set (`AgentRunner` = claude | codex | opencode | claude-minimax) and the single descriptor table that owns each runner's provider policy — its accepted efforts, whether effort rides the numeric `effort` knob or OpenCode's free-form `variant` channel, any forced model (claude-minimax → MiniMax-M3), and its auth-env resolver. `toAgentRunner` projects the broader orchestrator **Runner** (which also includes the runner-neutral `hermes`) onto this set, collapsing any provider-less runner to `claude`. Adding a provider becomes one table row instead of parallel edits across `buildAgent`, `effortForProvider`, and the tier-table coercion.
_Avoid_: runner detection (that resolves *which* Runner to use; a Runner spec defines *what each provider runner accepts*)

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
The host-scoped execution daemon that owns worker **processes** across every project on one machine — birth, death, limits, and placement — while each project's bundle keeps owning the work (ADR 0130, decided and being implemented). Exactly one instance per machine behind a unix socket — a second OS user is refused by name rather than served from the first user's daemon (ADR 0130 Amendment 3) — it carries no castle semantics: it receives an argv, a placement target, a budget, and an opaque project label, and never derives repository layout, which is what lets one daemon serve checkouts pinned to different bundle versions. Workers run as transient init-system units rather than as its children, so it restarts and re-attaches instead of taking every project's work with it; when it is unreachable no worker is born at all. Its reach is asymmetric by design: a session reads every project on the host and writes only its own.
_Avoid_: supervisor, fleet supervisor (the per-project **Demand producer** is a different thing and stays in the repo), resident (that names the rsp core, ADR 0126), fleet (extinct — ADR 0130), scheduler (it admits and places, it never chooses whose work runs next)

**Host-scoped daemon home**:
`~/.red/redskilled/` — where the **redskilled** daemon keeps what belongs to the operator rather than to a checkout, including the `host` **Worker workspace** preset. **It has exactly one owner**: `provisionRedskilledHome` in `apps/redskilled/src/provision.ts` creates it and nothing else may (ADR 0130 Amendment 2). The daemon owns it rather than **red-setup** because start is auto-spawn — a home only an interactive installer could create would leave a fresh machine failing closed forever, with the daemon depending on the tool that depends on the daemon. ADR 0067's sole-creator authority is therefore repository-scoped: it governs a checkout's `.red/`, never the operator's `~/.red/`. **Provisioning is idempotent**: the home is created owner-only (`0700`), an existing one keeps everything in it, and a second run can only narrow a permission bit that drifted wider — a repair, not a rewrite. `/red-setup` provisions by *calling* the owner (`redskilled provision`), and `/red-doctor` reports the four checks (`home`, `daemon-entry`, `reach`, `supervisor-unit`) read-only, probing the socket without ever spawning the daemon it reports on.
_Avoid_: the repo's `.red/` (a different directory under a different authority), setup-owned home, daemon state dir (the session's runtime dir under `XDG_RUNTIME_DIR` holds the socket, lock, lease and event lane — that is not this)

**Demand producer**:
The per-project runtime that owns knowledge about *work* and holds none about *processes* (ADR 0130). It refreshes the **Trunk** mirror, samples queue depth, resolves an elastic target, carries runner directives, reconciles claims and fires lifecycle hooks; it holds no slot table, no birth, no reaping, no respawn and no resource sampling, because authority over the process belongs to the **redskilled** daemon. It says "I want N **Workers** with this profile" and consumes what the host grants, **which may be fewer** — a smaller grant is an ordinary answer from the only authority that sees every project at once, so the producer records the shortfall with the host's own reason and ends the tick rather than re-asking a full machine in a busy loop. **There is exactly one per project**: with the Fleet extinct, several **Work selectors** are an ordered priority *inside* one producer, and the registry refuses a second producer instead of serialising it, because a second loop is a bug to surface and never a queue to drain.
_Avoid_: fleet supervisor, fleet, named fleet, `--fleet`, slot manager, process manager (all extinct with the Fleet, ADR 0130 — an invocation that names one is refused with its replacement); daemon (that is **redskilled**, host-scoped and outside the repo); Claude fleet, task mirror, auto-monitor loop (observers, never producers)

**Launch template**:
What a project states its NEXT **Worker** should be started with — an argv and an env, both opaque to the **redskilled** daemon (ADR 0130 Amendment 5). It exists because a Worker's runner, model tier, effort and slot-scoped env are decided *per birth* while a registration carries *one* launch, and one frozen argv cannot express a decision made per Worker. **It is restated, never frozen**: a tick that swapped the runner sends the new pair on the renewal its session already sends, so a swap costs no new op, no round trip, and no window where the host holds no record of a project that is still draining. Facts the project cannot know in advance — the Worker's id, its slot, its workspace, its log path — are stated as `{{worker_id}}`-style placeholders and substituted by the daemon at birth, which is the whole of what the daemon contributes: it reads no word, refuses an unknown placeholder rather than starting a Worker with it, and still does not know what a runner is. Model and effort stay *out* of the launch on purpose — they resolve per tier, per run, inside the Worker, from the project's own config.
_Avoid_: spawn spec (that names the whole **Worker** launch the daemon builds from this), profile (that named the extinct Fleet's resource unit), argv alone (the env is half of it), macro/template language (four host facts substituted textually, never a language the daemon evaluates)

**Work selector**:
Which slice of the backlog a producer is allowed to drain — `{spec, lane, label, issues, tags, user}`, every present facet narrowing the pool, an empty selector meaning the whole backlog. It is **work policy, not a resource unit**, which is why it outlived the named fleet that used to own it (ADR 0130): the registry that stored `name -> profile` is gone, and the selector is handed to `project_start` and matched against candidates in the drain.
_Avoid_: fleet selector (the noun it hung off is extinct), filter (that names the `--spec`/`--issues` argv forms this generalises), territory (that names the `tag:`/`user` facets alone)

**Liveness anchor**:
The single resolution every management surface asks "is this **Worker** there, and how current is what I am reading?" — a Worker's process liveness resolves through the **redskilled** daemon, which owns birth and death, and a **Demand producer**'s through its own identity read (ADR 0128 §5, which survived its record's archiving into ADR 0130). One call answers both questions, from one read, so a payload cannot carry `alive: false` beside a fresh heartbeat — the contradiction behind #2698 and #2679. Two rules make it hold: an unattributable heartbeat is **orphaned** and therefore stale at any age, and the verdict travels *inside* the payload so a consumer renders staleness rather than re-deriving it. `project_status`, `project_stop`, `monitor`, `worker_vitals` and the statusline are migrated consumers; a migrated reader that reintroduces a private source fails the ratchet test.
_Avoid_: pid file, heartbeat snapshot, `state.toon` (each is an *anchor of the same identity*, never a source a reader picks between); attempt record, attempt liveness (extinct — the anchor a Worker's process verdict came from is the daemon, ADR 0130); liveness probe (the raw pid check the anchor uses)

**AFK polling cadence rule**:
The prompt-cache-aware rule for recurring AFK lane cadences: default recurring polls should be cache-warm at 270 seconds or less, or intentionally amortized at 20 minutes or more. Do not add defaults in the dead zone around 300 seconds. The current recurring-cadence inventory is: **Demand producer** health tick `RED_AFK_POLL_S` 15s before/after; event-driven supervisor fallback `RED_AFK_WAKE_FALLBACK_S` 60s before/after; worker proof-of-life heartbeat `RED_AFK_HEARTBEAT_S` 60s before/after; periodic dependency Unblock Sweep `RED_AFK_UNBLOCK_SWEEP_INTERVAL_S` 60s before/after; statusline/monitor expensive-fact cache `RED_AFK_STATUSLINE_CACHE_TTL_S` 180s before/after; stale-claim refresh `RED_AFK_CLAIM_REFRESH_S` 300s before, 270s after. Supervisor watchdog values such as `RED_AFK_SUPERVISOR_STALE_S` and `RED_AFK_SUPERVISOR_RESTART_WINDOW_S` are recovery windows rather than polling cadences; keep them above their safety thresholds instead of treating them as recurring polls.
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
The jq-for-TOON CLI shipped by `github:reddb-io/toon`: query, convert (TOON/TOONL/JSON any-to-any), and stream. A required host binary — `/red-setup` installs it via the toon repo's checksum-verified, version-pinned `install.sh`, and `/red-doctor` red-flags absence or drift. Skills docs teach `tq` pipelines with no jq fallback lane.
_Avoid_: jq (for TOON/TOONL files), the toon CLI

**Release watcher**:
The automation that observes upstream `github:reddb-io/toon` releases and opens the RedSkills auto-bump PR for the toon toolchain. It updates the pnpm catalog version and every derived or guard-checked `tq`/`@reddb-io/toon` pin site together; the catalog remains the single version truth, and the watcher PR is the normal route for routine upstream releases.
_Avoid_: manual version sweep, toon bump script, red-castle repinner

**Vendored source package**:
A workspace package whose source tree is committed directly in this monorepo while preserving an upstream marker for provenance. `packages/red-castle` is the canonical example after ADR 0101: `.upstream` tracks the reviewed sandcastle upstream SHA, while the archived `reddb-io/red-castle` repo no longer supplies a live submodule pin.
_Avoid_: submodule, pointer bump, two-repo flow

**Declared optimization**:
The two-regime output contract every TOON/TOONL producer obeys (ADR 0089 Amendment 2): by default output is lossless (`decode(encode(x)) === x`; cell safety is encoder quoting, never pre-encode mutation); reduction — projection, capping, truncation — happens only behind an explicit opt-in flag and is marked in-band with what was reduced and how to recover it (an **Elision handle** where bytes are stored; re-run without the flag where re-derivable). Silent lossy normalization on the default path is the forbidden pattern.
_Avoid_: compact mode (names the flag, not the contract), lossy output

**Adversarial Review**:
The **Gate stage order**'s third stage: one or more reviewer agents inspect the WORKTREE diff against the merge base for defects and for conformance to the originating **Ticket** (was what the Ticket asked for actually implemented?), post their findings to the Ticket, and — when a finding is blocking — request a **Re-seed** back to the implementer with the diff and the critiques. It runs BEFORE any pull request exists and only once the earlier stages are green; a reviewer that crashes yields a skipped stage, which never blocks. Its verdict is binary — blocking or not-blocking — because the budget and the exhaustion rule live in the **Re-seed budget**, whose reserved review round gate churn cannot consume and whose exhaustion parks uniformly. One reviewer by default (any blocking finding triggers a Re-seed), configurable to a voting quorum; model, effort, and runner are configurable.
_Avoid_: code review (the advisory human-facing clarity pass), gate (machine validation — tests/lint/typecheck), lint, "runs on the PR diff" / "correction budget" (both retired with ADR 0129)

**Archived ADR**:
An ADR moved to `.red/adr/archive/` (via history-preserving `git mv`) once its decision reaches a terminal state — superseded by a newer ADR, deprecated, or fully shipped and inert. The original Decision is never rewritten: ADRs are immutable records, and only status, `Related`/`superseded-by` links, and stale-path prose are edited in place. Merge and split are supersede-and-replace — new ADRs carry the current decision while the originals are archived with a successor pointer, never combined or divided in place. Every archived number stays documented in the ADR **INDEX**, and a governance guard fails CI if any ADR number disappears or an archived ADR loses its successor pointer: archiving never deletes history.
_Avoid_: deleted ADR, rewritten decision, superseded (the status/pointer, not the physical relocation)

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
- A **Demand producer** asks for AFK **Workers** and **redskilled** births them; **Auto-monitor loop**, **Task mirror**, **Codex monitor agent**, and `monitor.sh` only observe.
- There is exactly one **Demand producer** per project and one **redskilled** daemon per host; each **Worker** resolves exactly one **Issue** and holds one **Worktree**, and its process liveness resolves through the **Liveness anchor**'s daemon read, never a pid file.
- A **Worker reclaim rule** verdict decides what a dead **Worker**'s artifacts cost to keep; the daemon's answer is the only authority that releases them.
- A **Worker kind** distinguishes `/afk`, `/go`, and `/go --scout` inside the shared castle worker root without creating separate live worker namespaces.
- A **Branch lock** constrains the **Primary checkout**; AFK **Worktrees** remain exempt.
- A **Pinned branch** constrains AFK base and merge target; a **Branch lock**, when set, overrides it (precedence lock > pin > main) and additionally toggles how completed work lands (locked → local locked branch; unlocked → admin-merged PR).
- **Ship (interactive landing)** is retired (ADR 0081); hand-done work reaches the shared validation gate via requeue, and dispatch happens through `/go` or `/afk`.
- A **Red lifecycle tier** defines whether `.red/` content is tracked, plugin-owned, durable-local, or disposable; the **Lane registry** assigns each non-tracked writer a named path inside the right tier.
- The **State tier** survives tmp cleanup; the **Tmp tier** is safe to delete by contract.
- The **Codebase understanding surface** may read Memory graph evidence, but it does not own graph storage or ingest.
- The mutating **Skill curator** belongs to `dev`; telemetry evidence and reports belong to the Memory context.
- The **Release watcher** observes toon releases, updates the catalog, and lets the consuming workspace lockfile choose the exact red-castle-resolved toon version.
- A **Vendored source package** keeps source local to RedSkills while using an explicit upstream marker for provenance.

## Example dialogue

> **Dev:** "This **Issue** is `ready-for-agent`; should AFK pick it up?"
> **Domain expert:** "Yes, unless a newer **Directive block** changes the brief. The worker should create a **Worktree**, post an **Envelope**, and merge back to the **Pinned branch**."

## Flagged ambiguities

- "backlog" previously meant both the issue-hosting tool and the body of work; resolved: use **Issue tracker** for the tool and avoid "backlog" as a domain term.
- "branch lock" and "pinned branch" were previously conflated; resolved: **Branch lock** is the operator's local opt-in (interactive enforcement *plus* the higher-precedence AFK base/landing toggle, ADR 0030/0031), while **Pinned branch** is the per-Issue/Spec base declaration the lock overrides when present.
