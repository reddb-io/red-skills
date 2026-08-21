// acp-body-control-cut — ADR 0148's one rule, declared so both sides are checkable.
//
//   WHAT RUNS INSIDE THE WORKER IS THE BODY, and lives in `@reddb-io/worker`.
//   WHETHER, WHEN AND WHERE A WORKER EXISTS IS THE CONTROL PLANE, and stays
//   behind `redskilled`.
//
// The rule reads as obvious and drifts anyway, because the two halves meet in
// the middle of single files. `acp-native-worker.ts` held both: the function
// that DECIDED a Worker should exist and the function the resulting process
// RAN, one after the other, importing each other's neighbours. Nothing in a
// type checker can tell those apart — both compile, both pass their tests, and
// the seam is invisible until someone reaches across it.
//
// So the cut is DATA, checked in both directions by
// `apps/redskilled/tests/acp-body-control-cut.test.ts`:
//
//   1. A body module the daemon still holds FAILS — by its old name coming
//      back under `apps/redskilled/src/`, or by any daemon module DEFINING a
//      symbol the body owns. Re-exporting one is fine and deliberate: the
//      daemon's `acp-worker` entry is still the daemon's entry, it just loads
//      the body from the package.
//   2. A control-plane surface the package reaches for FAILS. Admission,
//      budget authority, placement, the session journal and the GitHub gateway
//      are the five the Worker most plausibly wants and may never have,
//      because each is an answer about OTHER Workers or about credentials the
//      Worker is not trusted with.
//   3. An UNDECLARED module under `packages/worker/src/acp/` FAILS, so the
//      inventory cannot quietly stop being one.
//
// Names are pinned by IDENTIFIER, never by the word. A Worker running out of
// budget checkpoints itself in `budget-grace.ts`, and that is body: the daemon
// decided the verdict, set the deadline and performs the kill.

/** One module that runs inside the Worker process. */
export interface WorkerBodyModule {
  /** Path under `packages/worker/src/acp/`. */
  readonly module: string;
  /**
   * The name it carried under `apps/redskilled/src/` before ADR 0148.
   *
   * A ratchet, not history: this exact name reappearing in the daemon tree is
   * the most likely shape of the move being undone.
   *
   * Absent when the module was BORN in the package. A body module written after
   * the cut has no daemon name to forbid, and inventing one would put a fictional
   * path in a ratchet whose whole value is that every path in it is real.
   */
  readonly formerDaemonModule?: string;
  /** Symbols this module DEFINES. The daemon may re-export them, never define them. */
  readonly defines: readonly string[];
  /** What it does once the process is already running. */
  readonly runs: string;
}

export const WORKER_BODY_MODULES: readonly WorkerBodyModule[] = [
  {
    module: "command.ts",
    formerDaemonModule: "acp-worker-command.ts",
    defines: ["runAcpWorkerCommand"],
    runs: "parses the daemon-chosen argv the `acp-worker` re-exec was handed",
  },
  {
    module: "native-worker.ts",
    formerDaemonModule: "acp-native-worker.ts",
    defines: ["runNativeAcpWorker"],
    runs: "serves the Worker's own ACP agent surface for the length of the process",
  },
  {
    module: "child-agent.ts",
    formerDaemonModule: "acp-child-agent.ts",
    defines: ["WorkflowChildAgent"],
    runs: "spawns, prompts, steers and reaps the one governed child coding Agent",
  },
  {
    module: "child-reaper.ts",
    defines: ["reapChildProcessTree", "installChildAgentReaper"],
    runs: "owns the lifetime of every child Agent process the body spawned — signals the process GROUP on teardown and again at the process edge, so no coding Agent outlives its Worker (#4241)",
  },
  {
    module: "child-spin.ts",
    formerDaemonModule: "acp-child-spin.ts",
    defines: ["createChildAcpSpinEpisode"],
    runs: "judges Spin over the child's own updates, inside the turn that produced them",
  },
  {
    module: "budget-grace.ts",
    formerDaemonModule: "acp-worker-budget-grace.ts",
    defines: ["createAcpWorkerBudgetGraceRuntime"],
    runs: "cancels, checkpoints, asks the gateway to publish, writes the Envelope, dies",
  },
  {
    module: "terminal-policy.ts",
    defines: ["evaluateWorkerTerminalRequest"],
    runs: "decides one child-agent terminal request: `git push`, `gh` and every credentialed remote are refused with the authority that owns them",
  },
  {
    module: "terminal-host.ts",
    defines: ["createWorkerTerminalHost"],
    runs: "runs what the policy allowed, in the Worktree, with the Worker's credential-free environment",
  },
  {
    module: "publish-request.ts",
    defines: ["createWorkerPublisher"],
    runs: "reads the branch and commit the turn produced and asks the ACP parent to publish them, once",
  },
  {
    module: "ticket-loop.ts",
    defines: ["runTicketLoop"],
    runs: "drives one Ticket from claim to land inside the turn: claim, implement, gate, re-seed in place, publish, land",
  },
  {
    module: "gate-lock.ts",
    defines: ["acquireHostGateLock"],
    runs: "holds the host-wide slot that keeps two Workers from running Validation at the same time (#4161)",
  },
  {
    module: "local-gate.ts",
    defines: ["runWorkerLocalGate"],
    runs: "runs the declared gate stages in the Worker's own Worktree, so the re-seed decision is made where the diff is",
  },
];

/**
 * A module the "Worker" in its name would move, and the cut keeps.
 *
 * ADR 0148 enumerates seven Worker-side `acp-*` modules and then states the
 * rule that decides them: whatever decides WHETHER, WHEN AND WHERE a Worker
 * exists stays in the daemon. Two of the seven are named for the Worker and
 * are, by that rule, control: they run in the DAEMON process, holding the
 * daemon's map of live Workers, admitting one when a turn needs it, replacing
 * a dead one and reaping an idle one. Moving them would have put admission and
 * reaping inside the package this cut exists to keep them out of — and issue
 * #4015 refuses exactly that in its second acceptance criterion.
 *
 * Declared rather than silently skipped, because a reader who counts five
 * moved modules against the ADR's seven deserves the answer here, at the point
 * they would go looking for it.
 */
export interface ControlPlaneDespiteTheName {
  /** Path under `apps/redskilled/src/`. */
  readonly module: string;
  /** Symbols proving it is the daemon's side of the socket, not the Worker's. */
  readonly defines: readonly string[];
  /** Why the name misleads. */
  readonly why: string;
}

export const CONTROL_PLANE_DESPITE_THE_NAME: readonly ControlPlaneDespiteTheName[] = [
  {
    module: "acp-worker-lifecycle.ts",
    defines: ["scheduleIdleCleanup", "reapWorkflowWorker", "cleanupWorkflowWorker"],
    why: "it is the daemon's handle on a live Worker — its socket, its idle timer and its reaping",
  },
  {
    module: "acp-workflow-turn.ts",
    defines: ["runAcpWorkflowTurn"],
    why: "it admits, replaces and reaps across one public turn; a Worker cannot decide its own succession",
  },
];

/** A control-plane authority the Worker body may never hold. */
export interface ControlPlaneSurface {
  readonly surface: "admission" | "budget" | "placement" | "journal" | "gateway";
  /** Repo-relative modules that own it. Each must exist under the daemon. */
  readonly modules: readonly string[];
  /** Symbols no module in `packages/worker` may define. */
  readonly defines: readonly string[];
  /** Why a Worker cannot be trusted with it. */
  readonly why: string;
}

export const CONTROL_PLANE_SURFACES: readonly ControlPlaneSurface[] = [
  {
    surface: "admission",
    modules: [
      "apps/redskilled/src/acp-worker-admission.ts",
      "apps/redskilled/src/acp-go-admission.ts",
    ],
    defines: ["admitNativeAcpWorker", "createGoWorkerAdmission"],
    why: "a Worker that could admit a Worker is a Worker that outlives its own reaping",
  },
  {
    surface: "budget",
    modules: [
      "apps/redskilled/src/acp-budget.ts",
      "apps/redskilled/src/budget-accounting.ts",
      "apps/redskilled/src/daemon/budget-grace.ts",
    ],
    defines: [
      "budgetMethodDomain",
      "buildBudgetAccounting",
      "createBudgetGraceRuntime",
      "signalWorkerForBudgetGrace",
    ],
    why: "the verdict, the deadline and the kill answer for the host, not for the process being killed",
  },
  {
    surface: "placement",
    modules: ["apps/redskilled/src/worker-placement.ts"],
    defines: ["planWorkerPlacement", "selectWorkerPlacementDriver"],
    why: "where a Worker runs is a host resource decision the Worker is downstream of",
  },
  {
    surface: "journal",
    modules: ["apps/redskilled/src/acp-session-journal.ts"],
    defines: ["createAcpSessionJournal", "acpSessionJournalPath"],
    why: "durable public session evidence must survive the Worker that produced it",
  },
  {
    surface: "gateway",
    modules: ["apps/redskilled/src/github-gateway.ts", "apps/redskilled/src/github-write.ts"],
    defines: ["createRedskilledGithubGateway", "createRedskilledGithubUpstream"],
    why: "no GitHub credential crosses the seam; a Worker asks, the daemon writes",
  },
];

/** Strip comments before matching — prose describing the cut is not the cut. */
export function stripSourceComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * True when `source` DEFINES `name`, as opposed to re-exporting it.
 *
 * The distinction is the whole point: `acp-control-plane.ts` re-exports
 * `runNativeAcpWorker` so the daemon's entry keeps its shape, and that is the
 * move working rather than the move failing.
 */
export function definesSymbol(source: string, name: string): boolean {
  const declaration = new RegExp(
    String.raw`(?:^|[\n;{])\s*(?:export\s+)?(?:declare\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+${name}\b`,
  );
  return declaration.test(stripSourceComments(source));
}
