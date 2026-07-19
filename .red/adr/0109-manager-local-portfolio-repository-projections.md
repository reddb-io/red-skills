# Manager is a local portfolio liaison with repository-owned projections

## Status

Accepted. Records the architecture settled while wayfinding a RedSkills-native equivalent of FirstMate.

## Context

RedSkills already owns planning, specification, execution, supervision, HITL,
recovery, validation, and landing through separate Skills and the Castle
runtime. What it lacks is one operator-facing liaison that can carry an effort
from unstructured intent through those existing workflows, including efforts
that span repositories. Reimplementing their queues or execution semantics
inside Manager would create competing authorities; making GitHub the only
portfolio authority would lose the private pre-publication inbox and seamless
cross-repository continuity the liaison needs.

## Decision

`dev:manager` is a Skill facade over the existing owner workflows, not a new
execution engine, queue, or universal task type. The operator explicitly starts
or resumes Manager; it then remains the session liaison until the effort
completes or the operator ends management.

Authority is divided by fact:

- the local Manager portfolio is authoritative for portfolio membership,
  unmaterialised intent, and coordination across repositories;
- each published Issue-tracker artifact is authoritative for its own work
  state, decisions, and delivery evidence;
- Manager may materialise, route, dispatch, reconcile, and report within the
  published intent and the policies of each owner Skill, but changes to
  destination, scope, requirements, or authority enter HITL.

The Manager portfolio lives in one operator-and-host-scoped local store that is
independent of every repository. It is neither housed in a designated control
repository nor federated from equally authoritative per-repository stores. It
supports point-in-time export and import to an operator-controlled destination:
an imported checkpoint establishes the destination host as the one active
writer, never a live synchronization peer.

Portfolio persistence is deliberately minimal and structured: stable effort
identity and destination, lifecycle, repository and map references,
coordination edges, summaries of unmaterialised intent, reconciliation cursors,
and checkpoint metadata. Credentials, raw conversations, source code, diffs,
worker logs, and execution evidence are excluded; their owner artifacts remain
the only detailed stores.

Concurrency is single-writer per effort rather than per portfolio. Effort-level
leases plus generation checks allow separate sessions to manage different
efforts concurrently and permit read-only status, while preventing two writers
from mutating the same effort or silently overwriting a newer transition.

Reconciliation treats tracker content as untrusted state and evidence, not as a
command channel. Only guidance received from an authorised operator through the
active Manager liaison or an owning HITL workflow may change intent, authority,
or dispatch. External Issue, comment, and PR content never becomes an executable
directive merely because it appears on a linked artifact.

Effort membership follows destination and acceptance boundary, not session or
textual similarity. New intent joins the active effort only when both match;
otherwise it becomes a separate portfolio effort, and ambiguous membership is
resolved through HITL before any attachment or scope expansion.

`ask-red` remains the canonical routing inventory for choosing owner workflows.
Manager consumes and executes that route, adding portfolio, continuity,
supervision, and completion around it; it does not copy the classifier or make
the operator choose a Skill when the existing inventory already has an answer.

The operator surface is conversation-first: `$dev:manager <intent>` starts or
continues an effort. Only `resume`, `status`, `end`, `checkpoint export`, and
`checkpoint import` are explicit lifecycle operations; names of owner Skills
remain internal routing outcomes rather than public Manager subcommands.

The portfolio owns only five effort lifecycle states: `inbox`, `active`,
`paused`, `completed`, and `abandoned`. `end` releases the effort lease and
pauses a non-terminal effort; `resume` reactivates it. HITL, dependency
blocking, failure, underway work, and other owner-workflow states are derived
by reconciliation rather than copied into the effort state machine.

Each effort has an opaque immutable ID generated locally plus a mutable human
name. Every repository-owned Manager map carries the ID in a structured marker,
allowing reconciliation and checkpoint import to rejoin maps after renames or
map removal without making a title, repository, or first-map URL canonical.

The Manager map body is a stable low-resolution contract: effort-ID marker,
destination, repository role, applicable acceptance criteria, standing notes,
and outcome or disposition pointers. Native children and dependencies expose
live state; the body does not mirror frontier, workers, blockers, decisions, or
other detail owned by its artifacts.

One Manager session may supervise several efforts concurrently, with one
explicit conversational focus. Every event and mutation remains keyed by the
immutable effort ID; ambiguous human references trigger clarification before a
write rather than being guessed from the focused effort.

`end` pauses Manager action and releases the effort lease; it does not cancel or
park work already dispatched. Owner workflows continue under their contracts,
their events remain available for the next reconciliation, and stopping that
work requires a separate trusted directive to the owning workflow.

The first release is a functional vertical slice rather than a `SKILL.md`-only
procedure or FirstMate feature clone. It includes the conversation-first Skill
and deterministic support for portfolio records, leases, checkpoints,
Manager-map publication and reconciliation, event consumption, and brief
rendering. It does not claim work, run agents, validate changes, or land
delivery in place of existing owner workflows.

Claude Code, Codex, and OpenCode share that Skill and runtime contract in the
first slice. Hosts use their event adapters where meaningful wakes exist and
fall back to deterministic `resume` or `status` reconciliation where they do
not; host event capability may affect responsiveness but never portfolio
correctness.

Acceptance is contract and integration evidence plus one real dogfood journey:
an intent spans two repositories, materialises their maps, routes owner
workflows, pauses and resumes after restart, exports and imports a checkpoint,
crosses HITL or failure, reconciles delivery, and completes without lost or
duplicated work. Claude Code, Codex, and OpenCode each pass parity smokes.

An effort projects lazily into at most one Manager map per participating
repository. A map is an umbrella parent whose direct children are roots of
existing subgraphs — Wayfinder maps, Specs, and independent Tickets. Those
artifacts retain their own child hierarchies and semantics; validation and
landing evidence stays with the artifact that produced it. The local portfolio
binds the repository maps into one cross-repository effort.

Local intent crosses the Manager durability boundary before dispatch, a
session boundary, collaborator or HITL involvement, or persistent coordination.
Manager reconciles deterministically on start or resume and before reporting or
ending; existing runtimes wake it only for meaningful state transitions, never
for unchanged-state LLM polling. Its default resume/status surface is the
bounded Manager brief.

An effort completes only with acceptance evidence, no active work or HITL, and
an explicit terminal disposition for every in-scope artifact. Work intended to
remain active moves to another effort before the current maps close.

## Consequences

- Deleting a repository-local projection must not lose the work facts already
  owned by its Issue tracker, while loss of the local portfolio may lose facts
  that deliberately belong only to the cross-repository coordination layer.
- Manager must integrate through owner Skills such as Wayfinder, To Spec, To
  Tickets, AFK, Go, HITL, Retake, Verify, and their observability surfaces
  instead of cloning their contracts.
- Multi-repository efforts have several repository-owned maps but one local
  host portfolio identity; no repository is elected as an artificial global
  owner and no set of repository stores needs split-brain reconciliation.
- Host loss can recover from an operator-held checkpoint; without one, only
  published work facts are reconstructible. Multi-host live sync remains out of
  scope.
- X mode, alternate terminal backends, secondmate provisioning, self-update,
  and permission-bypass behavior from FirstMate are outside this decision.

## Rejected alternatives

- A repository-local Manager only cannot represent the selected
  cross-repository portfolio.
- A single owning repository makes an arbitrary tracker the authority for work
  elsewhere and complicates native ownership and permissions.
- Making local state authoritative for Issue work duplicates queues and
  delivery truth; making Issues authoritative for every fact eliminates the
  private pre-publication and cross-repository layer.
