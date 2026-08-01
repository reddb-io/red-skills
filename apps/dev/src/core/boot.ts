// boot — the AFK boot-time sequence, ported from afk.sh's top-level startup
// (lines ~3344-3395: precheck → bootstrap → prune_orphans → cap_issue_attempts
// → prune_completed_remote_live_branches → prune_completed_local_branches →
// sweep_unblocked → straggler_check), plus the
// SKILL.md "Bootstrap / Hard Preconditions / Orphan Cleanup / Attempt Cap /
// Branch Cleanup / Unblock Sweep / Straggler Check" sections.
//
// This module is PURE SEQUENCING. It owns only the ORDER of the boot steps and
// the compose-decider-then-apply pattern: every step composes one of the already
// ported pure deciders (reclaim.ts / branch-cleanup.ts / boot-sweep.ts) and then
// applies the plan's side effects through injected gh/fs/git IO. No real gh, git,
// or fs call lives here — the deciders perform no IO, and `runBoot` performs IO
// only through the injected `deps`.

import { join, relative } from "node:path";
import {
  recordIssueHeal,
  type HealLedgerStore,
} from "@reddb-io/red-castle/engine";
import {
  DEFAULT_ATTEMPT_KEEP,
  DEFAULT_ATTEMPT_TTL_S,
  decideOrphanFate,
  planAttemptCap,
  type AttemptDir,
  type IssueOpenState,
} from "./reclaim.js";
import {
  planLiveBranchCleanup,
  planLocalBranchCleanup,
  branchesToReap,
  type BranchRef,
  type IssueLookup,
} from "./branch-cleanup.js";
import {
  planBranchReclaim,
  type BranchReclaimVerdict,
} from "./branch-reclaim.js";
import {
  executeMixedBlockedNormalize,
  executeUnblockSweep,
  planReconcileSweep,
  stragglerCounts,
  shouldWarnStragglers,
  type BlockerStateLookup,
  type MixedBlockedCandidate,
  type StragglerCountLookup,
  type StragglerCounts,
  type UnblockCandidate,
  type ReconcileSweepCandidate,
  type ReconcileSweepPlan,
} from "./boot-sweep.js";
import {
  planStaleClaimSweep,
  renderConcededClaimSweepAudit,
  renderDeadClaimSweepAudit,
  renderStaleClaimSweepAudit,
  resolveClaimReaperConfig,
  type ClaimedIssue,
} from "./claim-staleness.js";
import { renderConcedeOnBehalf } from "./claim.js";
import {
  planDocsSweep,
  renderDocsSweepFileList,
  type DocsSweepInput,
  type DocsSweepPlan,
} from "./docs-sweep.js";
import {
  executeSpecSubIssueReconcile,
  type SpecSubIssueCandidate,
} from "./spec-subissue-reconciler.js";
import {
  applyClaimHygieneFix,
  appendLabelBodyCoherenceQuarantineDiagnosis,
  autoHealableClaimHygiene,
  BASE_FRESHNESS_PROBE_ID,
  CLAIM_HYGIENE_PROBE_ID,
  FLEET_TRUTH_PROBE_ID,
  formatOperationalProbeFinding,
  LABEL_BODY_COHERENCE_PROBE_ID,
  QUEUE_VISIBILITY_PROBE_ID,
  runOperationalProbes,
  type BaseFreshnessProbeData,
  type FleetTruthProbeData,
  type LabelBodyCoherenceAction,
  type LabelBodyCoherenceProbeData,
  type OperationalProbeContext,
  type OperationalProbeReport,
  type QueueVisibilityProbeData,
} from "./operational-probes.js";
import { runHostPrerequisiteProbe } from "./operational-probes/host-prerequisites.js";
import { pathIsInsideTmp, removableUnknownTmpRoots } from "./tmp-janitor.js";
import type { TmpJanitorPlan, WorkerDirJanitorPlan } from "./tmp-janitor.js";
import type { WorkerProcessVerdict, WorkerReclaimPlan } from "./worker-reclaim.js";
import type { WorkerStateRecordReclaimPlan } from "./worker-state-reclaim.js";
import { LABEL_HUMAN, LABEL_QUARANTINE, LABEL_READY, LABEL_RUNNING } from "./triage-labels.js";
import { readHitlTypeLabels } from "./config.js";
import { isRefused, planTransition, type StateTransition } from "./state-transition.js";

// ---------- precheck (hard preconditions) ----------

/** The hard preconditions the precheck enforces, in afk.sh order. A failure
 * names exactly which precondition tripped so the caller can `die` with a
 * faithful message. Mirrors precheck()'s `die` ladder. */
export type Precondition =
  | "gh-missing"
  | "gh-unauthenticated"
  | "not-a-git-repo"
  | "no-main-branch"
  | "not-on-trunk"
  | "pnpm-missing";

export type FocalBranchSource = "lock" | "pin" | "trunk";

export interface BranchPreconditionDetail {
  current: string;
  expected: string;
  source: FocalBranchSource;
}

/** Facts the precheck consumes. The caller resolves each via real IO (command
 * lookups, `gh auth status`, `git remote -v`, `git branch --show-current`) and
 * injects them so the precheck stays a pure rule over inputs. */
export interface PrecheckFacts {
  ghInstalled: boolean;
  ghAuthenticated: boolean;
  isGitRepo: boolean;
  /** Every remote URL from `git remote -v` (deduped is fine; names enable fixes). */
  remoteUrls: OperationalProbeContext["remoteUrls"];
  hasMainBranch: boolean;
  /** `git branch --show-current` in the primary checkout. */
  currentBranch: string;
  /**
   * The currently locked branch from `.red/tmp/branch-lock.yaml`, or
   * `undefined` when the session is unlocked. When set, the precheck gates on
   * `currentBranch === lockedBranch` rather than the configured trunk, so a
   * locked checkout is on the lock branch, not the trunk.
   */
  lockedBranch?: string;
  /**
   * The configured AFK boot branch resolved by the caller from repo config:
   * static branch pin first, then trunk/default. Kept injected so precheck
   * stays a pure rule over facts.
   */
  configuredTrunk?: string;
  /** Where `configuredTrunk` came from when no runtime lock overrides it. */
  configuredTrunkSource?: Exclude<FocalBranchSource, "lock">;
  pnpmInstalled: boolean;
  /**
   * Relax the SSH-only remote rule. "Reject https remote" is a LOCAL-dev safety
   * net (don't drive autonomous runs through a token-in-URL https remote). In a
   * CI lane (GitHub Actions: `RED_AFK_LANE=actions` / `GITHUB_ACTIONS`),
   * `actions/checkout` configures an https remote whose auth is the ephemeral
   * `GITHUB_TOKEN` — exactly the intended setup — so the rule must NOT fire there.
   * Set by the runtime facts-builder from the environment.
   */
  allowHttpsRemote?: boolean;
  /** Optional boot-time queue probe; injected by runtime facts so boot refuses on an unlistable AFK queue. */
  queueVisibility?: OperationalProbeContext["queueVisibility"];
  /** Optional boot-time focal-branch probe, sharing the same lock/pin/trunk resolver as the precheck. */
  focalBranch?: OperationalProbeContext["focalBranch"];
  /** Optional config namespacing probe facts for red-doctor and boot visibility. */
  configNamespacing?: OperationalProbeContext["configNamespacing"];
  /** Optional config coherence probe facts for red-doctor and boot visibility. */
  configCoherence?: OperationalProbeContext["configCoherence"];
  /** Optional fleet truth probe facts for red-doctor and boot visibility. */
  fleetTruth?: OperationalProbeContext["fleetTruth"];
  /** Optional bundle pointer/cache/npm coherence facts for red-doctor. */
  bundleCoherence?: OperationalProbeContext["bundleCoherence"];
  /** Optional claim hygiene probe facts for red-doctor and boot visibility. */
  claimHygiene?: OperationalProbeContext["claimHygiene"];
  /** Optional ready-label/body-blocker coherence probe facts for red-doctor and boot visibility. */
  labelBodyCoherence?: OperationalProbeContext["labelBodyCoherence"];
  /** Optional local trunk freshness probe facts for red-doctor and boot visibility. */
  baseFreshness?: OperationalProbeContext["baseFreshness"];
  /** Required command availability and Bash version facts for the earliest boot probe. */
  hostPrerequisites?: OperationalProbeContext["hostPrerequisites"];
}

/** A pass/fail precheck verdict. On failure, `failed` names the precondition and
 * `detail` carries the current branch, expected branch, and expectation source.
 * pnpm-missing is a WARNING in afk.sh (`log "warn: …"`), not a `die`; it is
 * surfaced via `warnings` while the verdict still passes. */
export type PrecheckResult =
  | { ok: true; warnings: string[] }
  | { ok: false; failed: Exclude<Precondition, "not-on-trunk"> }
  | { ok: false; failed: "not-on-trunk"; detail: BranchPreconditionDetail };

/** Evaluate the hard preconditions in afk.sh order. The `die` ladder is:
 *   gh installed → gh authenticated → is-git-repo → no https remote →
 *   local main exists → on the resolved focal branch. pnpm is the lone soft
 *   check (warn, not die), evaluated last so a clean pass still reports the
 *   warning. */
export function precheck(facts: PrecheckFacts): PrecheckResult {
  if (!facts.ghInstalled) return { ok: false, failed: "gh-missing" };
  if (!facts.ghAuthenticated) return { ok: false, failed: "gh-unauthenticated" };
  if (!facts.isGitRepo) return { ok: false, failed: "not-a-git-repo" };
  if (!facts.hasMainBranch) return { ok: false, failed: "no-main-branch" };
  const expectedBranch = facts.lockedBranch ?? facts.configuredTrunk ?? "main";
  if (facts.currentBranch !== expectedBranch) {
    const source: FocalBranchSource = facts.lockedBranch !== undefined
      ? "lock"
      : facts.configuredTrunkSource ?? "trunk";
    return {
      ok: false,
      failed: "not-on-trunk",
      detail: { current: facts.currentBranch, expected: expectedBranch, source },
    };
  }
  const warnings: string[] = [];
  if (!facts.pnpmInstalled) {
    warnings.push("pnpm not on PATH; feedback loops will be skipped");
  }
  return { ok: true, warnings };
}

export function formatPreconditionFailure(result: Extract<PrecheckResult, { ok: false }>): string {
  if (result.failed === "not-on-trunk") {
    const d = result.detail;
    return `${result.failed}: current=${d.current} expected=${d.expected} source=${d.source}`;
  }
  return result.failed;
}

// ---------- injected IO ----------

/** Filesystem side effects the boot sequence needs. All are best-effort in
 * afk.sh (`|| true`); the injected impl decides real semantics. */
export interface BootFs {
  /** mkdir -p */
  ensureDir(path: string): Promise<void>;
  /** Append a line to .gitignore iff not already present (grep -qxF guard). */
  ensureGitignoreLine(gitignorePath: string, line: string): Promise<void>;
  /** Write the per-worker `worker.pid` (printf '%s' $$ > worker.pid). */
  writeWorkerPid(pidFile: string, pid: number): Promise<void>;
  /** rm -rf an orphaned attempt dir. */
  removeDir(path: string): Promise<void>;
  /**
   * The DAEMON's verdict on the Worker that owns a dir, re-read immediately
   * before removal (Spec #2772 US 46): a Worker may have been born since the
   * plan was built. Only `dead` releases bytes — `unknown`, an unwired probe, or
   * a throwing one all spare the dir, because a reader that could not reach the
   * authority must never report a running Worker as gone (#2679).
   */
  workerLivenessVerdict?(workerDir: string): Promise<WorkerProcessVerdict>;
  /**
   * The same question about one WORKSPACE path, so the record-free reclaim pass
   * re-authorises each removal against a current answer.
   */
  workerWorkspaceLivenessVerdict?(path: string): Promise<WorkerProcessVerdict>;
  /**
   * The same question about the Worker a durable STATE RECORD names (#2978),
   * asked by worker id because the record's path carries no workspace. An
   * unwired or throwing probe spares the record, exactly like the two above.
   */
  workerStateRecordLivenessVerdict?(workerId: string): Promise<WorkerProcessVerdict>;
  /** Fresh owner-liveness verdict before removing a feedback worktree. */
  feedbackWorktreeLiveness?(
    path: string,
  ): Promise<"owner-live" | "owner-dead" | "no-live-workers">;
  /** Best-effort cleanup of dead empty worker.pid shells after orphan cleanup. */
  reapDeadEmptyWorkerShells?(tmpDir: string): Promise<unknown>;
  /** TERM -> grace -> KILL one orphan process group and confirm it is gone. */
  reapProcessGroup?(pgid: number): Promise<boolean>;
}

export interface OrphanTestRunnerSweepEntry {
  pid: number;
  ppid: number;
  pgid: number;
  sid: number;
  ageS: number;
  cwd: string;
  command: string;
}

/** gh side effects: label edits and audit/recovery comments. Best-effort. */
export interface BootGh {
  /** gh issue edit --remove-label … --add-label … */
  editLabels(issue: number, remove: string[], add: string[]): Promise<void>;
  /** gh issue comment --body … */
  comment(issue: number, body: string): Promise<void>;
  /** gh issue edit --body …; optional for legacy/minimal test adapters. */
  editBody?(issue: number, body: string): Promise<void>;
  /** gh issue view --json body; optional for legacy/minimal test adapters. */
  viewBody?(issue: number): Promise<string | undefined>;
  /** gh issue view --json labels → flat name list. */
  viewLabels(issue: number): Promise<string[]>;
  /** Create a native GitHub sub-issue edge from parent Spec to child Ticket. */
  attachSubIssue(parent: number, child: number): Promise<void>;
  /** Optional human-facing metadata lookup for rendered issue refs. */
  issueReference?(issue: number): Promise<{ number: number; title?: string; url?: string } | undefined>;
}

/** git side effects: delete a remote or local branch ref. Best-effort. The
 * scope (remote vs local) is carried by the planner that produced the ref. */
export interface BootGit {
  /** Delete an origin branch (git push origin --delete <branch>). */
  deleteRemoteBranch(branch: string): Promise<void>;
  /** Delete a local branch (git branch -D <branch>). */
  deleteLocalBranch(branch: string): Promise<void>;
  /** Drop git's registrations of worktrees whose bytes are gone (#2866).
   * Optional: a caller that does not wire it simply leaves the registry alone. */
  worktreePrune?(): Promise<void>;
}

/** Injected lookups the deciders need. Each mirrors a `gh issue view`/`gh issue
 * list` call in afk.sh, kept out of this module so it stays IO-free. */
export interface BootLookups {
  /** Orphan-cleanup per-dir lookup: issue state + decision label + envelope
   * flag. ghOk=false models a failed `gh issue view`. Mirrors the per-dir gh
   * read inside prune_orphans. */
  orphanState(issue: number): Promise<{
    ghOk: boolean;
    state: IssueOpenState;
    label: string | null;
    envelopePosted: boolean;
  }>;
  /** Branch-cleanup issue-state lookup (branch-cleanup.ts IssueLookup). */
  branchIssue: IssueLookup;
  /** Unblock-sweep blocker-state lookup (boot-sweep.ts BlockerStateLookup). */
  blockerState: BlockerStateLookup;
  /** Straggler per-bucket count lookups (boot-sweep.ts StragglerCountLookup). */
  straggler: StragglerCountLookup;
  /** True when the issue's local claim lock (`.red/tmp/claims/{N}/pid`) names a
   * LIVE process (#644). Optional: absent → false (restore behaviour
   * unchanged). The orphan sweep consults this before a restore-and-remove so
   * a claim-race loser's debris dir can never clobber the live winner's
   * `running` label back to ready-for-agent. */
  claimHolderAlive?: (issue: number) => Promise<boolean>;
  /** Cross-host stale-claim sweep input (#627): every currently-claimed issue
   * (projected `running`) with its parsed claim marker records. Optional: absent
   * → the sweep is a no-op (the same-host orphan sweep still covers local dead
   * workers). When present, `runBoot` releases any issue held only by a claim
   * whose owner stopped refreshing past the staleness window, cross-host. */
  claimedIssues?: () => Promise<ClaimedIssue[]>;
}

/** Outcome of one boot reconcile run — a coarser view of `ReconcileResult`
 * that only carries what the sweep needs to log and bucket. */
export type ReconcileBootOutcome = "landed" | "parked" | "skipped";

/** A runner the boot reconcile sweep invokes once per planned issue. Fully
 * owns the reconcile call — builds its own `ReconcileDeps` + `ReconcileInput`
 * from closed-over context. When absent, the reconcile sweep is a no-op. */
export type ReconcileBootRunner = (plan: ReconcileSweepPlan) => Promise<{ outcome: ReconcileBootOutcome }>;

export class BootHaltError extends Error {
  readonly plan?: DocsSweepPlan;
  readonly probe?: OperationalProbeReport["findings"][number];

  constructor(phase: "docs-sweep", plan: DocsSweepPlan);
  constructor(phase: "operational-probe", probe: OperationalProbeReport["findings"][number]);
  constructor(phase: "host-prereq", probe: OperationalProbeReport["findings"][number]);
  constructor(
    readonly phase: "docs-sweep" | "operational-probe" | "host-prereq",
    detail: DocsSweepPlan | OperationalProbeReport["findings"][number],
  ) {
    super(
      phase === "docs-sweep"
        ? `Docs Sweep halted (${(detail as DocsSweepPlan).haltReason ?? "unknown"}): ${renderDocsSweepFileList((detail as DocsSweepPlan).files)}`
        : `${phase === "host-prereq" ? "Host prerequisite probe red" : "Operational probe red"}: ${formatOperationalProbeFinding(
            detail as OperationalProbeReport["findings"][number],
          )}`,
    );
    this.name = "BootHaltError";
    if (phase === "docs-sweep") this.plan = detail as DocsSweepPlan;
    else this.probe = detail as OperationalProbeReport["findings"][number];
  }
}

export interface DocsSweepLandResult {
  ok: boolean;
  reason?: string;
}

export type DocsSweepLander = (plan: DocsSweepPlan) => Promise<DocsSweepLandResult>;

/** All injected IO + lookups for the boot run. */
export interface BootDeps {
  fs: BootFs;
  gh: BootGh;
  git: BootGit;
  lookups: BootLookups;
  /** Optional boot log sink; fleet supervisor passes its supervisor log writer. */
  log?: (line: string) => void;
  /** Guarded local trunk fast-forward used only for boot-auto-applied base freshness. */
  fastForwardLocalBase?: (request: {
    readonly remote: string;
    readonly target: string;
  }) => Promise<{
    readonly action: "fast-forward" | "noop";
    readonly evidence: string;
  }>;
  /** Posts an `afk:claim` concede comment. Wired so the boot sweep can
   * auto-heal dead own-machine dangling claims instead of halting (#2321). */
  concedeClaim?: (issue: number, body: string) => Promise<void>;
  /** Opaque local host identity stamped into audited concede-on-behalf markers.
   * Absent → the sweep releases labels without writing a withdrawal marker. */
  claimEvictor?: string;
  /** Durable castle-owned per-issue heal budget (ADR 0122 rule 6). */
  healLedger?: HealLedgerStore;
  /** Current epoch seconds (date +%s), injected so the run is deterministic. */
  nowS: number;
  /** Env for the cap/grace resolvers (defaults to process.env). */
  env?: Record<string, string | undefined>;
  /** Flat dev config values from `.red/config.yaml` (namespaced keys folded to accessors). */
  config?: Record<string, string | undefined>;
  /** When provided, the reconcile sweep (step 7) validates and lands each
   * owned parked-mechanical branch without re-running the agent. */
  reconcileRunner?: ReconcileBootRunner;
  /** Landing lane for the Docs Sweep. Absent is valid only when the plan is clean. */
  docsSweepLander?: DocsSweepLander;
}

function shortSha(sha: string | undefined): string {
  return sha ? sha.slice(0, 12) : "unknown";
}

async function tryBootAutoApplyBaseFreshness(
  deps: BootDeps,
  finding: OperationalProbeReport["findings"][number],
): Promise<boolean> {
  if (finding.id !== BASE_FRESHNESS_PROBE_ID) return false;
  const data = finding.data as Partial<BaseFreshnessProbeData> | undefined;
  if (
    data?.finding !== "local-trunk-behind-origin" ||
    data.guard?.guard !== "passed" ||
    !data.remote ||
    !data.trunk ||
    !deps.fastForwardLocalBase
  ) {
    return false;
  }

  const result = await deps.fastForwardLocalBase({ remote: data.remote, target: data.trunk });
  if (result.action !== "fast-forward") return false;

  deps.log?.(
    `boot operational probe auto-fix applied: ${finding.id} before=${shortSha(data.localSha)} after=${shortSha(data.remoteSha)}; ${result.evidence}`,
  );
  return true;
}

/**
 * Auto-heal a claim-hygiene red finding that is PURELY dead own-machine
 * danglers. A stranded `afk:claim` from this machine's own dead-pid worker is
 * provably safe to concede, so the boot sweep concedes it and continues instead
 * of throwing BootHaltError — one orphan claim must never halt every supervisor
 * boot (#2321). Foreign / unknown-pid markers are NOT healed here: they stay in
 * the red findings and still halt, because they need a human to adjudicate.
 */
async function tryBootAutoApplyClaimHygiene(
  deps: BootDeps,
  finding: OperationalProbeReport["findings"][number],
): Promise<{ handled: boolean; quarantined: number[] }> {
  if (finding.id !== CLAIM_HYGIENE_PROBE_ID) return { handled: false, quarantined: [] };
  const data = autoHealableClaimHygiene(finding);
  if (!data) {
    const raw = finding.data as {
      actions?: Array<{ issue?: unknown }>;
      foreign?: Array<{ issue?: unknown }>;
      unknown?: Array<{ issue?: unknown }>;
    } | undefined;
    const issueNumbers = [...new Set(
      [...(raw?.actions ?? []), ...(raw?.foreign ?? []), ...(raw?.unknown ?? [])]
        .map((entry) => Number(entry.issue))
        .filter((issue) => Number.isSafeInteger(issue) && issue > 0),
    )];
    for (const issue of issueNumbers) {
      await quarantineClaimIssue(
        deps,
        issue,
        "Claim ownership or liveness requires judgment; the fleet skipped this issue.",
      );
    }
    return { handled: true, quarantined: issueNumbers };
  }
  const concedeClaim = deps.concedeClaim;
  if (!concedeClaim) return { handled: false, quarantined: [] };

  const actions: ReadonlyArray<{ issue: number }> = data.actions;
  const issueNumbers = [...new Set(actions.map((action) => action.issue))];
  const quarantined: number[] = [];
  if (deps.healLedger) {
    for (const issue of issueNumbers) {
      const decision = await recordIssueHeal(deps.healLedger, issue, deps.nowS * 1000);
      if (decision.action !== "quarantine") continue;
      quarantined.push(issue);
      const history = decision.history.map((timestamp) => new Date(timestamp).toISOString()).join(", ");
      await quarantineClaimIssue(
        deps,
        issue,
        `Claim healer stopped after 3 heals within 24h. Heal history: ${history}`,
      );
    }
  }

  const quarantinedSet = new Set(quarantined);
  const healActions = data.actions.filter((action) => !quarantinedSet.has(action.issue));
  if (healActions.length > 0) {
    const scopedFinding = {
      ...finding,
      data: { ...data, actions: healActions },
    };
    try {
      const result = await applyClaimHygieneFix(scopedFinding, {
        confirm: async () => true,
        concedeClaim,
      });
      if (result.status === "applied") {
        deps.log?.(`boot operational probe auto-fix applied: ${finding.id}; ${result.evidence}`);
      }
    } catch (error) {
      deps.log?.(`boot claim-hygiene heal failed: ${String(error)}`);
    }
  }
  return { handled: true, quarantined };
}

async function quarantineClaimIssue(
  deps: BootDeps,
  issue: number,
  summary: string,
): Promise<void> {
  const marker = `<!-- afk:quarantine v1 issue=#${issue} -->`;
  try {
    const body = await deps.gh.viewBody?.(issue);
    if (body !== undefined && !body.includes(marker)) {
      const blocker = body.includes("<!-- red:blocker-state v1 -->")
        ? ""
        : [
            "## Current blocker",
            "",
            "<!-- red:blocker-state v1 -->",
            "status: blocked",
            "kind: claim-hygiene",
            `summary: ${summary}`,
            "next: Resolve the claim state, then clear this blocker for curator release.",
            "<!-- /red:blocker-state -->",
            "",
          ].join("\n");
      const diagnosis = [
        marker,
        "🤖 Claim-hygiene probe quarantined this issue instead of halting the fleet.",
        "",
        `**Diagnosis:** ${summary}`,
      ].join("\n");
      await deps.gh.editBody?.(
        issue,
        `${body.replace(/\s+$/, "")}\n\n${blocker}## Quarantine diagnosis\n\n${diagnosis}\n`,
      );
    }
  } catch (error) {
    deps.log?.(`boot claim-hygiene diagnosis failed for #${issue}: ${String(error)}`);
  }
  try {
    await applyBootStateTransition(deps, issue, { kind: "quarantine", diagnosis: "" }, [
      [LABEL_READY],
      [LABEL_QUARANTINE],
    ]);
  } catch (error) {
    deps.log?.(`boot claim-hygiene quarantine label failed for #${issue}: ${String(error)}`);
  }
}

/**
 * Route one boot-sweep state-label mutation through the ADR 0122 transition API
 * (#2528). Reads the issue's current labels, plans the atomic transition, and
 * applies it as ONE label edit — so a poison shape (state roles stacked, park
 * labels surviving a queue) is unconstructible from any boot path. A refused
 * plan is a poison signal: it is logged and NOT worked around with a raw edit.
 * `legacyEdit` ([remove, add]) is applied only when the label read itself fails,
 * preserving the pre-#2528 best-effort behavior for degraded trackers.
 */
async function applyBootStateTransition(
  deps: BootDeps,
  issue: number,
  transition: StateTransition,
  legacyEdit: [string[], string[]],
): Promise<void> {
  let labels: string[];
  try {
    labels = await deps.gh.viewLabels(issue);
  } catch {
    await deps.gh.editLabels(issue, legacyEdit[0], legacyEdit[1]);
    return;
  }
  const plan = planTransition(labels, transition);
  if (isRefused(plan)) {
    deps.log?.(`boot ${transition.kind} transition refused for #${issue}: ${plan.reason}`);
    return;
  }
  await deps.gh.editLabels(issue, [...plan.remove], [...plan.add]);
}

/**
 * Quarantine every incoherent issue found by the label/body coherence probe. An
 * issue is incoherent when it carries `ready-for-agent` while the body still has an
 * active `Current blocker`. Quarantine moves each such issue out of the executable
 * pool (ready-for-agent → quarantine) and appends the exact diagnosis to its body.
 * Every per-issue write is best-effort: a poisoned issue is returned in the local
 * exclusion set even when GitHub rejects one mutation, so the current drain skips
 * it while healthy siblings continue. A later curator sweep retries durable state.
 */
async function tryBootAutoApplyLabelBodyCoherence(
  deps: BootDeps,
  finding: OperationalProbeReport["findings"][number],
): Promise<{ handled: boolean; issues: number[] }> {
  if (finding.id !== LABEL_BODY_COHERENCE_PROBE_ID) return { handled: false, issues: [] };
  const data = finding.data as Partial<LabelBodyCoherenceProbeData> | undefined;
  if (!Array.isArray(data?.actions) || data.actions.length === 0) return { handled: false, issues: [] };

  const issues: number[] = [];
  for (const action of data.actions as readonly LabelBodyCoherenceAction[]) {
    issues.push(action.issue);
    try {
      await deps.gh.editBody?.(
        action.issue,
        appendLabelBodyCoherenceQuarantineDiagnosis(action),
      );
    } catch (error) {
      deps.log?.(`boot coherence probe body diagnosis failed for #${action.issue}: ${String(error)}`);
    }
    try {
      await applyBootStateTransition(deps, action.issue, { kind: "quarantine", diagnosis: "" }, [
        [LABEL_READY],
        [LABEL_QUARANTINE],
      ]);
      deps.log?.(
        `boot coherence probe quarantined #${action.issue}: ready-for-agent→quarantine; blocker kind=${action.blocker.kind} summary=${JSON.stringify(action.blocker.summary)}`,
      );
    } catch (error) {
      deps.log?.(`boot coherence probe label quarantine failed for #${action.issue}: ${String(error)}`);
    }
  }

  return { handled: true, issues };
}

/** True when this base-freshness finding is safe to downgrade for worker boot.
 * Worker sessions (skipSweeps) can skip the fatal halt for this case because they branch from
 * origin/main directly — a behind local main does not affect their work. */
function isWorkerExemptBaseFreshnessFinding(
  finding: OperationalProbeReport["findings"][number],
): boolean {
  if (finding.id !== BASE_FRESHNESS_PROBE_ID) return false;
  const data = finding.data as Partial<BaseFreshnessProbeData> | undefined;
  if (data?.finding !== "local-trunk-behind-origin") return false;
  if (data.guard?.guard === "passed") return true;
  return data.guard?.failedCondition === "clean-tree";
}

// ---------- step inputs ----------

/** Bootstrap paths, pre-resolved by the caller from worker-paths.ts so this
 * module never builds a path itself. */
export interface BootstrapInput {
  /** .red/tmp dir (mkdir -p). */
  tmpDir: string;
  /** .red/state dir (mkdir -p). */
  stateDir: string;
  /** Primary checkout .gitignore path. */
  gitignorePath: string;
  /** Per-worker dir (mkdir -p). */
  workerDir: string;
  /** Per-worker worker.pid path. */
  workerPidFile: string;
  /** This orchestrator's pid ($$). */
  workerPid: number;
}

/** One orphaned attempt dir the caller discovered (dead-worker attempt dir).
 * The caller has already stat'd the dir age and read the state file's issue
 * number / envelope flag; `issue` is null for a dir with no parseable issue
 * number (afk.sh's `-z issue_n` branch). */
export interface OrphanDir {
  path: string;
  /** Issue number from the state file, or null when there is no state file. */
  issue: number | null;
  /** Dir age in seconds (now - mtime). */
  ageS: number;
}

/** Attempt dirs grouped by issue for the cap pass (cap_issue_attempts walks
 * every worker, groups by issue, then caps each group). */
export interface AttemptCapInput {
  byIssue: ReadonlyMap<number, readonly AttemptDir[]>;
}

/** Branch refs for the live branch-cleanup reapers, pre-listed by the caller
 * (ls-remote / git branch). Local refs already exclude checked-out branches. */
export interface BranchCleanupInput {
  remoteLiveRefs: readonly BranchRef[];
  localLiveRefs: readonly BranchRef[];
  /** Local branches the trunk already carries — the LANDED fact the reclaim
   * decides on (#2866). Absent leaves the reclaim on the tracker's weaker
   * verdict alone, which is the pre-#2866 behaviour. */
  landedLocalBranches?: readonly string[];
  /** The repo's configured trunk, so the reclaim can spare it by name. */
  trunk?: string;
}

/** A `.red/tmp/claims/<N>/` lock dir whose recorded pid the caller already
 * resolved as dead (or absent). The orphan step unconditionally reclaims these
 * — the liveness check happens at discovery, not here. Mirrors the stale
 * claim-lock sweep at the end of prune_orphans. */
export interface StaleClaimDir {
  /** Absolute path to the claim lock dir (`.red/tmp/claims/<N>`). */
  path: string;
  /** Issue number from the claim dir basename, when parseable. */
  issue?: number;
}

/** The full set of per-step inputs the caller resolves before `runBoot`. */
export interface BootOptions {
  precheck: PrecheckFacts;
  operationalProbes?: OperationalProbeContext;
  bootstrap: BootstrapInput;
  orphans: readonly OrphanDir[];
  attemptCap: AttemptCapInput;
  branches: BranchCleanupInput;
  unblockCandidates: readonly UnblockCandidate[];
  /** Pre-cutover flat `.red/tmp/work-NNN` relic dirs whose orchestrator is dead.
   * Unconditionally wiped (#252). The caller has already filtered to dead ones.
   * Optional for back-compat with callers that predate the drain-wipe. */
  legacyWorkDirs?: readonly string[];
  /** `.red/tmp/claims/<N>/` lock dirs whose recorded pid is dead. Reclaimed
   * unconditionally. Optional for back-compat. */
  staleClaimDirs?: readonly StaleClaimDir[];
  /** Open issues labelled `blocked:stalled` or `blocked:crashed` that the
   * reconcile sweep (step 7) will attempt to validate-and-land. When absent the
   * sweep is a no-op. Optional for back-compat. */
  reconcileSweepCandidates?: readonly ReconcileSweepCandidate[];
  /** Open issues found in the illegal MIXED-BLOCKED state (`ready-for-agent` or
   * `running` together with a `blocked:*` label) that the normalizer sweep (#1481)
   * will heal by shedding the stale `blocked:*` labels. When absent the sweep is a
   * no-op. Optional for back-compat. */
  mixedBlockedCandidates?: readonly MixedBlockedCandidate[];
  /** Dirty/ahead docs discovered by the runtime for the Docs Sweep. */
  docsSweep?: DocsSweepInput;
  /** Open and recently-closed Specs with their `spec:N` label-children and native
   * sub-issue children. The reconciler attaches missing native edges and strips a
   * stale `needs-slicing` label once at least one slice exists. */
  specSubIssueCandidates?: readonly SpecSubIssueCandidate[];
  /** ADR 0098 tmp janitor plan: expired named lanes, audited unknown root entries,
   * and stale worker dirs the DAEMON already called dead and whose represented
   * issues are closed. */
  tmpJanitor?: {
    plan: TmpJanitorPlan;
    staleWorkers: WorkerDirJanitorPlan;
    orphanTestRunners?: readonly OrphanTestRunnerSweepEntry[];
    /** The daemon-keyed reclaim plan (Spec #2772 US 46). Absent means the caller
     * had no daemon answer to plan against, so the sweep reclaims nothing on its
     * behalf. */
    workerReclaim?: WorkerReclaimPlan;
    /** The durable Worker STATE RECORD reclaim (#2978). Absent means the caller
     * planned none, so the sweep removes no record — the pile is left intact
     * rather than reclaimed on a plan nobody built. */
    workerStateRecords?: WorkerStateRecordReclaimPlan;
  };
  /**
   * Skip every shared boot sweep (#623). When true, `runBoot` runs precheck +
   * bootstrap only and returns before orphan cleanup / attempt cap / branch
   * cleanup / unblock sweep / reconcile sweep / straggler check. The fleet
   * supervisor sets this on each worker (via the `RED_AFK_SWEEPS_DONE` marker)
   * because it already ran the sweeps once, pre-spawn — so a supervised worker
   * boots bootstrap+claim only and never races peers over shared `.red/tmp`
   * state. A solo `run` (no marker) leaves this false and runs every sweep.
   */
  skipSweeps?: boolean;
}

// ---------- per-step results (for parity assertions / logging) ----------

export interface OrphanCleanupResult {
  removed: string[];
  restored: number[];
  /** Dirs kept (keep-until TTL not yet exceeded). */
  kept: string[];
  /** Pre-cutover `work-*` relic dirs wiped this run (#252). */
  legacyWiped: string[];
  /** Stale `claims/<N>` lock dirs reclaimed this run. */
  claimsReleased: string[];
}

export interface AttemptCapResult {
  reclaimed: string[];
}

export interface BranchCleanupResult {
  remoteLiveReaped: string[];
  localLiveReaped: string[];
  /** Local branches the reclaim deliberately KEPT, each with the reason (#2866).
   * Reported rather than dropped, because the spares — `red-trunk` above all —
   * are the half of this sweep that a silent pass gets catastrophically wrong. */
  localSpared?: BranchReclaimVerdict[];
}

export interface UnblockSweepResult {
  promoted: number[];
}

export interface MixedBlockedNormalizeResult {
  /** Issues healed out of the illegal mixed-blocked state (stale blocked:* shed). */
  healed: number[];
}

export interface SpecSubIssueReconcileBootResult {
  attached: Array<{ spec: number; child: number }>;
  needsSlicingRemoved: number[];
}

export interface StragglerResult {
  counts: StragglerCounts;
  warn: boolean;
}

export interface StaleClaimSweepResult {
  /** Issues released back to the executable pool because their cross-host owner
   * stopped refreshing past the staleness window. */
  released: number[];
  /** Released issues whose active claim markers had already ended in concede. */
  repairedConceded?: number[];
}

export interface ReconcileSweepResult {
  /** Issues successfully validated-green and landed without re-running the agent. */
  landed: number[];
  /** Issues re-parked with `blocked:validation` (gate failed or merge conflict). */
  parked: number[];
  /** Issues skipped (no owned branch, not mechanical, or reconcile guard rejected). */
  skipped: number[];
}

export interface DocsSweepResult {
  plan: DocsSweepPlan;
}

export interface TmpJanitorSweepResult {
  expiredLanes: string[];
  staleWorkers: string[];
  unknownTmpRoots: string[];
  protectedLiveWorkers: string[];
  protectedLiveFeedback: string[];
  orphanTestRunners: Array<{ pid: number; pgid: number }>;
  /** Workspaces removed because the daemon called their Worker gone. */
  workerWorkspaces: string[];
  /** Workspaces spared because the daemon did not call their Worker gone. */
  protectedLiveWorkspaces: string[];
  /** Worker state records removed: gone, settled, and past the retention (#2978). */
  workerStateRecords: string[];
  /** Worker state records spared because the daemon did not call their Worker gone. */
  protectedLiveWorkerStateRecords: string[];
  /** Paths a plan named outside this tmp tier: reported, never removed. */
  refusedOutsideTmp: string[];
  removals: Array<{
    path: string;
    livenessVerdict:
      | "not-worker-workspace"
      | "worker-dead"
      | "owner-dead"
      | "no-live-workers";
  }>;
}

/** The boot run outcome. On a precheck failure the sequence short-circuits and
 * only `precheck` is populated (the bash `die` aborts before any other step). */
export interface BootResult {
  precheck: PrecheckResult;
  operationalProbes?: OperationalProbeReport;
  /** Issue-local boot exclusions. The worker drain must skip these even when a
   * best-effort GitHub quarantine write failed during this boot. */
  quarantinedIssues?: readonly number[];
  bootstrap?: { ok: true };
  orphanCleanup?: OrphanCleanupResult;
  attemptCap?: AttemptCapResult;
  branchCleanup?: BranchCleanupResult;
  tmpJanitor?: TmpJanitorSweepResult;
  docsSweep?: DocsSweepResult;
  unblockSweep?: UnblockSweepResult;
  mixedBlockedNormalize?: MixedBlockedNormalizeResult;
  specSubIssueReconcile?: SpecSubIssueReconcileBootResult;
  staleClaimSweep?: StaleClaimSweepResult;
  reconcileSweep?: ReconcileSweepResult;
  straggler?: StragglerResult;
}

// ---------- the orchestration ----------

/**
 * Run the AFK boot sequence IN ORDER, composing each pure decider and applying
 * its plan through injected IO. The order is the parity target (afk.sh top-level
 * startup):
 *
 *   0. host prerequisites   — required commands + Bash baseline; failure halts.
 *   1. precheck             — hard preconditions; a failure aborts the run.
 *   2. bootstrap            — ensure .red/tmp + .red/state, gitignore lines,
 *                             per-worker dir + worker.pid (via fs).
 *   3. orphan cleanup       — decideOrphanFate per dead-worker attempt dir, then
 *                             apply remove / restore-and-remove / keep (gh + fs).
 *   4. attempt cap          — planAttemptCap per issue, remove the reclaimed dirs.
 *   5. branch cleanup       — planLiveBranchCleanup, planLocalBranchCleanup;
 *                             delete reaped refs (git).
 *   5a. tmp janitor         — reclaim expired ADR 0098 lanes, dead closed-issue
 *                             worker dirs, and audited unknown tmp-root entries.
 *   6. docs sweep           — planDocsSweep; land stranded .red docs or halt.
 *   7. unblock sweep        — planUnblockSweep; edit labels + audit comment (gh).
 *   7a. mixed-blocked normalizer — shed stale blocked:* from queued/active issues.
 *   7b. Spec sub-issue reconcile — attach missing native sub-issue edges and
 *                                  strip stale needs-slicing on sliced Specs.
 *   7c. stale-claim sweep   — planStaleClaimSweep; release each issue held only by
 *                             a cross-host claim that stopped refreshing (#627).
 *                             No-op when `claimedIssues` is absent.
 *   9. reconcile sweep      — planReconcileSweep; validate-and-land each owned
 *                             parked-mechanical branch without re-running the agent
 *                             (ADR 0055). No-op when reconcileRunner is absent.
 *   10. straggler check     — stragglerCounts + shouldWarnStragglers → warn flag.
 *
 * Steps 3-8 run only after a passing precheck, mirroring the bash `die`/`set -e`
 * abort. The TTY "proceed anyway?" prompt is the caller's: this returns the
 * straggler warn flag, it does not block.
 *
 * When `options.skipSweeps` is set (#623, a supervised worker carrying the
 * `RED_AFK_SWEEPS_DONE` marker) the sequence stops after step 2: the supervisor
 * already ran every shared sweep once, pre-spawn, so the worker boots
 * bootstrap+claim only and never races peers over `.red/tmp` / branch / gh state.
 */
export async function runBoot(deps: BootDeps, options: BootOptions): Promise<BootResult> {
  const hostPrerequisite = runHostPrerequisiteProbe(options.operationalProbes ?? options.precheck);
  if (hostPrerequisite.verdict === "red") throw new BootHaltError("host-prereq", hostPrerequisite);

  // ---- 1. precheck ----
  const pre = precheck(options.precheck);
  if (!pre.ok) return { precheck: pre };

  // ---- 1a. operational probes ----
  const operationalProbes = await runOperationalProbes(options.operationalProbes ?? options.precheck);
  const queueVisibility = operationalProbes.probes.find((probe) => probe.id === QUEUE_VISIBILITY_PROBE_ID);
  const queueVisibilityData = queueVisibility?.data as QueueVisibilityProbeData | undefined;
  if (queueVisibility?.verdict === "ok" && queueVisibilityData?.transient === true) {
    deps.log?.(queueVisibility.evidence);
  }
  // An unknown supervisor bundle version is inconclusive, not a fault: it never
  // reaches `findings`, so log it here or it would vanish entirely (#2752).
  const fleetTruth = operationalProbes.probes.find((probe) => probe.id === FLEET_TRUTH_PROBE_ID);
  const fleetTruthData = fleetTruth?.data as FleetTruthProbeData | undefined;
  if (fleetTruth?.verdict === "ok" && fleetTruthData?.notes?.includes("version-unknown")) {
    deps.log?.(`${fleetTruth.name}: ${fleetTruth.evidence}`);
  }
  // A dangling `afk:claim` from THIS machine's dead-pid worker is provably safe
  // to concede, so auto-heal such claim-hygiene findings here instead of letting
  // one stranded claim throw BootHaltError and kill every supervisor boot
  // (#2321). Foreign / unknown-pid markers survive the filter and still halt.
  const redFindings: OperationalProbeReport["findings"][number][] = [];
  const quarantinedIssues: number[] = [];
  for (const finding of operationalProbes.findings) {
    const claimHygiene = await tryBootAutoApplyClaimHygiene(deps, finding);
    if (claimHygiene.handled) {
      quarantinedIssues.push(...claimHygiene.quarantined);
      continue;
    }
    const quarantine = await tryBootAutoApplyLabelBodyCoherence(deps, finding);
    if (quarantine.handled) {
      quarantinedIssues.push(...quarantine.issues);
      continue;
    }
    redFindings.push(finding);
  }
  const redProbe = redFindings[0];
  if (redProbe) {
    const applied = await tryBootAutoApplyBaseFreshness(deps, redProbe);
    if (!applied) {
      // Worker sessions (skipSweeps) branch from origin/main, so local-main-behind-origin
      // does not affect their branch base. The guarded FF dep is absent on this path; when
      // the guard passes, or only refuses because the primary has uncommitted WIP, downgrade
      // to a non-fatal finding instead of halting the session.
      const workerSessionExempt = options.skipSweeps === true && isWorkerExemptBaseFreshnessFinding(redProbe);
      if (!workerSessionExempt) throw new BootHaltError("operational-probe", redProbe);
    }
    const nextRedProbe = redFindings[1];
    if (nextRedProbe) throw new BootHaltError("operational-probe", nextRedProbe);
  }

  // ---- 2. bootstrap ----
  const b = options.bootstrap;
  await deps.fs.ensureDir(b.tmpDir);
  await deps.fs.ensureDir(b.stateDir);
  await deps.fs.ensureGitignoreLine(b.gitignorePath, ".red/tmp/");
  await deps.fs.ensureGitignoreLine(b.gitignorePath, ".red/state/");
  await deps.fs.ensureDir(b.workerDir);
  await deps.fs.writeWorkerPid(b.workerPidFile, b.workerPid);

  // ---- 2a. supervisor-owned-sweeps short-circuit (#623) ----
  // Under the fleet supervisor the shared sweeps already ran once, pre-spawn.
  // A supervised worker boots bootstrap+claim only: return here so it touches no
  // shared `.red/tmp` / branch / gh state below (no orphan cleanup, attempt cap,
  // branch cleanup, unblock sweep, reconcile sweep, or straggler check). This is
  // what makes a respawn cheap and keeps peers from racing over boot state.
  if (options.skipSweeps) {
    return { precheck: pre, operationalProbes, quarantinedIssues, bootstrap: { ok: true } };
  }

  // ---- 3. orphan cleanup ----
  const orphanCleanup = await runOrphanCleanup(deps, options);

  // ---- 4. attempt cap ----
  const attemptCap = await runAttemptCap(deps, options.attemptCap);

  // ---- 5. snapshot grace + live/local branch cleanup ----
  const branchCleanup = await runBranchCleanup(deps, options.branches);

  // ---- 5a. ADR 0098 tmp janitor ----
  const tmpJanitor = await runTmpJanitorSweep(deps, options);

  // ---- 6. docs sweep ----
  const docsSweep = await runDocsSweep(deps, options);

  // ---- 7. unblock sweep ----
  const unblockSweep = await runUnblockSweep(deps, options.unblockCandidates);

  // ---- 7a. mixed-blocked normalizer (#1481) ----
  const mixedBlockedNormalize = await runMixedBlockedNormalize(deps, options);

  // ---- 7b. Spec sub-issue reconciler (#1739) ----
  const specSubIssueReconcile = await runSpecSubIssueReconcile(deps, options);

  // ---- 7c. cross-host stale-claim sweep (#627) ----
  const staleClaimSweep = await runStaleClaimSweep(deps);

  // ---- 9. reconcile sweep (ADR 0055) ----
  const reconcileSweep = await runReconcileSweep(deps, options, staleClaimSweep.released);

  // ---- 10. straggler check ----
  const straggler = await runStragglerCheck(deps);

  return {
    precheck: pre,
    operationalProbes,
    quarantinedIssues,
    bootstrap: { ok: true },
    orphanCleanup,
    attemptCap,
    branchCleanup,
    tmpJanitor,
    docsSweep,
    unblockSweep,
    mixedBlockedNormalize,
    specSubIssueReconcile,
    staleClaimSweep,
    reconcileSweep,
    straggler,
  };
}

async function runTmpJanitorSweep(
  deps: BootDeps,
  options: BootOptions,
): Promise<TmpJanitorSweepResult> {
  const sweep = options.tmpJanitor;
  const result: TmpJanitorSweepResult = {
    expiredLanes: [],
    staleWorkers: [],
    unknownTmpRoots: [],
    protectedLiveWorkers: [],
    protectedLiveFeedback: [],
    orphanTestRunners: [],
    workerWorkspaces: [],
    protectedLiveWorkspaces: [],
    workerStateRecords: [],
    protectedLiveWorkerStateRecords: [],
    refusedOutsideTmp: [],
    removals: [],
  };
  if (!sweep) return result;

  // The daemon-keyed pass runs FIRST and is the authority (Spec #2772 US 46): a
  // workspace goes because the daemon says the Worker that owns it is gone. The
  // passes below only ever narrow what it already decided.
  for (const verdict of sweep.workerReclaim?.reclaim ?? []) {
    // A reclaimable artifact with no path has no bytes here to remove.
    if (verdict.artifact.path === undefined) continue;
    const path = verdict.artifact.path;
    if (!pathIsInsideTmp(options.bootstrap.tmpDir, path)) {
      result.refusedOutsideTmp.push(path);
      continue;
    }
    // Fail CLOSED: an unanswerable — or unwired — liveness probe spares the
    // workspace. The opposite default deleted a live lane once already (#2679).
    const live = await deps.fs.workerWorkspaceLivenessVerdict?.(path).catch(() => "unknown" as const);
    if (live !== "dead") {
      result.protectedLiveWorkspaces.push(path);
      continue;
    }
    await deps.fs.removeDir(path);
    result.removals.push({ path, livenessVerdict: "worker-dead" });
    result.workerWorkspaces.push(path);
  }

  // The durable Worker STATE RECORD lane (#2978). It runs beside the workspace
  // pass because it answers to the same authority: the record of a Worker the
  // daemon calls gone, settled past its retention, is the pile every reader was
  // paying for. Fail CLOSED here too — an unwired or unanswerable probe keeps
  // the record.
  for (const verdict of sweep.workerStateRecords?.reclaim ?? []) {
    const live = await deps.fs.workerStateRecordLivenessVerdict?.(verdict.worker_id)
      .catch(() => "unknown" as const);
    if (live !== "dead") {
      result.protectedLiveWorkerStateRecords.push(verdict.path);
      continue;
    }
    await deps.fs.removeDir(verdict.path);
    result.removals.push({ path: verdict.path, livenessVerdict: "worker-dead" });
    result.workerStateRecords.push(verdict.path);
  }

  const expired = [
    ...sweep.plan.logs.reclaim,
    ...sweep.plan.scratch.reclaim,
    ...sweep.plan.diagnostics.reclaim,
    ...sweep.plan.feedbackWorktrees.reclaim,
    ...sweep.plan.legacySlotLogs.reclaim,
  ];
  const feedbackPaths = new Set(sweep.plan.feedbackWorktrees.reclaim.map((entry) => entry.path));
  // Counted apart from `expiredLanes`, which also holds logs and scratch: only a
  // removed WORKTREE leaves a git registration behind to prune (#2866).
  let removedFeedbackWorktrees = 0;
  for (const entry of expired) {
    if (feedbackPaths.has(entry.path)) {
      const verdict = await deps.fs.feedbackWorktreeLiveness?.(entry.path).catch(() => "owner-live" as const)
        ?? "owner-live";
      if (verdict === "owner-live") {
        result.protectedLiveFeedback.push(entry.path);
        continue;
      }
      await deps.fs.removeDir(entry.path);
      removedFeedbackWorktrees += 1;
      result.removals.push({ path: entry.path, livenessVerdict: verdict });
      result.expiredLanes.push(entry.path);
      continue;
    }
    await deps.fs.removeDir(entry.path);
    result.removals.push({ path: entry.path, livenessVerdict: "not-worker-workspace" });
    result.expiredLanes.push(entry.path);
  }

  for (const worker of sweep.staleWorkers.reclaim) {
    const live = await deps.fs.workerLivenessVerdict?.(worker.path).catch(() => "unknown" as const);
    if (live !== "dead") {
      result.protectedLiveWorkers.push(worker.path);
      continue;
    }
    await deps.fs.removeDir(worker.path);
    result.removals.push({ path: worker.path, livenessVerdict: "worker-dead" });
    result.staleWorkers.push(worker.path);
  }

  // A registered lane is never removable through the unknown-entry path, even
  // if the plan named one (issue #2679: a worker boot deleted the live
  // `supervisors` lane this way and blinded fleet_status).
  for (const name of removableUnknownTmpRoots(sweep.plan.unknownTmpRoots)) {
    const path = join(options.bootstrap.tmpDir, name);
    await deps.fs.removeDir(path);
    result.removals.push({ path, livenessVerdict: "not-worker-workspace" });
    result.unknownTmpRoots.push(path);
  }

  const reapedGroups = new Set<number>();
  for (const orphan of sweep.orphanTestRunners ?? []) {
    let reaped = reapedGroups.has(orphan.pgid);
    if (!reaped) {
      reaped = await deps.fs.reapProcessGroup?.(orphan.pgid).catch(() => false) ?? false;
      if (reaped) reapedGroups.add(orphan.pgid);
    }
    if (!reaped) continue;
    result.orphanTestRunners.push({ pid: orphan.pid, pgid: orphan.pgid });
    deps.log?.(
      `tmp-janitor reaped orphan test runner pid=${orphan.pid} pgid=${orphan.pgid} cwd=${relative(options.bootstrap.tmpDir, orphan.cwd)} command=${orphan.command}`,
    );
  }

  // Deleting a registered worktree's bytes leaves git still pointing at the
  // path, which blocks the next worktree created there (#2866). Every lane above
  // that can delete one is counted; prune once, at the end, for all of them.
  const removedWorktrees =
    result.workerWorkspaces.length + result.staleWorkers.length + removedFeedbackWorktrees;
  if (removedWorktrees > 0 && deps.git.worktreePrune) {
    await deps.git.worktreePrune().catch(() => {});
  }

  return result;
}

async function runDocsSweep(deps: BootDeps, options: BootOptions): Promise<DocsSweepResult> {
  const plan = planDocsSweep(options.docsSweep ?? { base: options.precheck.configuredTrunk ?? "main", files: [] });
  if (plan.action === "clean") return { plan };
  if (plan.action === "halt") throw new BootHaltError("docs-sweep", plan);
  if (!deps.docsSweepLander) {
    throw new BootHaltError("docs-sweep", { ...plan, action: "halt", haltReason: "landing-failed" });
  }
  let landed: DocsSweepLandResult;
  try {
    landed = await deps.docsSweepLander(plan);
  } catch {
    throw new BootHaltError("docs-sweep", { ...plan, action: "halt", haltReason: "landing-failed" });
  }
  if (!landed.ok) {
    throw new BootHaltError("docs-sweep", { ...plan, action: "halt", haltReason: "landing-failed" });
  }
  return { plan };
}

/** Step 6a: cross-host stale-claim sweep (#627). List the currently-claimed
 * issues + their claim markers, plan a release for any held ONLY by a claim
 * whose owner stopped refreshing past the staleness window, and apply it: strip
 * `running`, restore `ready-for-agent`, and post one audit comment. A no-op when
 * `claimedIssues` is not wired (the same-host orphan sweep still covers local
 * dead workers). A live-but-slow worker is never released — the planner only
 * releases an issue with no live claim. Sequenced AFTER the unblock sweep and
 * BEFORE the reconcile sweep so a freshly-released issue rejoins the executable
 * pool for the next drain. */
async function runStaleClaimSweep(deps: BootDeps): Promise<StaleClaimSweepResult> {
  if (!deps.lookups.claimedIssues) return { released: [] };
  let claimed: ClaimedIssue[];
  try {
    claimed = await deps.lookups.claimedIssues();
  } catch {
    // Best-effort: a failed listing skips the sweep this boot, never aborting it.
    return { released: [] };
  }
  const config = resolveClaimReaperConfig(deps.env ?? process.env, (key) => deps.config?.[key] ?? "");
  const plans = planStaleClaimSweep(claimed, deps.nowS, config);
  const released: number[] = [];
  const repairedConceded: number[] = [];
  for (const p of plans) {
    try {
      // Re-fetch current labels: the batched issueStates snapshot used by
      // claimedIssues may be stale by now (parallel edits or a preflight-blocker
      // concede between the batch and this sweep). Two cases warrant a guard:
      //
      //   1. running is gone (race): another sweep or recovery already released
      //      the issue — skip to avoid a spurious ready-for-agent add.
      //
      //   2. running + ready-for-human: a crash recovery wrote ready-for-human but
      //      left the running projection in place. Adding ready-for-agent here
      //      would re-admit the issue into the agent queue while the human gate is
      //      active, causing the preflight-blocker spin (#968). Remove running only.
      const currentLabels = await deps.gh.viewLabels(p.issue);
      if (!currentLabels.includes(LABEL_RUNNING)) {
        released.push(p.issue);
        continue;
      }
      const claimedIssue = claimed.find((c) => c.issue === p.issue);
      // Evict each stale holder through the SANCTIONED concede path FIRST, so the
      // withdrawal marker lands before the label projection changes and no reader
      // ever sees an unclaimed-but-still-`running` window.
      if (deps.concedeClaim && deps.claimEvictor) {
        for (const owner of p.staleOwners) {
          const latest = claimedIssue?.records
            .filter((record) => record.worker === owner)
            .sort((a, b) => b.commentId - a.commentId)[0];
          const heartbeatS = latest?.createdAt ? Math.floor(Date.parse(latest.createdAt) / 1000) : Number.NaN;
          await deps.concedeClaim(
            p.issue,
            renderConcedeOnBehalf(
              owner,
              deps.claimEvictor,
              latest?.createdAt,
              Number.isFinite(heartbeatS) ? Math.max(0, deps.nowS - heartbeatS) : undefined,
            ),
          );
        }
      }
      const parked = currentLabels.includes(LABEL_HUMAN) || currentLabels.some((l) => l.startsWith("blocked:"));
      if (parked) {
        // A parked issue only sheds the stale `running` projection — the park
        // itself is the authoritative state and must survive the sweep (#968).
        await deps.gh.editLabels(p.issue, [LABEL_RUNNING], []);
      } else {
        const plan = planTransition(currentLabels, { kind: "queue" });
        if (isRefused(plan)) {
          // A refused queue (e.g. dangling req:* edges without blocked:dependency)
          // is a poison signal — shed `running` but never re-admit the issue.
          deps.log?.(`boot claim-sweep queue refused for #${p.issue}: ${plan.reason}`);
          await deps.gh.editLabels(p.issue, [LABEL_RUNNING], []);
        } else {
          await deps.gh.editLabels(p.issue, [...plan.remove], [...plan.add]);
        }
      }
      const deadOwners = new Set(claimedIssue?.deadOwners ?? []);
      const concededOwners = p.concededOwners ?? [];
      const body = concededOwners.length > 0
        ? renderConcededClaimSweepAudit(concededOwners)
        : p.staleOwners.some((owner) => deadOwners.has(owner))
          ? renderDeadClaimSweepAudit(p.staleOwners)
          : renderStaleClaimSweepAudit(p.staleOwners);
      await deps.gh.comment(p.issue, body);
      released.push(p.issue);
      if (concededOwners.length > 0) repairedConceded.push(p.issue);
    } catch {
      // Best-effort: a failed release leaves the issue for the next boot's sweep.
    }
  }
  return repairedConceded.length > 0 ? { released, repairedConceded } : { released };
}

/** Step 3: decideOrphanFate per dir, then apply the fate via gh + fs. Mirrors
 * the prune_orphans inner loop:
 *   - keep-until(ttl): remove iff the dir's age already exceeds the TTL; else keep.
 *   - restore-and-remove: edit labels (running → ready-for-agent) + recovery
 *     comment, then rm -rf.
 *   - remove: rm -rf. */
async function runOrphanCleanup(
  deps: BootDeps,
  options: BootOptions,
): Promise<OrphanCleanupResult> {
  const orphans = options.orphans;
  const removed: string[] = [];
  const restored: number[] = [];
  const kept: string[] = [];
  const legacyWiped: string[] = [];
  const claimsReleased: string[] = [];

  // Drain-first cutover (#252): unconditionally wipe any leftover pre-cutover
  // flat `work-*` dir whose orchestrator the caller already found dead. This
  // mirrors the `rm -rf "$TMP_DIR"/work-*/` loop at the top of prune_orphans and
  // runs BEFORE the nested attempt-dir sweep, exactly as bash does.
  for (const path of options.legacyWorkDirs ?? []) {
    await deps.fs.removeDir(path);
    legacyWiped.push(path);
  }

  for (const dir of orphans) {
    const hasStateFile = dir.issue !== null;
    let state: IssueOpenState = "OPEN";
    let label: string | null = null;
    let envelopePosted = false;
    let ghOk = true;

    if (hasStateFile && dir.issue !== null) {
      const r = await deps.lookups.orphanState(dir.issue);
      ghOk = r.ghOk;
      state = r.state;
      label = r.label;
      envelopePosted = r.envelopePosted;
    }

    const fate = decideOrphanFate({
      issueState: state,
      label,
      envelopePosted,
      hasStateFile,
      ageS: dir.ageS,
      ghOk,
    });

    if (fate.kind === "remove") {
      await deps.fs.removeDir(dir.path);
      removed.push(dir.path);
    } else if (fate.kind === "restore-and-remove") {
      // A dead attempt dir naming issue N does not prove the ISSUE is orphaned
      // (#644): a claim-race loser leaves one behind while the winner is alive
      // and working. Restore only when no live worker holds the claim lock;
      // otherwise the dir is debris of a lost race → plain remove, no label
      // edit, no recovery comment.
      const ownedByLiveWorker = (await deps.lookups.claimHolderAlive?.(dir.issue!).catch(() => false)) ?? false;
      if (ownedByLiveWorker) {
        await deps.fs.removeDir(dir.path);
        removed.push(dir.path);
      } else {
        await applyBootStateTransition(deps, dir.issue!, { kind: "queue" }, [
          [LABEL_RUNNING],
          [LABEL_READY],
        ]);
        await deps.gh.comment(
          dir.issue!,
          "🤖 /afk orchestrator died mid-issue; restoring ready-for-agent.",
        );
        restored.push(dir.issue!);
        await deps.fs.removeDir(dir.path);
        removed.push(dir.path);
      }
    } else {
      // keep-until(ttlS): remove only once the dir has aged past the TTL.
      if (dir.ageS > fate.ttlS) {
        await deps.fs.removeDir(dir.path);
        removed.push(dir.path);
      } else {
        kept.push(dir.path);
      }
    }
  }

  // Stale claim-lock sweep: reclaim any `.red/tmp/claims/<N>/` lock whose
  // recorded pid the caller already resolved as dead. Mirrors the trailing
  // `for c in "$TMP_DIR"/claims/*/` loop in prune_orphans. Runs last, after the
  // attempt-dir sweep, so a freshly-released claim is never re-examined.
  for (const claim of options.staleClaimDirs ?? []) {
    if (claim.issue !== undefined) {
      try {
        const currentLabels = await deps.gh.viewLabels(claim.issue);
        const parked = currentLabels.includes(LABEL_HUMAN) || currentLabels.some((l) => l.startsWith("blocked:"));
        if (currentLabels.includes(LABEL_RUNNING) && !parked) {
          const plan = planTransition(currentLabels, { kind: "queue" });
          if (isRefused(plan)) {
            deps.log?.(`boot stale-claim queue refused for #${claim.issue}: ${plan.reason}`);
          } else {
            await deps.gh.editLabels(claim.issue, [...plan.remove], [...plan.add]);
          }
        }
      } catch {
        // Best-effort: stale local claim dirs are still safe to remove.
      }
    }
    await deps.fs.removeDir(claim.path);
    claimsReleased.push(claim.path);
  }

  await deps.fs.reapDeadEmptyWorkerShells?.(options.bootstrap.tmpDir).catch(() => undefined);

  return { removed, restored, kept, legacyWiped, claimsReleased };
}

/** Step 4: planAttemptCap per issue with fixed legacy cleanup caps, then rm
 * -rf each reclaimed dir. */
async function runAttemptCap(deps: BootDeps, input: AttemptCapInput): Promise<AttemptCapResult> {
  const reclaimed: string[] = [];

  for (const [, attempts] of input.byIssue) {
    const reaped = planAttemptCap(attempts, {
      ttlS: DEFAULT_ATTEMPT_TTL_S,
      keep: DEFAULT_ATTEMPT_KEEP,
      nowS: deps.nowS,
    });
    for (const dir of reaped) {
      await deps.fs.removeDir(dir.path);
      reclaimed.push(dir.path);
    }
  }

  return { reclaimed };
}

/** Step 5: the three branch-cleanup planners, deleting only the reaped refs.
 * Remote-live refs delete remotely (afk/*), local-live refs delete locally.
 * Order mirrors afk.sh: _remote_live → _local. */
async function runBranchCleanup(
  deps: BootDeps,
  input: BranchCleanupInput,
): Promise<BranchCleanupResult> {
  const remoteLivePlan = planLiveBranchCleanup(
    input.remoteLiveRefs,
    deps.lookups.branchIssue,
    deps.nowS,
  );
  const remoteLiveReaped: string[] = [];
  for (const d of branchesToReap(remoteLivePlan)) {
    await deps.git.deleteRemoteBranch(d.branch);
    remoteLiveReaped.push(d.branch);
  }

  // The local pass reclaims on LANDED-ness, with the tracker's closed-issue
  // verdict folded in as the weaker second route (#2866). The reclaim planner is
  // the authority over both: it alone may spare `red-trunk` and the trunk.
  const localLivePlan = planLocalBranchCleanup(
    input.localLiveRefs,
    deps.lookups.branchIssue,
    deps.nowS,
  );
  const issueClosed = new Set(branchesToReap(localLivePlan).map((d) => d.branch));
  const landed = new Set(input.landedLocalBranches ?? []);
  const localPlan = planBranchReclaim(
    input.localLiveRefs.map((ref) => ({
      branch: ref.branch,
      landed: landed.has(ref.branch),
      issueClosed: issueClosed.has(ref.branch),
    })),
    { trunk: input.trunk },
  );
  const localLiveReaped: string[] = [];
  for (const d of localPlan.reclaim) {
    await deps.git.deleteLocalBranch(d.branch);
    localLiveReaped.push(d.branch);
  }

  return { remoteLiveReaped, localLiveReaped, localSpared: localPlan.spare };
}

/** Step 6: planUnblockSweep, then promote each planned issue (remove its holding
 * `blocked:dependency` label, add ready-for-agent) and post its audit comment.
 * Mirrors sweep_unblocked. */
async function runUnblockSweep(
  deps: BootDeps,
  candidates: readonly UnblockCandidate[],
): Promise<UnblockSweepResult> {
  // Delegate to the shared sweep core so the boot-time safety net and the
  // periodic supervisor sweep (#844) promote through exactly one code path.
  // The repo's own vocabulary decides the LANE (#2966): a dependent carrying a
  // declared HUMAN-ONLY type parks for its human instead of joining the queue.
  const promoted = await executeUnblockSweep(
    candidates,
    deps.lookups.blockerState,
    deps.gh,
    readHitlTypeLabels(deps.config ?? {}),
  );
  return { promoted };
}

/** Step 6a0: mixed-blocked normalizer (#1481). Heal any issue found in the illegal
 * MIXED-BLOCKED state (`ready-for-agent`/`running` together with a `blocked:*`
 * label) by shedding the stale `blocked:*` labels, so it can never trip a worker's
 * lifecycle FSM into the illegal state that crashed workers mid-setup. Sequenced
 * right after the unblock sweep and before the stale-claim sweep so a healed issue
 * rejoins the executable pool cleanly. A no-op when no candidates are provided. */
async function runMixedBlockedNormalize(
  deps: BootDeps,
  options: BootOptions,
): Promise<MixedBlockedNormalizeResult> {
  const candidates = options.mixedBlockedCandidates ?? [];
  if (candidates.length === 0) return { healed: [] };
  const healed = await executeMixedBlockedNormalize(candidates, deps.gh);
  return { healed };
}

/** Step 6a1: Spec sub-issue reconciler (#1739). The label edge (`spec:N`) is the
 * machine truth; native GitHub sub-issue edges are the human surface. This sweep
 * attaches every missing native edge and removes stale `needs-slicing` once a
 * Spec has published slices. A no-op when no candidates are provided. */
async function runSpecSubIssueReconcile(
  deps: BootDeps,
  options: BootOptions,
): Promise<SpecSubIssueReconcileBootResult> {
  const candidates = options.specSubIssueCandidates ?? [];
  if (candidates.length === 0) return { attached: [], needsSlicingRemoved: [] };
  return executeSpecSubIssueReconcile(candidates, deps.gh);
}

/** Step 7: reconcile sweep (ADR 0055). For each owned parked-mechanical branch,
 * validate-and-land it through the scoped feedback gate WITHOUT re-running the
 * agent. A no-op when no `reconcileRunner` is wired in or no candidates are
 * provided. Sequenced AFTER the unblock sweep so any dependency-promotion from
 * step 6 is already in place before we attempt to land dependents. */
async function runReconcileSweep(
  deps: BootDeps,
  options: BootOptions,
  staleReleasedRunningIssues: readonly number[] = [],
): Promise<ReconcileSweepResult> {
  const result: ReconcileSweepResult = { landed: [], parked: [], skipped: [] };
  if (!deps.reconcileRunner) return result;
  const candidates = options.reconcileSweepCandidates ?? [];
  if (candidates.length === 0) return result;

  // The remote live refs already list every `afk/{worker}/{N}-{slug}` branch
  // on origin — reuse them rather than fetching again. Extract the branch names.
  const remoteBranches = options.branches.remoteLiveRefs.map((r) => r.branch);
  const plans = planReconcileSweep(candidates, remoteBranches, staleReleasedRunningIssues);

  for (const plan of plans) {
    try {
      const { outcome } = await deps.reconcileRunner(plan);
      if (outcome === "landed") result.landed.push(plan.number);
      else if (outcome === "parked") result.parked.push(plan.number);
      else result.skipped.push(plan.number);
    } catch {
      // Best-effort: a runner crash skips the issue; the boot sweep is the safety net,
      // not the primary recovery path. The issue remains parked for the next boot.
      result.skipped.push(plan.number);
    }
  }
  return result;
}

/** Step 8: gather the straggler counts and decide whether to warn. The actual
 * TTY "proceed anyway?" prompt is the caller's — this only returns the flag.
 * Mirrors straggler_check. */
async function runStragglerCheck(deps: BootDeps): Promise<StragglerResult> {
  const counts = await stragglerCounts(deps.lookups.straggler);
  return { counts, warn: shouldWarnStragglers(counts) };
}
