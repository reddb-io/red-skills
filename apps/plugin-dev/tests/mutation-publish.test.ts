/**
 * Diff-scoped mutation testing at publish, hard-budgeted (Spec #4129, #4140).
 *
 * The suite proves the four things the ticket asks for, and it proves the first
 * and third with a REAL mutation loop rather than a stub: `runMutants` below
 * transpiles each mutated source and runs the fixture's own assertions against
 * it, so a "killed" result means the assertions genuinely went red and a
 * "survived" result means they genuinely stayed green. Only the clock and the
 * subprocess boundary are faked, which is the seam the module declares.
 *
 *   1. A WEAK-test fixture leaves survivors on the changed lines, and the
 *      publish is refused inside the configured wall-clock cap.
 *   2. Budget exhaustion yields an advisory note and a NON-blocking stage; the
 *      fake clock pins the bound to the budget exactly.
 *   3. A STRONG-test fixture passes and the verdict row records the score.
 *   4. The wait is declared — asserted against the live `DECLARED_WAITS`.
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { planFileMutants, planMutants } from "../src/core/mutation-operators.js";
import {
  applyMutant,
  describeMutant,
  DEFAULT_MAX_MUTANTS,
  MUTATION_OPERATOR_IDS,
  type Mutant,
  type MutationSource,
} from "../src/core/mutation-plan.js";
import {
  decideMutationOutcome,
  DEFAULT_MUTATION_BUDGET_MS,
  DEFAULT_MUTATION_MAX_MUTANTS,
  DEFAULT_MUTATION_POLICY,
  DEFAULT_MUTATION_POLL_MS,
  DEFAULT_MUTATION_THRESHOLD,
  mutationEvidence,
  mutationRefusal,
  resolveMutationPolicy,
  runDiffScopedMutation,
  skippedMutationOutcome,
  type MutantFate,
  type MutationClock,
  type MutationOutcome,
  type MutationPolicy,
  type MutationRunHandle,
  type MutationRunner,
  type MutationWaitBeat,
} from "../src/core/mutation-publish.js";
import {
  composeReviewEvidence,
  decideReviewStage,
  foldMutationIntoReview,
  runReviewStage,
  type ReviewStageDecision,
  type VerdictLedgerSink,
} from "../src/core/review-fail-closed.js";
import { DECLARED_WAITS } from "../src/core/declared-wait-guard.js";
import type { VerdictAppendInput, VerdictRow } from "../src/core/verdict-ledger.js";
import type { ReviewVerifier } from "../src/core/review-verifier-identity.js";
import type {
  AdversarialReviewContext,
  AdversarialReviewFindings,
} from "../src/core/adversarial-review.js";

// ---------- the subject under mutation ----------

/**
 * The fixture module. Line 2 holds the boundary (`>=`), line 3 the comparison
 * the tests do exercise — so a diff that touched only line 2 must produce the
 * boundary mutant and nothing from line 3.
 */
const SUBJECT = [
  "export function classify(age) {",
  "  if (age >= 18) return 'adult';",
  "  if (age >= 13) return 'teen';",
  "  return 'child';",
  "}",
  "",
].join("\n");

/** Only line 2 was touched by this publish's diff. */
const CHANGED_LINES = [2];

const source: MutationSource = { path: "src/classify.ts", text: SUBJECT, changedLines: CHANGED_LINES };

interface Case {
  readonly age: number;
  readonly expected: string;
}

/** Weak: never probes the boundary itself, so `>=` → `>` goes unnoticed. */
const WEAK_CASES: readonly Case[] = [
  { age: 5, expected: "child" },
  { age: 40, expected: "adult" },
];

/** Strong: pins both sides of the boundary. */
const STRONG_CASES: readonly Case[] = [
  { age: 5, expected: "child" },
  { age: 14, expected: "teen" },
  { age: 18, expected: "adult" },
  { age: 40, expected: "adult" },
];

/**
 * A REAL mutant run: transpile the mutated source and check the fixture's
 * assertions against it. Red suite → the mutant is killed.
 */
function runMutantForReal(text: string, cases: readonly Case[]): MutantFate {
  const js = ts.transpileModule(text, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const exports: Record<string, unknown> = {};
  try {
    new Function("exports", js)(exports);
    const classify = exports["classify"] as (age: number) => string;
    for (const probe of cases) {
      if (classify(probe.age) !== probe.expected) return "killed";
    }
  } catch {
    return "killed";
  }
  return "survived";
}

/** The injected runner: settles on the first poll, like a suite that already ran. */
function realRunner(cases: readonly Case[]): MutationRunner & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    start(mutant: Mutant): MutationRunHandle {
      const fate = runMutantForReal(applyMutant(SUBJECT, mutant), cases);
      return {
        settle: () => fate,
        cancel: (reason) => cancelled.push(reason),
      };
    },
  };
}

/** A runner whose suite NEVER settles — the shape the wall-clock wall exists for. */
function hangingRunner(): MutationRunner & { cancelled: string[] } {
  const cancelled: string[] = [];
  return {
    cancelled,
    start(): MutationRunHandle {
      return { settle: () => null, cancel: (reason) => cancelled.push(reason) };
    },
  };
}

/** A fake clock: `sleep` advances virtual time and resolves, nothing is real. */
function fakeClock(): MutationClock & { elapsed(): number } {
  let now = 1_000;
  const start = now;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
    elapsed: () => now - start,
  };
}

/** The planner's output for one file, cut to the policy's ceiling. */
function plan(from: MutationSource): Mutant[] {
  return planMutants([from], { maxMutants: POLICY.maxMutants });
}

const POLICY: MutationPolicy = {
  ...DEFAULT_MUTATION_POLICY,
  budgetMs: 5_000,
  pollMs: 100,
  threshold: 0.8,
  maxMutants: 10,
};

// ---------- the mutator ----------

describe("mutation-operators", () => {
  it("mutates only tokens on the changed lines", () => {
    const mutants = planFileMutants(source);
    expect(mutants.map((mutant) => mutant.line)).toEqual([2]);
    expect(mutants).toHaveLength(1);
    expect(mutants[0]?.operator).toBe("conditional-boundary");
    expect(mutants[0]?.original).toBe(">=");
    expect(mutants[0]?.replacement).toBe(">");
    expect(describeMutant(mutants[0]!)).toContain("src/classify.ts:2");
  });

  it("produces a syntactically valid, behaviourally different tree", () => {
    const mutant = planFileMutants(source)[0]!;
    const mutated = applyMutant(SUBJECT, mutant);
    expect(mutated).toContain("age > 18");
    expect(mutated).not.toBe(SUBJECT);
    expect(runMutantForReal(mutated, STRONG_CASES)).toBe("killed");
    expect(runMutantForReal(mutated, WEAK_CASES)).toBe("survived");
  });

  it("is deterministic and covers every declared operator id", () => {
    expect(planFileMutants(source)).toEqual(planFileMutants(source));
    const wide: MutationSource = {
      path: "src/wide.ts",
      text: "export const f = (a, b) => a === b && a + b > 0 || true;\n",
      changedLines: [1],
    };
    const operators = new Set(planFileMutants(wide).map((mutant) => mutant.operator));
    for (const id of MUTATION_OPERATOR_IDS) expect(operators.has(id)).toBe(true);
  });

  it("interleaves files so one big module cannot eat the whole ceiling", () => {
    const many = (path: string): MutationSource => ({
      path,
      text: "export const f = (a, b) => a > b && a < b && a === b;\n",
      changedLines: [1],
    });
    const plan = planMutants([many("src/z.ts"), many("src/a.ts")], { maxMutants: 2 });
    expect(plan.map((mutant) => mutant.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(planMutants([many("src/a.ts")], { maxMutants: 0 })).toEqual([]);
    expect(DEFAULT_MAX_MUTANTS).toBe(DEFAULT_MUTATION_MAX_MUTANTS);
  });
});

// ---------- the budgeted run ----------

describe("runDiffScopedMutation", () => {
  it("refuses the publish when a weak test lets a mutant survive, inside the cap", async () => {
    const clock = fakeClock();
    const runner = realRunner(WEAK_CASES);
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner,
      clock,
    });

    expect(outcome.status).toBe("survivors");
    expect(outcome.blocking).toBe(true);
    expect(outcome.survived).toBe(1);
    expect(outcome.score).toBe(0);
    expect(outcome.elapsedMs).toBeLessThanOrEqual(POLICY.budgetMs);
    expect(runner.cancelled).toEqual([]);
    expect(mutationRefusal(outcome)).toContain("src/classify.ts:2");
  });

  it("passes when a strong test kills every mutant on the changed lines", async () => {
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner: realRunner(STRONG_CASES),
      clock: fakeClock(),
    });

    expect(outcome.status).toBe("killed-all");
    expect(outcome.blocking).toBe(false);
    expect(outcome.advisory).toBeNull();
    expect(outcome.score).toBe(1);
    expect(mutationEvidence(outcome)).toContain("score 100%");
  });

  it("stops at the wall-clock budget exactly, cancels the run, and stays advisory", async () => {
    const clock = fakeClock();
    const runner = hangingRunner();
    const beats: MutationWaitBeat[] = [];
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner,
      clock,
      onWait: (beat) => beats.push(beat),
    });

    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.blocking).toBe(false);
    expect(outcome.ran).toBe(0);
    expect(outcome.advisory).toContain("PARTIAL run");
    // The bound, pinned: the wait sleeps `pollMs` until the remaining budget is
    // smaller, so the run ends ON the budget rather than one poll past it.
    expect(clock.elapsed()).toBe(POLICY.budgetMs);
    expect(outcome.elapsedMs).toBe(POLICY.budgetMs);
    expect(runner.cancelled).toHaveLength(1);
    expect(runner.cancelled[0]).toContain("mutation budget exhausted");
    expect(beats).toHaveLength(POLICY.budgetMs / POLICY.pollMs);
    expect(beats.at(-1)?.remainingMs).toBe(POLICY.pollMs);
  });

  it("names survivors it saw before the wall without letting them block", async () => {
    const outcome = decideMutationOutcome({
      planned: 9,
      killed: 3,
      survivors: ["src/a.ts:1 > → >= (conditional-boundary)"],
      exhausted: true,
      elapsedMs: 5_000,
      policy: POLICY,
    });
    expect(outcome.status).toBe("budget-exhausted");
    expect(outcome.blocking).toBe(false);
    expect(outcome.advisory).toContain("src/a.ts:1");
  });

  it("degrades to an advisory note when nothing is mutable, unwired, or disabled", async () => {
    const untouched = await runDiffScopedMutation(
      { mutants: plan({ path: "src/x.ts", text: SUBJECT, changedLines: [] }), policy: POLICY },
      { runner: realRunner(WEAK_CASES), clock: fakeClock() },
    );
    expect(untouched.status).toBe("no-mutants");
    expect(untouched.blocking).toBe(false);

    const unwired = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner: null,
      clock: fakeClock(),
    });
    expect(unwired.status).toBe("unwired");
    expect(unwired.blocking).toBe(false);

    const off = await runDiffScopedMutation(
      { mutants: plan(source), policy: { ...POLICY, enabled: false } },
      { runner: realRunner(WEAK_CASES), clock: fakeClock() },
    );
    expect(off.status).toBe("disabled");
    expect(off.advisory).toContain("dev.review.mutation.enabled");
    expect(skippedMutationOutcome("unwired", POLICY, "note").advisory).toBe("note");
  });
});

describe("resolveMutationPolicy", () => {
  it("falls back to the shipped default one key at a time", () => {
    const empty = resolveMutationPolicy(() => "");
    expect(empty).toEqual(DEFAULT_MUTATION_POLICY);
    expect(empty.budgetMs).toBe(DEFAULT_MUTATION_BUDGET_MS);
    expect(empty.pollMs).toBe(DEFAULT_MUTATION_POLL_MS);
    expect(empty.threshold).toBe(DEFAULT_MUTATION_THRESHOLD);
  });

  it("reads a stated policy and refuses garbage", () => {
    const values: Record<string, string> = {
      "dev.review.mutation.enabled": "false",
      "dev.review.mutation.budget_ms": "30000",
      "dev.review.mutation.threshold": "0.5",
      "dev.review.mutation.poll_ms": "-1",
      "dev.review.mutation.max_mutants": "nonsense",
    };
    const policy = resolveMutationPolicy((key) => values[key] ?? "");
    expect(policy.enabled).toBe(false);
    expect(policy.budgetMs).toBe(30_000);
    expect(policy.threshold).toBe(0.5);
    expect(policy.pollMs).toBe(DEFAULT_MUTATION_POLL_MS);
    expect(policy.maxMutants).toBe(DEFAULT_MUTATION_MAX_MUTANTS);
  });
});

// ---------- the publish stage ----------

const VERIFIER: ReviewVerifier = {
  runner: "codex",
  model: "gpt-5",
  identity: "codex:gpt-5",
  notices: [],
};

const CLEAN: AdversarialReviewFindings = { summary: "nothing blocks", score: 0.9, findings: [] };

const CONTEXT: AdversarialReviewContext = {
  issueNumber: 4140,
  issueTitle: "Diff-scoped mutation testing at publish, hard-budgeted",
  issueBody: "## Acceptance criteria\n- [ ] a weak-test fixture blocks publish",
  diff: "diff --git a/src/classify.ts b/src/classify.ts",
  base: "origin/main",
};

function passingDecision(): ReviewStageDecision {
  return decideReviewStage({
    mode: "blocking",
    verifier: VERIFIER,
    attempt: { status: "reviewed", findings: CLEAN },
  });
}

function recordingLedger(): VerdictLedgerSink & { rows: VerdictRow[] } {
  const rows: VerdictRow[] = [];
  return {
    rows,
    async append(input: VerdictAppendInput): Promise<VerdictRow> {
      const row: VerdictRow = {
        at: "2026-08-21T00:00:00.000Z",
        voided: false,
        evidence: null,
        reason: null,
        ...input,
      };
      rows.push(row);
      return row;
    },
  };
}

async function publish(mutation: MutationOutcome | null, mode: "blocking" | "advisory" = "blocking") {
  const ledger = recordingLedger();
  const result = await runReviewStage(
    {
      key: { pr: 4140, head_sha: "abc1234", patch_id: "patch-1" },
      context: CONTEXT,
      mode,
      verifier: VERIFIER,
      evidence: "gate: green",
      mutation,
    },
    {
      reviewer: { review: async () => CLEAN },
      ledger,
    },
  );
  return { result, rows: ledger.rows };
}

describe("mutation evidence in the publish verdict row", () => {
  it("blocks the publish and records the survivors when a complete run falls short", async () => {
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner: realRunner(WEAK_CASES),
      clock: fakeClock(),
    });
    const { result, rows } = await publish(outcome);

    expect(result.decision.stage.ok).toBe(false);
    expect(result.decision.verdict).toBe("verifier-failed");
    expect(result.decision.park).toBeNull();
    expect(result.decision.reason).toContain("mutation testing refused the publish");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.evidence).toContain("gate: green");
    expect(rows[0]?.evidence).toContain("mutation survivors");
  });

  it("records the score and lets the publish through when the tests are strong", async () => {
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner: realRunner(STRONG_CASES),
      clock: fakeClock(),
    });
    const { result, rows } = await publish(outcome);

    expect(result.decision.stage.ok).toBe(true);
    expect(result.decision.verdict).toBe("test-verified");
    expect(rows[0]?.evidence).toContain("mutation killed-all: 1/1 killed");
  });

  it("exits clean with an advisory note when the budget is exhausted", async () => {
    const outcome = await runDiffScopedMutation({ mutants: plan(source), policy: POLICY }, {
      runner: hangingRunner(),
      clock: fakeClock(),
    });
    const { result, rows } = await publish(outcome);

    expect(result.decision.stage.ok).toBe(true);
    expect(result.decision.verdict).toBe("test-verified");
    expect(result.decision.reason).toContain("wall-clock budget");
    expect(rows[0]?.evidence).toContain("mutation budget-exhausted");
  });

  it("never overrides a verifier that could not conclude", () => {
    const blocked = decideReviewStage({ mode: "blocking", verifier: null, attempt: { status: "unavailable", detail: "down" } });
    const survivors = decideMutationOutcome({
      planned: 1,
      killed: 0,
      survivors: ["src/a.ts:1 > → >= (conditional-boundary)"],
      exhausted: false,
      elapsedMs: 10,
      policy: POLICY,
    });
    const folded = foldMutationIntoReview(blocked, survivors, true);
    expect(folded.verdict).toBe("verifier-blocked");
    expect(folded.park?.label).toBe("ready-for-human");
    expect(folded.reason).toContain("mutation testing refused");
  });

  it("annotates without blocking in advisory review mode, and is a no-op with no run", () => {
    const survivors = decideMutationOutcome({
      planned: 1,
      killed: 0,
      survivors: ["src/a.ts:1"],
      exhausted: false,
      elapsedMs: 10,
      policy: POLICY,
    });
    const advisory = foldMutationIntoReview(passingDecision(), survivors, false);
    expect(advisory.stage.ok).toBe(true);
    expect(advisory.verdict).toBe("verifier-failed");
    expect(foldMutationIntoReview(passingDecision(), null, true)).toEqual(passingDecision());
    expect(composeReviewEvidence(null, null)).toBeNull();
    expect(composeReviewEvidence("  ", null)).toBeNull();
  });
});

describe("the mutation wait is declared", () => {
  it("names its subject, deadline and escalation in DECLARED_WAITS", () => {
    const declared = DECLARED_WAITS.find(
      (wait) =>
        wait.path === "apps/plugin-dev/src/core/mutation-publish.ts" &&
        wait.fn === "awaitMutantSettled",
    );
    expect(declared).toBeDefined();
    expect(declared?.subject).toContain("mutant");
    expect(declared?.deadline).toContain("budget_ms");
    expect(declared?.escalation).toContain("budget-exhausted");
    expect(declared?.heartbeat.sink).toBe("onWait");
  });
});
