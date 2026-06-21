import { describe, expect, it } from "vitest";
import { isInfraFeedbackFailure, runFeedback, type Exec, type PackageLayout, type RunFeedbackResult, buildValidationRecord } from "../src/core/feedback.js";
import { recoveryDecision, recoveryCap } from "../src/core/recovery.js";
import { blockedLabelFor, recoveryReasonFor } from "../src/core/attempt-outcome.js";

// AFK resilience test harness — codifies the 7 failure patterns the workers
// hit during the claude-minimax spike (June 2026) as deterministic, in-process
// tests. The point: every "the worker died and the branch was stranded"
// incident from that spike should map to ONE test in this file, so a future
// regression to any of the 7 patterns fails HERE first, not in production.
//
// Each `describe` block corresponds to a numbered pattern in the
// investigation; the test names embed the pattern number for at-a-glance
// mapping back to the original incident notes. New patterns add a new
// `describe` block + a new pattern number, never an extension to an existing
// one — preserving the table-of-contents shape.

function makeLayout(): PackageLayout {
  return {
    hasPackage: (scope) => scope === "." || scope === "apps/dev",
    hasScript: () => true,
  };
}

function fakeExec(plan: Record<string, number>): Exec {
  return async (args) => {
    const dir = args[args.indexOf("-C") + 1] ?? "";
    const script = args[args.length - 1] ?? "";
    const key = `${dir}::${script}`;
    const code = plan[key] ?? 0;
    return code === 0 ? { code: 0, stdout: "ok", stderr: "" } : { code, stdout: "FAIL", stderr: "expected 1 to equal 2" };
  };
}

// Pattern 1: Submodule lifecycle in a fresh worktree — git worktree add does
// NOT populate submodules, so the feedback-worktree setup fails with
// "feedback worktree setup failed for <branch>; validation blocked" and the
// gate returns code 1.
describe("Pattern 1 — submodule lifecycle in a fresh worktree", () => {
  it("classifies the setup-failed marker as INFRA (auto-recoverable)", () => {
    const record = buildValidationRecord({
      name: "test:apps/dev",
      status: "failed",
      command: "pnpm -C afk/wX/123-slug/apps/dev test",
      summary: "feedback worktree setup failed for afk/wX/123-slug; validation blocked",
    });
    const result: RunFeedbackResult = {
      ok: false,
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineDowngraded: [],
    };
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });

  it("routes the failure through validation-infra recovery (cap 2, retry under cap)", () => {
    // recovery.ts contract: validation-infra retries while attemptN < 2.
    expect(recoveryDecision("validation-infra", 1, {})).toBe("retry");
    expect(recoveryDecision("validation-infra", 2, {})).toBe("escalate");
    expect(recoveryCap("validation-infra", {})).toBe(2);
  });

  it("the post-checkout hook exists at scripts/git-hooks/post-checkout (tracked) so a fresh clone can install it", async () => {
    // The hook script is tracked in the repo so contributors can install it
    // via scripts/install-git-hooks.sh on a fresh clone. Asserting existence
    // here guards against accidentally deleting the file (Pattern 1's only
    // real prevention). Read is async + filesystem; runs in the test process
    // by design — this test is the meta-guard for Pattern 1.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const repoRoot = path.resolve(__dirname, "..", "..", "..");
    const hookPath = path.join(repoRoot, "scripts", "git-hooks", "post-checkout");
    const installerPath = path.join(repoRoot, "scripts", "install-git-hooks.sh");
    await expect(fs.access(hookPath)).resolves.toBeUndefined();
    await expect(fs.access(installerPath)).resolves.toBeUndefined();
  });
});

// Pattern 2: Test drift between worker branch and main — the worker's test
// was written before main evolved (e.g. CLAUDE_CODE_SIMPLE was added to
// minimax-env.ts), so the worker's test expects 2 env vars but the function
// returns 3. The feedback run fails on the worker's branch but the worker
// code is actually fine. The baseline probe handles this: re-running the
// failing check on the baseline confirms whether the failure is in the
// worker's code or in the test drift.
describe("Pattern 2 — test drift between worker branch and main", () => {
  it("a failing check that PASSES on the baseline stays `failed` (real worker bug, not drift)", async () => {
    const exec = fakeExec({
      "afk/wX/123-slug/apps/dev::test": 1, // worker fails
      "main/apps/dev::test": 0, // baseline passes → it's a worker bug, not drift
    });
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineDowngraded).toEqual([]);
  });

  it("a failing check that ALSO fails on the baseline is downgraded (the worker is fine, main is broken)", async () => {
    const exec = fakeExec({
      "afk/wX/123-slug/apps/dev::test": 1, // worker fails
      "main/apps/dev::test": 1, // baseline also fails → pre-existing flake, downgrade
    });
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(true); // downgraded, gate passes
    expect(result.baselineDowngraded).toEqual(["test:apps/dev"]);
    const check = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(check.status).toBe("skipped");
    expect(check.record.summary).toBe("pre-existing failure on baseline");
  });
});

// Pattern 3: Pre-existing test failures on main being inherited — main had
// `memory-brain-boundary-docs.test.ts` failing; every worker's branch (forked
// from main) inherited it; the gate picked it up. The baseline probe
// identifies it as a pre-existing flake and downgrades it.
describe("Pattern 3 — pre-existing main failures being inherited", () => {
  it("the baseline probe downgrades a pre-existing main failure (so a green branch isn't parked)", async () => {
    // Model: only the `test:apps/dev` check fails on BOTH worker + baseline
    // (pre-existing flake). All other checks pass. Without the probe, the
    // gate would fail; with the probe, the only failure is downgraded.
    const exec = fakeExec({
      "afk/wX/123-slug::test": 0,
      "afk/wX/123-slug/apps/dev::test": 1,
      "main::test": 0,
      "main/apps/dev::test": 1, // pre-existing
      "afk/wX/123-slug::typecheck": 0,
      "afk/wX/123-slug/apps/dev::typecheck": 0,
      "main::typecheck": 0,
      "main/apps/dev::typecheck": 0,
    });
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: [".", "apps/dev"],
      layout: makeLayout(),
      now: () => 0,
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(true);
    expect(result.baselineDowngraded).toEqual(["test:apps/dev"]);
  });
});

// Pattern 4: OOM under fleet=2 — vitest or pnpm parent gets SIGKILLed.
// The OOM killer signature is exit code 137 / the literal `SIGKILL` in
// the captured output. `isInfraFeedbackFailure` should catch it.
describe("Pattern 4 — OOM under fleet=2", () => {
  it("classifies an OOM-killed pnpm invocation as INFRA (auto-recoverable)", () => {
    const record = buildValidationRecord({
      name: "test:apps/dev",
      status: "failed",
      command: "pnpm -C afk/wX/123-slug/apps/dev test",
      summary: "ELIFECYCLE  Command failed with exit code 137",
    });
    const result: RunFeedbackResult = {
      ok: false,
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineDowngraded: [],
    };
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });

  it("classifies a SIGKILL line in the output as INFRA (auto-recoverable)", () => {
    const record = buildValidationRecord({
      name: "test:apps/dev",
      status: "failed",
      command: "pnpm -C afk/wX/123-slug/apps/dev test",
      summary: "vitest worker killed by SIGKILL",
    });
    const result: RunFeedbackResult = {
      ok: false,
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineDowngraded: [],
    };
    expect(isInfraFeedbackFailure(result)).toBe(true);
  });
});

// Pattern 5: Orchestrator process dying — every worker process died
// post-commit + vitest. The cause is still under investigation (#INV-A in
// the roadmap). For now, this test codifies the STALE-CLAIM behavior that
// the cross-host recovery uses to keep the issue moving when the worker
// owner stops refreshing: the issue must not be stuck.
describe("Pattern 5 — orchestrator process dying post-commit (cross-host stale-claim recovery)", () => {
  // We can't easily test the supervisor's kill + stale-claim sweep without
  // the full supervisor module, but we can lock in the recovery cap that
  // bounds the re-claim loop: a stalled worker re-claims at most 3 times
  // before escalating (#402).
  it("the stalled re-claim cap is 3 (regression guard for the runaway-loop fix in #402)", () => {
    expect(recoveryDecision("stalled", 1, {})).toBe("retry");
    expect(recoveryDecision("stalled", 2, {})).toBe("retry");
    expect(recoveryDecision("stalled", 3, {})).toBe("escalate");
    expect(recoveryCap("stalled", {})).toBe(3);
  });
});

// Pattern 6: Feedback gate not retryable (the structural fix) — before the
// AFK runner improvement, `validation` was NON-RECOVERABLE (always
// escalate). The cap=0 default meant the worker branch was stranded the
// first time the gate failed for any reason. The fix splits `validation`
// into semantic (still non-recoverable) + INFRA (new `validation-infra`
// with cap 2).
describe("Pattern 6 — feedback gate retryability (the structural fix)", () => {
  it("`validation` (semantic) stays non-recoverable — a real worker bug still pages a human", () => {
    expect(recoveryCap("validation", {})).toBeNull();
    expect(recoveryDecision("validation", 1, {})).toBe("escalate");
    expect(recoveryDecision("validation", 99, {})).toBe("escalate");
  });

  it("`validation-infra` (infra) IS recoverable under its cap — a one-off flake self-heals", () => {
    expect(recoveryCap("validation-infra", {})).toBe(2);
    expect(recoveryDecision("validation-infra", 1, {})).toBe("retry");
    expect(recoveryDecision("validation-infra", 2, {})).toBe("escalate");
  });

  it("the SEMANTIC outcome `feedback-failed` still maps to no recovery key (NOT to validation-infra)", () => {
    // Regression guard: a sloppy refactor that mapped `feedback-failed` to
    // the new recovery key would silently turn every test/code failure into
    // an auto-retry, breaking the "page a human when code is bad" contract.
    expect(recoveryReasonFor("feedback-failed")).toBeNull();
    expect(blockedLabelFor("feedback-failed")).toBe("blocked:validation");
  });

  it("the INFRA outcome `feedback-failed-infra` maps to validation-infra + blocked:validation-infra", () => {
    expect(recoveryReasonFor("feedback-failed-infra")).toBe("validation-infra");
    expect(blockedLabelFor("feedback-failed-infra")).toBe("blocked:validation-infra");
  });
});

// Pattern 7: Claim race + cross-host stale-claim is a band-aid — re-claims
// do `git worktree add` + `pnpm install` from scratch. There's no
// worktree-cache yet (Medium-effort item). For now, this test codifies the
// re-claim cap so the runaway loop never comes back.
describe("Pattern 7 — claim race / cross-host stale-claim band-aid", () => {
  it("all recoverable reasons honour their caps (no runaway loops)", () => {
    // [reason, defaultCap, firstRetryAttempt]
    //   firstRetryAttempt is the first attempt that should retry; for cap=1
    //   reasons (policy), even attempt 1 escalates (the cap is the BOUNDARY,
    //   so attemptN < cap means retry → 1 < 1 is false → escalate).
    const cases: Array<[string, number, number]> = [
      ["merge-conflict", 3, 1],
      ["quota", 3, 1],
      ["runner-transient", 3, 1],
      ["policy", 1, 0], // cap 1 → attempt 1 escalates; no retry attempts exist
      ["validation-infra", 2, 1],
      ["stalled", 3, 1],
    ];
    for (const [reason, cap, firstRetry] of cases) {
      if (firstRetry > 0) {
        expect(recoveryDecision(reason, firstRetry, {})).toBe("retry");
      }
      // at/over cap → escalate
      expect(recoveryDecision(reason, cap, {})).toBe("escalate");
      expect(recoveryDecision(reason, cap + 5, {})).toBe("escalate");
    }
  });

  it("all recoverable caps are overridable per-deployment via RED_AFK_RETRY_* env knobs", () => {
    // The ops escalation path: bump the cap without code change.
    const cases: Array<[string, string]> = [
      ["merge-conflict", "RED_AFK_RETRY_MERGE"],
      ["quota", "RED_AFK_RETRY_QUOTA"],
      ["runner-transient", "RED_AFK_RETRY_RUNNER_TRANSIENT"],
      ["policy", "RED_AFK_RETRY_POLICY"],
      ["validation-infra", "RED_AFK_RETRY_VALIDATION_INFRA"],
      ["stalled", "RED_AFK_RETRY_STALLED"],
    ];
    for (const [reason, knob] of cases) {
      // numeric env raises the cap
      expect(recoveryCap(reason, { [knob]: "10" })).toBe(10);
      // non-numeric env falls back to the default
      expect(recoveryCap(reason, { [knob]: "lots" })).toBeGreaterThan(0);
    }
  });
});
