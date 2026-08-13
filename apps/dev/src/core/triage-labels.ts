// triage-labels — canonical string constants for the GitHub issue triage-label vocabulary.
//
// Every module that references a triage label (routing, blocked reason, priority, or
// type) must import from here. Never redefine these inline or as local consts — doing
// so creates the drift-prone duplication this module was extracted to eliminate.
//
// The authoritative human-readable vocab spec is .red/agents/triage-labels.md.

// Lifecycle routing labels
export const LABEL_READY = "ready-for-agent";
export const LABEL_RUNNING = "running";
export const LABEL_HUMAN = "ready-for-human";
export const LABEL_CONTESTED = "contested";
/** ADR 0122 issue-local safety hold. Quarantined issues are excluded from the
 * executable queue until the castle curator can prove coherence or park them
 * for HITL after its bounded re-check budget. */
export const LABEL_QUARANTINE = "quarantine";
// PR-object entry label (PRD #745, issue #746): a maintainer applies this to a
// PR to request the advisory cloud review. It is the only PR-specific label —
// the review then transitions the PR through the shared lifecycle vocabulary
// (`running` / `ready-for-human` / `blocked:*`).
export const LABEL_READY_FOR_REVIEW = "ready-for-review";
// Isolated `/go` dispatch lane (ADR 0081, PRD #928 / issue #938). A disposable
// `/go` tracking issue is minted with THIS label and NEVER `ready-for-agent`,
// so the running fleet's candidate listing (which lists `ready-for-agent`) can
// never surface it. The dedicated `/go` worker lists this lane instead and
// processes the single minted issue directly.
export const LABEL_GO_LANE = "lane:go";
// Isolated `/go --scout` read-only investigation lane (issue #922). A disposable
// scout tracking issue carries THIS label (never `ready-for-agent` or `lane:go`)
// and is processed by a dedicated scout worker that runs the agent in read-only
// mode — no commits, no branch push, no PR, no merge. The agent posts a report
// comment and the issue auto-closes; nothing lands on main.
export const LABEL_SCOUT_LANE = "lane:scout";
// Territory-scoping label family: `tag:<value>` labels partition one shared
// `ready-for-agent` pool between several humans' fleets. Stamped at creation
// time (`/go --tags`, `/to-spec`, `/to-tickets`), consumed by `/afk --tags`
// (selector `tags` facet, AND semantics). Never drives lifecycle transitions.
export const TAG_LABEL_PREFIX = "tag:";
export function tagLabel(value: string): string {
  return `${TAG_LABEL_PREFIX}${value}`;
}

// Per-issue MANUAL-LANDING mode (issue #1049). A `ready-for-agent` issue carrying
// THIS label runs the full normal AFK pipeline — claim, worktree, inner agent,
// salvage, feedback gate, push, open the PR — then STOPS before any merge and
// parks `ready-for-human` with the PR link, exactly like the `blocked:ci` shape
// (PR left open, agent never re-runs, a human drives the final merge click). It
// lets fully agent-codable slices that must not be auto-merged (e.g. changes to
// AFK's own landing/claim machinery) stay in the autonomous lane instead of being
// hand-dispatched via `/go`. The issue closes on PR merge via the `Closes #N`
// back-reference. Created idempotently by `/red-setup`; `/triage` may set
// it at brief-writing time when the slice touches landing/claim machinery.
export const LABEL_LANDING_MANUAL = "landing:manual";

// Triage state labels
export const LABEL_NEEDS_TRIAGE = "needs-triage";
export const LABEL_NEEDS_INFO = "needs-info";
export const LABEL_WONTFIX = "wontfix";

// Control label: a maintainer summon that releases an untrusted author's
// `needs-triage` issue to auto-triage (#751). Created on demand like the other
// auxiliary labels. The `/dev triage` invocation is the other summon channel.
export const LABEL_TRIAGE_SUMMON = "triage:summon";

// Priority / type labels
// The parent-document type marker (ADR 0093 renamed `type:prd` → `type:spec`).
// The symbol is LABEL_TYPE_SPEC, not LABEL_SPEC — the latter is already the
// `blocked:spec` reason label below.
export const LABEL_TYPE_SPEC = "type:spec";
export const LABEL_NEEDS_SLICING = "needs-slicing";
export const LABEL_URGENT = "priority:urgent";
export const LABEL_HIGH = "priority:high";
export const LABEL_BUG = "bug";

// Blocked reason labels
export const LABEL_VALIDATION = "blocked:validation";
// AFK runner improvement: distinguish INFRA validation failures (worktree
// setup / pnpm install / OOM / ENOENT — the gate's environment is broken) from
// SEMANTIC validation failures (the worker's tests actually failed for code
// reasons). Verdict grants free environment rounds from one ledger; repetition
// or exhaustion parks under this label without charging the branch. The label
// is observability only; Verdict, not the label, owns routing.
export const LABEL_VALIDATION_INFRA = "blocked:validation-infra";
export const LABEL_STALLED = "blocked:stalled";
// Wall-clock cap (#2701): the worker was cut off by the per-issue wall-clock
// ceiling while it was still working. Distinct from `blocked:stalled` — nothing
// was stuck, a policy deadline expired — so the branch/PR it produced is handed
// forward to the next worker instead of being written off as a dead attempt.
export const LABEL_WALL_CLOCK_CAPPED = "blocked:wall-clock-capped";
export const LABEL_CRASHED = "blocked:crashed";
// A Worker could not complete because its runner died or became unavailable.
// This is the 1:1 projection of a Current blocker whose kind is `runner`;
// `blocked:crashed` remains the distinct process-crash classification.
export const LABEL_RUNNER = "blocked:runner";
// External-signal kill (#1308): the inner process was terminated by an OS
// signal (SIGKILL/SIGTERM from the harness or kernel). Distinct from a plain
// `blocked:runner` (no-sentinel) so the kill cause is actionable.
export const LABEL_SIGNAL_KILLED = "blocked:signal-killed";
export const LABEL_DEPENDENCY = "blocked:dependency";
export const LABEL_SPEC = "blocked:spec";
export const LABEL_QUOTA = "blocked:quota";
export const LABEL_RUNNER_TRANSIENT = "blocked:runner-transient";
// Permanent host prerequisite/configuration failure (for example a missing
// `sh` interpreter or vanished worker cwd). Never auto-retried.
export const LABEL_HOST_CONFIG = "blocked:host-config";
export const LABEL_MERGE_CONFLICT = "blocked:merge-conflict";
// AFK runner improvement (#812): an UNLOCKED admin-merge cannot bypass required
// status checks on an `enforce_admins` base. A completed, MERGEABLE PR whose
// required checks have FAILED, or are still PENDING past the CI-wait timeout, is
// NOT a merge conflict — the branch merges cleanly once CI is green. This label
// marks that distinct "blocked by CI, not by git" hold so a failed check / a
// pending PR is never mislabelled `blocked:merge-conflict` and never triggers a
// full inner-agent re-run.
export const LABEL_CI = "blocked:ci";
export const LABEL_POLICY = "blocked:policy";
export const LABEL_INFRA = "blocked:infra";
// ADR 0083 landing precondition: the primary checkout's LOCAL trunk ref has
// DIVERGED from `origin/<trunk>` (it carries commits origin does not). The
// Landing aborts BEFORE integrating any attempt branch and NEVER repairs the
// divergence (no reset / stash / auto-commit / force-push) — a human must
// reconcile the local repository state, so the issue parks with THIS label. It
// is human-only (non-recoverable): a bounded auto-retry cannot fix a diverged
// local branch, and re-running the agent would just re-hit the same precondition.
export const LABEL_TRUNK_DIVERGED = "blocked:trunk-diverged";
// Attempt base resolution guard (#1380): the remote base could not be fetched and
// the local base branch is behind the last-known remote-tracking tip. A worker
// must never branch from that stale local base because it can revert already
// landed sibling work.
export const LABEL_BASE_STALE = "blocked:base-stale";
// AFK runner improvement (#908): the per-attempt resource budget guard aborted
// the attempt — it breached a token/cost/tool-call/waiting-window ceiling before
// it could finish. Distinct from `blocked:stalled` (a stall is *no* progress;
// a budget abort may have been actively — and expensively — working). Partial
// work is salvaged + parked for a human; never blind-retried as a transient.
export const LABEL_BUDGET = "blocked:budget";

// Task-type routing labels (fleet-native dispatch)
// A `ready-for-agent` issue carrying this label is dispatched in read-only
// investigation mode — no commits, no push, no PR. The orchestrator posts the
// agent's output as a comment and closes the issue. Regression guard: issues
// WITHOUT this label are dispatched as normal ship tasks (unaffected).
export const LABEL_TYPE_SCOUT = "type:scout";

// Manager map label (ADR 0109, Spec #2290, slice #2294).
// Applied to the umbrella parent issue that carries the effort-ID marker.
// Never applied to Specs, Tickets, or any other child artifact.
export const LABEL_MANAGER_MAP = "type:manager-map";

// Provenance label (issue #2603). Auto-applied by the labeling workflow to any
// issue or PR whose author lacks repository write access — the mechanical marker
// the AFK claim path reads to HOLD unapproved external-origin work for human
// review. Auto-created when missing; never drives lifecycle transitions on its
// own. A maintainer releases such an issue with an `/approve-external` comment
// resolved through the write-access trust resolver (see trust-gate.ts).
export const LABEL_ORIGIN_EXTERNAL = "origin:external";

/** The comment marker a maintainer posts to release an `origin:external` issue
 * into the executable queue. Authorization is resolved through the existing
 * write-access trust resolver (`resolveActorTrust`), NOT by the marker alone. */
export const EXTERNAL_APPROVAL_MARKER = "/approve-external";

// Auxiliary labels
export const LABEL_RUNNER_ERROR = "runner-error";

/**
 * The label vocabulary an engine module reads as INJECTED CONFIG rather than as
 * a value-import of this host module — the castle port convention
 * (`CastleSelectionLabels` in red-castle's `engine/worker-drain.ts`). A module
 * that crosses into the engine cannot import host constants, so it declares the
 * slice of the vocabulary it needs and the host wires
 * {@link DEFAULT_TRIAGE_LABELS} at its construction site.
 */
export interface TriageLabelConfig {
  /** `ready-for-agent` — the executable-queue routing label. */
  ready: string;
  /** `running` — the observability projection of an active claim. */
  running: string;
  /** `ready-for-human` — the HITL park routing label. */
  human: string;
  /** `blocked:validation` — a gate failure a human must resolve. */
  validation: string;
  /** `blocked:dependency` — a `req:*` dependency wait. */
  dependency: string;
  /** `blocked:policy` — an operator-action policy block. */
  policy: string;
  /** `blocked:infra` — an operator-action infrastructure block. */
  infra: string;
  /** `blocked:merge-conflict` — a land-time conflict park. */
  mergeConflict: string;
  /** `blocked:spec` — the human-decision boundary the ADR calls out. */
  spec: string;
  /** `blocked:` — the prefix every blocked-reason label shares. */
  blockedPrefix: string;
  /** `req:` — the prefix of a dependency edge label (`req:{issue}`). */
  reqPrefix: string;
}

/** This host's real vocabulary, wired into every engine construction site. */
export const DEFAULT_TRIAGE_LABELS: TriageLabelConfig = {
  ready: LABEL_READY,
  running: LABEL_RUNNING,
  human: LABEL_HUMAN,
  validation: LABEL_VALIDATION,
  dependency: LABEL_DEPENDENCY,
  policy: LABEL_POLICY,
  infra: LABEL_INFRA,
  mergeConflict: LABEL_MERGE_CONFLICT,
  spec: LABEL_SPEC,
  blockedPrefix: "blocked:",
  reqPrefix: "req:",
};
