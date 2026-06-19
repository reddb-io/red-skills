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
export const LABEL_STALLED = "blocked:stalled";
export const LABEL_CRASHED = "blocked:crashed";
export const LABEL_DEPENDENCY = "blocked:dependency";
export const LABEL_SPEC = "blocked:spec";
export const LABEL_QUOTA = "blocked:quota";
export const LABEL_RUNNER_TRANSIENT = "blocked:runner-transient";
export const LABEL_MERGE_CONFLICT = "blocked:merge-conflict";
export const LABEL_POLICY = "blocked:policy";
export const LABEL_INFRA = "blocked:infra";

// Auxiliary labels
export const LABEL_RUNNER_ERROR = "runner-error";
