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

// Per-issue MANUAL-LANDING mode (issue #1049). A `ready-for-agent` issue carrying
// THIS label runs the full normal AFK pipeline — claim, worktree, inner agent,
// salvage, feedback gate, push, open the PR — then STOPS before any merge and
// parks `ready-for-human` with the PR link, exactly like the `blocked:ci` shape
// (PR left open, agent never re-runs, a human drives the final merge click). It
// lets fully agent-codable slices that must not be auto-merged (e.g. changes to
// AFK's own landing/claim machinery) stay in the autonomous lane instead of being
// hand-dispatched via `/go`. The issue closes on PR merge via the `Closes #N`
// back-reference. Created idempotently by `/setup-red-skills`; `/triage` may set
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
export const LABEL_PRD = "type:prd";
export const LABEL_URGENT = "priority:urgent";
export const LABEL_HIGH = "priority:high";

// Blocked reason labels
export const LABEL_VALIDATION = "blocked:validation";
// AFK runner improvement: distinguish INFRA validation failures (worktree
// setup / pnpm install / OOM / ENOENT — the gate's environment is broken) from
// SEMANTIC validation failures (the worker's tests actually failed for code
// reasons). Infra failures are auto-recoverable via the `validation-infra`
// recovery policy (default cap 2); semantic failures stay non-recoverable and
// page a human. Observability-only label: the routing decision is made by
// `routeRecovery` via the recovery cap, not by the label.
export const LABEL_VALIDATION_INFRA = "blocked:validation-infra";
export const LABEL_STALLED = "blocked:stalled";
export const LABEL_CRASHED = "blocked:crashed";
export const LABEL_DEPENDENCY = "blocked:dependency";
export const LABEL_SPEC = "blocked:spec";
export const LABEL_QUOTA = "blocked:quota";
export const LABEL_RUNNER_TRANSIENT = "blocked:runner-transient";
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

// Auxiliary labels
export const LABEL_RUNNER_ERROR = "runner-error";
