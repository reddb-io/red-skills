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
// AFK runner improvement (#908): the per-attempt resource budget guard aborted
// the attempt — it breached a token/cost/tool-call/waiting-window ceiling before
// it could finish. Distinct from `blocked:stalled` (a stall is *no* progress;
// a budget abort may have been actively — and expensively — working). Partial
// work is salvaged + parked for a human; never blind-retried as a transient.
export const LABEL_BUDGET = "blocked:budget";

// Auxiliary labels
export const LABEL_RUNNER_ERROR = "runner-error";
