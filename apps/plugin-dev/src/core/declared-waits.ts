/**
 * declared-waits — THE INVENTORY the declared-wait ratchet enumerates against
 * (issue #3024, Spec #3022).
 *
 * Split out of `declared-wait-guard.ts` because the two halves grow for
 * different reasons and only one of them grows without bound: the SCANNER is
 * finished work — a brace walk, a reach table, a comparison — while the LIST
 * gains an entry every time the engine learns to wait for something new. Kept
 * in one file, the scanner's file length was a debt the next declared wait paid
 * for, which is exactly backwards: declaring a wait is the behaviour the ratchet
 * wants to be cheap.
 *
 * The vocabulary lives here too, so this module reaches nothing and the guard
 * reaches only this.
 */

/** How a wait announces itself on each poll — or why it does not. */
export type WaitHeartbeat =
  | {
      /**
       * The sink symbol the wait fires before each sleep, named so the guard can
       * see it is actually wired in the same module (`onWait`, `notifyWait`, a
       * logger call). The heartbeat must carry the subject; a bare "still
       * waiting" is the silence this guard exists to end.
       */
      sink: string;
      silent?: never;
    }
  | {
      /** Why this wait needs no heartbeat. Required — silence must be argued. */
      silent: string;
      sink?: never;
    };

/** One declared wait loop in the engine. */
export interface DeclaredWait {
  /** Repo-relative path of the module holding the loop. */
  path: string;
  /**
   * The enclosing function or method name, which is what makes an entry survive
   * an edit above it: a line number would go stale on every insertion, and a
   * bare path could not tell three loops in one module apart.
   */
  fn: string;
  /** What is being waited FOR, in the words the heartbeat says. */
  subject: string;
  /** When the wait stops waiting. `"unbounded"` is legal and deliberately loud. */
  deadline: string;
  /** What happens when the deadline passes. */
  escalation: string;
  /** How the wait announces itself on each poll — or why it does not. */
  heartbeat: WaitHeartbeat;
}

/**
 * THE INVENTORY. Every wait loop in the engine, with its subject, deadline and
 * escalation. Sorted by path so a new entry lands where a reader looks for it.
 *
 * Read the `deadline` column top to bottom before adding an entry: the engine's
 * waits are overwhelmingly bounded, and the two that are not say so.
 */
export const DECLARED_WAITS: readonly DeclaredWait[] = [
  {
    path: "packages/worker/src/acp/gate-lock.ts",
    fn: "acquireHostGateLock",
    subject: "the host-wide gate slot — one declared Validation execution at a time per machine (#4161)",
    deadline: "`deadlineMs`, default 15 minutes of waiting",
    escalation:
      "proceeds WITHOUT the lock and says so — a wedged lock must not park every Worker on the host; a dead holder is broken immediately",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "apps/plugin-dev/src/core/mcp-lane-canary.ts",
    fn: "awaitHost",
    subject: "the daemon's own answer for a project reaching the shape this step requires",
    deadline: "`demandDeadlineMs` from the first probe",
    escalation: "goes `inert` with `timeoutDetail`, naming what never arrived and for how long it watched",
    heartbeat: {
      silent:
        "the canary IS the observability probe: its whole output is the step table it is about to write, and a mid-walk heartbeat would report the same fact twice",
    },
  },
  {
    path: "apps/plugin-dev/src/core/mcp-lane-canary.ts",
    fn: "runMcpLaneCanary",
    subject: "the quiet window in which a Worker the daemon does not name would appear",
    deadline: "`quietDeadlineMs` from registration",
    escalation:
      "the window closing IS the pass; a stray seen inside it goes `inert` as an unbudgeted birth",
    heartbeat: { silent: "same probe, same reason: the step record is the report" },
  },
  {
    path: "apps/plugin-dev/src/core/mcp-lane-canary.ts",
    fn: "stopProject",
    subject: "the project's Workers exiting after `project_stop` deregistered it",
    deadline: "`teardownDeadlineMs`",
    escalation: "returns `inert` naming the survivors and how long they outlived the teardown",
    heartbeat: { silent: "same probe, same reason: the step record is the report" },
  },
  {
    path: "apps/plugin-dev/src/core/merge.ts",
    fn: "waitForReviewCheck",
    subject: "the configured review check reaching a terminal state on the PR",
    deadline: "`maxPolls` × `intervalMs`, default 30 × 10s = 5 minutes",
    escalation:
      "returns `timeout` or `absent` and the caller merges ANYWAY — the review is advisory (ADR 0048) and a never-concluding reviewer must not wedge the landing",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/plugin-dev/src/core/merge.ts",
    fn: "waitForMergeReadyWithEvidence",
    subject: "the PR settling to a terminal readiness — merge, conflict or ci-failed",
    deadline: "`maxPolls` × `intervalMs`, default 60 × 10s = 10 minutes",
    escalation:
      "returns `pending`; the caller hands off the OPEN PR to a human rather than re-running the agent (#812)",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/plugin-dev/src/core/merge.ts",
    fn: "waitForQueuedMerge",
    subject:
      "the native merge queue merging the PR, dequeuing it without merging, or the PR settling to a conflict no queue can accept",
    deadline:
      "`maxPolls` × `intervalMs`, default 120 × 15s = 30 minutes, shared with the post-rebase retry so the whole tail costs ONE deadline; ONE probe when no clock is injected",
    escalation:
      "returns `pending`, leaving the PR queued for the next sweep to re-read; a settled conflict returns `unqueueable` early (#3030) and the caller rebases ONCE, then parks the branch, the PR and the issue for a human; four CONSECUTIVE unreadable probes return `probe-failing` early (#3160), which parks as `infra` because a confirmation that cannot see is a broken client rather than a slow queue",
    heartbeat: { sink: "onPoll" },
  },
  {
    path: "apps/plugin-dev/src/core/mutation-publish.ts",
    fn: "awaitMutantSettled",
    subject: "one diff-scoped mutant's suite run settling — killed or survived",
    deadline:
      "the publish's SHARED `dev.review.mutation.budget_ms` wall (default 120s), never a per-mutant one, so a slow first mutant cannot buy the run more clock",
    escalation:
      "cancels the in-flight run and ends the whole check as `budget-exhausted`: an ADVISORY note in the Countersign row and exit 0, because a truncated score is not the score of the change (#4140)",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "apps/plugin-dev/src/core/operational-probes/fleet-truth.ts",
    fn: "terminateSupervisorPid",
    subject: "the supervisor pid leaving the process table after SIGTERM",
    deadline: "`timeoutMs`, default 5s at 50ms polls",
    escalation: "returns the pid's final liveness; the probe reports the termination as unapplied",
    heartbeat: {
      silent: "a five-second same-host pid drain inside a probe whose return value is the verdict",
    },
  },
  {
    path: "apps/plugin-dev/src/runtime/gh/candidates.ts",
    fn: "readTargetIssue",
    subject: "a just-created, explicitly targeted GitHub issue becoming readable",
    deadline: "4 point reads across 2.5s (250ms + 750ms + 1.5s)",
    escalation: "returns the final 404 so the caller excludes the unreadable target instead of polling forever",
    heartbeat: {
      silent: "a bounded 2.5s read-after-write bridge whose returned candidate result is the report",
    },
  },
  {
    path: "apps/plugin-dev/src/runtime/exec.ts",
    fn: "terminateProcessGroup",
    subject: "the process group leaving the process table after SIGTERM, then after SIGKILL",
    deadline: "`PROCESS_GROUP_GRACE_TRIES` then `PROCESS_GROUP_KILL_TRIES`, at `PROCESS_GROUP_POLL_MS`",
    escalation: "returns false — the group survived, and the caller must not tear down what it still holds",
    heartbeat: { silent: "a sub-second drain bounded by two fixed try counts; the boolean IS the report" },
  },
  {
    path: "apps/plugin-dev/src/runtime/exec.ts",
    fn: "monitorCpuStall",
    subject: "the validation process group consuming CPU after its normal wall-time envelope",
    deadline:
      "one `sampleIntervalMs` window after `minWallTimeMs`; production defaults to 30 seconds after 20 minutes",
    escalation:
      "terminates the process group and returns typed `stall` infrastructure evidence to the validation sidecar",
    heartbeat: {
      silent:
        "the enclosing gate-child wait already publishes the pid and subject; this sampler publishes its terminal stall evidence through that same sink",
    },
  },
  {
    path: "apps/plugin-dev/src/runtime/gh/quota.ts",
    fn: "withGhQuotaBackoff",
    subject: "the GitHub rate-limit window reopening",
    deadline: "`capMs`, default 30 minutes",
    escalation:
      "returns the last rate-limited result unchanged, so the caller parks with an explicit quota reason instead of looping forever",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "packages/shared/kill-tree.ts",
    fn: "killTreeAndWait",
    subject: "the worker process tree dying — after SIGTERM, then SIGKILL, then a group SIGKILL",
    deadline: "`graceTries` (20) then `killTries` (10) twice, at `pollMs` (100) — about 4 seconds",
    escalation:
      "returns false; the caller must NOT tear down the worktree an uninterruptible-sleep worker still sits in",
    heartbeat: { silent: "a seconds-long drain whose boolean return is the report" },
  },
  {
    path: "apps/redskilled/src/acp-control-plane.ts",
    fn: "servePublicConnection",
    subject: "a cancelled, client-less prompt turn ending on its own after the upstream connection closed",
    deadline: "DETACHED_TURN_GRACE_MS (120 seconds) after the cancel is sent",
    escalation: "reapWorkflowWorker with `detached-turn-deadline`, returning the host slot other projects were refused against",
    heartbeat: { silent: "one unref'd grace timer per detached busy session; the reap itself is the report" },
  },
  {
    path: "apps/redskilled/src/acp-workflow-turn.ts",
    fn: "runAcpWorkflowTurn",
    subject: "the targeted Worker's admission becoming observable before its first prompt is forwarded",
    deadline: "one fixed 25ms event-loop turn after targeted admission or replacement",
    escalation: "forwards the exact journaled prompt to the admitted Worker",
    heartbeat: { silent: "a single 25ms pre-work window; the surrounding ACP lifecycle events are the report" },
  },
  {
    path: "apps/redskilled/src/acp-workflow-turn.ts",
    fn: "waitForWorkerDeparture",
    subject: "the dead targeted Worker leaving the daemon's live admission set before its replacement is born",
    deadline: "2 seconds at 10ms local host-state probes",
    escalation: "returns to replacement admission; a still-held Worker gets one terminal ACP refusal without another retry",
    heartbeat: { silent: "a two-second host drain followed immediately by replacement or bounded refusal" },
  },
  {
    path: "packages/protocol-acp/transport.ts",
    fn: "connectWithDeadline",
    subject: "the daemon ACP socket or assigned native Worker ACP socket accepting a local connection",
    deadline: "the caller's `timeoutMs`, 10 seconds for both public and Worker rendezvous",
    escalation: "throws a bounded endpoint-specific connection error; no local Worker fallback is permitted",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names the endpoint boundary" },
  },
  {
    path: "apps/redskilled/src/client-rendezvous.ts",
    fn: "waitForSupervisedDaemon",
    subject: "the installed supervisor's daemon answering on its same-user client socket",
    deadline: "`readyTimeoutMs`, or the client's bounded default ready window",
    escalation: "throws that the installed unit did not expose a daemon inside the ready window",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names the socket" },
  },
  {
    path: "apps/redskilled/src/client.ts",
    fn: "waitOutTheLeaseHolder",
    subject: "the live daemon named by the existing lease beginning to answer its socket",
    deadline: "`readyTimeoutMs`, default `DEFAULT_REDSKILLED_READY_TIMEOUT_MS`",
    escalation:
      "re-probes the holder, then returns when it exited or throws `RedskilledDaemonHeldError` without spawning a rival",
    heartbeat: { silent: "a 25ms local socket rendezvous whose typed terminal result is the report" },
  },
  {
    path: "apps/redskilled/src/daemon-termination.ts",
    fn: "<module>",
    subject: "the stopping daemon releasing its socket, lease and external pid",
    deadline: "the caller's `settleTimeoutMs`, default 5 seconds",
    escalation: "returns `complete: false` with the deadline and every anchor still pending",
    heartbeat: { silent: "a five-second local teardown drain whose returned pending list is the report" },
  },
  {
    path: "apps/redskilled/src/daemon-birth.ts",
    fn: "waitForDaemon",
    subject: "the daemon this provisioning run spawned answering its socket",
    deadline: "`readyTimeoutMs`, default `DEFAULT_REDSKILLED_READY_TIMEOUT_MS`",
    escalation: "throws the spawn failure, or the daemon's missed ready window naming the entry that ran",
    heartbeat: { silent: "a 25ms local socket rendezvous whose terminal throw names what did not start" },
  },
  {
    path: "apps/redskilled/src/project-hook.ts",
    fn: "waitForSyncHook",
    subject: "the admitted project hook process reaching a terminal Worker event",
    deadline: "the registering project's mandatory finite, positive `deadline_ms`",
    escalation:
      "records the expiry on the host event lane, stops waiting, and proceeds with Worker birth for every project",
    heartbeat: {
      silent:
        "the wait is per admitted hook, polls at most every 10ms, and its terminal expiry is the durable lane record",
    },
  },
  {
    path: "packages/worker/src/Orchestrator.ts",
    fn: "startWarningInterval",
    subject: "the agent's idle minutes while no output arrives",
    deadline:
      "unbounded — this fiber IS the heartbeat, and the sibling idle timer owns the deadline it reports against",
    escalation:
      "the idle timer fails the run with `AgentIdleTimeoutError`; this fiber is interrupted the moment output resumes",
    heartbeat: { sink: "onIdleWarning" },
  },
  {
    path: "packages/worker/src/engine/land-lock.ts",
    fn: "acquire",
    subject: "the contended land or gate lock, named with its path, its holder and how long it has held",
    deadline: "`waitTimeoutMs`, default 15 minutes",
    escalation: "returns null; the caller parks rather than landing unserialized",
    heartbeat: { sink: "onWait" },
  },
  {
    path: "packages/worker/src/engine/tracker/claim-verification.ts",
    fn: "listVerifiedClaims",
    subject: "our own claim marker becoming visible in the issue's comments",
    deadline: "`verifyAttempts` × `verifyDelayMs`, default 1s apart",
    escalation:
      "throws `ClaimVerificationError` rather than returning a list without our marker — that ambiguity is what made a sole claimant concede its own issue (#2385)",
    heartbeat: { silent: "a few one-second reads inside one claim acquisition; the throw names what never appeared" },
  },
  {
    path: "packages/worker/src/sandboxes/no-sandbox.ts",
    fn: "terminateProcessGroup",
    subject: "the sandboxed process group leaving the process table after SIGTERM, then after SIGKILL",
    deadline: "`PROCESS_GROUP_GRACE_TRIES` then `PROCESS_GROUP_KILL_TRIES`, at `PROCESS_GROUP_POLL_MS`",
    escalation: "returns false — the group survived its own SIGKILL and the caller must treat the sandbox as live",
    heartbeat: { silent: "a sub-second drain bounded by two fixed try counts; the boolean IS the report" },
  },
];
