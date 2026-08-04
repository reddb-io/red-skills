// stale-base-drift — CAUSE-AWARE accounting for post-DONE machine-gate failures
// (issue #2711).
//
// The post-DONE correction budget — the gate share of the Re-seed budget
// (`RED_GO_VERIFY_RETRIES` for `/go`, `RED_RESEED_GATE_BUDGET` for `/afk`) — used
// to count ATTEMPTS, not
// CAUSES. That is the whole defect: the gate runs in a feedback worktree rebased
// onto the live base, so when the base moves under a run — most sharply on a
// `chore(release): version packages` bump, which rewrites every generated
// package mirror — the merged tree fails a check that the branch itself passes.
// The branch is not broken, yet the failure burned the same budget as a genuine
// red test, and when the budget ran out a COMPLETE, VALIDATED branch was parked
// as `blocked:validation`.
//
// The fix is an accounting one. A gate failure observed while the base moved
// under the attempt is attributed to `stale-base-drift`; a failure the gate has
// already marked `suspectInfra` is attributed to `suspect-infra`. Either cause
// grants a FREE correction cycle: the budget is untouched and the NEXT gate run
// settles the attribution. Green means it was right; red again without a free
// cause is charged as `branch-fault` like any other failure. The causes share
// one bounded free-cycle pool
// ({@link DEFAULT_STALE_BASE_DRIFT_CORRECTIONS}) so a churning base can never
// buy an unbounded run.
//
// IO-free: every input is data the caller already observed, so the attribution
// and the ledger are unit-testable with zero git and zero subprocess.

/** The release bump that most reliably triggers stale-base drift: it rewrites
 * every plugin `package.json` and the generated Pi package mirrors, so any
 * branch carrying a mirror generated at the pre-bump version fails a
 * `--check`-style generator gate the moment the bump is merged in. */
export const RELEASE_BUMP_SUBJECT = /^chore\(release\):\s*version packages/i;

/** What the base ref did while one attempt was running. */
export interface BaseMovement {
  /** Base head sha resolved when the attempt's branch was prepared. */
  startSha: string;
  /** Base head sha observed when the machine gate failed. */
  gateSha: string;
  /** Subjects of the commits the base gained in between, oldest → newest. */
  subjects: readonly string[];
}

/**
 * Did the base actually move under this attempt? Missing shas mean the probe
 * never ran (no `baseMovement` lookup wired, or an unresolved base), and an
 * unobserved base is NEVER read as movement — absent evidence must fall through
 * to the historical branch-fault accounting, not invent a refund.
 */
export function baseMoved(movement: BaseMovement | undefined): boolean {
  if (!movement) return false;
  if (!movement.startSha || !movement.gateSha) return false;
  return movement.startSha !== movement.gateSha;
}

/** The release version bumps among the commits the base gained, if any. */
export function releaseBumpSubjects(movement: BaseMovement | undefined): string[] {
  if (!movement) return [];
  return movement.subjects.filter((subject) => RELEASE_BUMP_SUBJECT.test(subject.trim()));
}

/** Who a post-DONE machine-gate failure belongs to. */
export type GateFailureCause = "branch-fault" | "stale-base-drift" | "suspect-infra";

export interface GateFailureAttribution {
  cause: GateFailureCause;
  /** One-line operator-facing reason, for the iteration log and the handoff. */
  reason: string;
  /** Release version bumps the base gained under this attempt. */
  releaseBumps: readonly string[];
  /** How many commits the base gained under this attempt. */
  movedCommits: number;
}

/** How many FREE (budget-exempt) correction cycles one attempt chain may spend
 * on stale-base drift. Bounded so a base that churns all day cannot buy an
 * unbounded run; two is enough to absorb a release bump plus one follow-up. */
export const DEFAULT_STALE_BASE_DRIFT_CORRECTIONS = 2;

/** Env override for {@link DEFAULT_STALE_BASE_DRIFT_CORRECTIONS}. */
export const STALE_BASE_DRIFT_CORRECTIONS_ENV = "RED_GATE_STALE_BASE_CORRECTIONS";

/** Parse a non-negative integer override, falling back to the default on any
 * malformed value so a typo'd env can never silently disable the allowance. */
export function resolveStaleBaseDriftCorrections(
  raw: string | undefined,
  fallback: number = DEFAULT_STALE_BASE_DRIFT_CORRECTIONS,
): number {
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * Attribute ONE post-DONE machine-gate failure. Drift is claimed only on
 * observed base movement and only while the bounded free allowance is unspent;
 * everything else stays `branch-fault`, which is the historical behaviour.
 */
export function attributeGateFailure(input: {
  movement?: BaseMovement;
  /** The gate already classified the command as too fast to have run. */
  suspectInfra?: boolean;
  /** Free cycles already granted to this attempt chain. */
  refundsUsed: number;
  maxRefunds?: number;
}): GateFailureAttribution {
  const movement = input.movement;
  const releaseBumps = releaseBumpSubjects(movement);
  const movedCommits = baseMoved(movement) ? movement!.subjects.length : 0;
  const maxRefunds = input.maxRefunds ?? DEFAULT_STALE_BASE_DRIFT_CORRECTIONS;
  if (input.suspectInfra === true) {
    if (input.refundsUsed >= maxRefunds) {
      return {
        cause: "branch-fault",
        reason:
          `the gate marked the failure suspect-infra, but the shared free-correction ` +
          `allowance (${maxRefunds}) is spent, so this failure is charged to the branch`,
        releaseBumps,
        movedCommits,
      };
    }
    return {
      cause: "suspect-infra",
      reason:
        "the gate marked the command too fast to have started, so it is an environment failure before the branch's",
      releaseBumps,
      movedCommits,
    };
  }
  if (!baseMoved(movement)) {
    return {
      cause: "branch-fault",
      reason: "the base did not move under this attempt, so the gate failure is the branch's",
      releaseBumps,
      movedCommits,
    };
  }
  const commits = `${movedCommits} commit${movedCommits === 1 ? "" : "s"}`;
  if (input.refundsUsed >= maxRefunds) {
    return {
      cause: "branch-fault",
      reason:
        `the base gained ${commits} under this attempt, but the stale-base correction ` +
        `allowance (${maxRefunds}) is spent, so this failure is charged to the branch`,
      releaseBumps,
      movedCommits,
    };
  }
  const bump = releaseBumps.length > 0 ? ", including a release version bump" : "";
  return {
    cause: "stale-base-drift",
    reason:
      `the base gained ${commits} under this attempt${bump}; the gate ran on a tree ` +
      "merged with that newer base, so the failure is attributed to stale-base drift, not the branch",
    releaseBumps,
    movedCommits,
  };
}

/** The correction cycles one attempt chain has spent, split by cause. */
export interface CorrectionLedger {
  /** Cycles charged to the caller's correction budget (`branch-fault`). */
  charged: number;
  /** Cycles granted free because the base moved or the gate suspected infra. */
  refunded: number;
  /** Every cycle in order, so a park can narrate what actually happened. */
  cycles: readonly GateFailureCause[];
}

export const EMPTY_CORRECTION_LEDGER: CorrectionLedger = Object.freeze({
  charged: 0,
  refunded: 0,
  cycles: Object.freeze([]) as readonly GateFailureCause[],
});

/** Record one correction cycle. Returns a NEW ledger — the caller's is never
 * mutated, so a refused retry leaves the accounting untouched. */
export function chargeCorrection(ledger: CorrectionLedger, cause: GateFailureCause): CorrectionLedger {
  return {
    charged: ledger.charged + (cause === "branch-fault" ? 1 : 0),
    refunded: ledger.refunded + (cause === "branch-fault" ? 0 : 1),
    cycles: [...ledger.cycles, cause],
  };
}

/** True once the CHARGED cycles reach the cap. Refunded drift cycles are
 * deliberately invisible here: an already-spent counter must never park a
 * branch whose failure was the base moving under it. */
export function correctionBudgetExhausted(ledger: CorrectionLedger, cap: number): boolean {
  return ledger.charged >= cap;
}

/** Park-comment fragment naming both counters, so a reader sees which budget
 * ran out and how much of the run was spent absorbing base drift. */
export function describeCorrectionLedger(ledger: CorrectionLedger, cap: number): string {
  const staleBase = ledger.cycles.filter((cause) => cause === "stale-base-drift").length;
  const suspectInfra = ledger.cycles.filter((cause) => cause === "suspect-infra").length;
  const free = [
    staleBase > 0 ? `${staleBase} stale-base correction${staleBase === 1 ? "" : "s"}` : "",
    suspectInfra > 0 ? `${suspectInfra} suspect-infra correction${suspectInfra === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  return `${ledger.charged}/${cap} charged${free === "" ? "" : `, plus ${free} that did not consume it`}`;
}

export interface StaleBaseDriftNote {
  /** The base branch name (`main`), for the merge instruction. */
  base: string;
  movement: BaseMovement;
  attribution: GateFailureAttribution;
}

/**
 * The handoff block a drift-attributed correction carries. It states the cause,
 * names the commits that moved the base, gives the exact merge to run, and says
 * plainly that the cycle was free — otherwise the agent reads "correction retry"
 * and starts hunting for a defect in work that is already correct.
 */
export function staleBaseDriftBlock(note: StaleBaseDriftNote): string[] {
  const remoteBase = `origin/${note.base}`;
  const bumps = note.attribution.releaseBumps;
  return [
    "<stale-base-drift>",
    `The machine gate ran on your branch MERGED WITH a base that moved under this run: ${note.attribution.reason}.`,
    `This correction cycle did not consume the post-DONE correction budget — it is attributed to the base, not to your work.`,
    "",
    `Do this first: \`git merge ${remoteBase}\` on the existing branch, re-run any generator the repo owns so its generated`,
    "mirrors are regenerated at the NEW base's version, commit the result, then re-run the gate and emit the terminal sentinel.",
    ...(bumps.length > 0
      ? [
          "",
          "The base gained a release version bump, which rewrites generated package mirrors — regenerate them:",
          ...bumps.map((subject) => `- ${subject}`),
        ]
      : []),
    "",
    `<base-commits base="${remoteBase}" from="${note.movement.startSha}" to="${note.movement.gateSha}">`,
    ...note.movement.subjects.map((subject) => `- ${subject}`),
    "</base-commits>",
    "</stale-base-drift>",
  ];
}
