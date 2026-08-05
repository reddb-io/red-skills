import { describe, expect, it } from "vitest";
import { runFeedback, type Exec, type PackageLayout, type RunFeedbackResult, buildValidationRecord } from "../src/core/feedback.js";
import { recoveryDecision, recoveryCap } from "../src/core/recovery.js";
import { blockedLabelFor, recoveryReasonFor } from "../src/core/worker-outcome.js";
import { decideVerdict, emptyEnvironmentLedger } from "../src/core/verdict.js";

function verdictIsEnvironment(result: RunFeedbackResult): boolean {
  if (result.ok) return false;
  return decideVerdict({
    checks: result.checks,
    signature: "resilience-signature",
    history: { environment: emptyEnvironmentLedger(2), branchBudgetAvailable: true },
    environment: {},
  }).fault.kind !== "branch";
}

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

function healthyGateClock(): () => number {
  let now = 0;
  return () => (now += 1000);
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
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineInconclusive: [],
      quarantined: [],
    };
    expect(verdictIsEnvironment(result)).toBe(true);
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
      now: healthyGateClock(),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("branch-fault");
    expect(result.baselineInconclusive).toEqual([]);
  });

  it("a failing check that ALSO fails on the baseline is INCONCLUSIVE — the branch parks with the evidence, main is never tracked as red (#2380)", async () => {
    const exec = fakeExec({
      "afk/wX/123-slug/apps/dev::test": 1, // worker fails
      "main/apps/dev::test": 1, // baseline also fails → comparison cannot attribute fault
    });
    const result = await runFeedback(exec, {
      worktree: "afk/wX/123-slug",
      scopes: ["apps/dev"],
      layout: makeLayout(),
      now: healthyGateClock(),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false); // inconclusive still blocks THIS branch
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
    const check = result.checks.find((c) => c.name === "test:apps/dev")!;
    expect(check.status).toBe("failed");
    expect(check.record.summary).toContain("inconclusive: also fails on the baseline");
  });

  it("retires the live-base feedback rebase from run settings", async () => {
    const { resolveRunSettings } = await import("../src/runtime/wire.js");
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const root = mkdtempSync(join(tmpdir(), "afk-resilience-rebase-"));
    try {
      mkdirSync(join(root, ".red"), { recursive: true });
      writeFileSync(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\nafk:\n  feedback:\n    rebase_on_base: true\n");
      expect(resolveRunSettings(root)).not.toHaveProperty("feedbackRebaseBase");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

// Pattern 3: Failures inherited from the base branch — main had
// `memory-brain-boundary-docs.test.ts` failing; every worker's branch (forked
// from main) inherited it; the gate picked it up. The comparison probe cannot
// attribute that failure to the branch, so the verdict is INCONCLUSIVE: the
// branch parks `blocked:validation` with the evidence, and nothing is filed.
describe("Pattern 3 — failures inherited from the base branch", () => {
  it("a failure reproduced on the baseline yields the INCONCLUSIVE verdict, never a tracked repair issue", async () => {
    // Model: only the `test:apps/dev` check fails on BOTH worker + baseline.
    // All other checks pass, so the comparison has nothing to blame the branch
    // for — but the branch still does not land on an unexplained red check.
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
      now: healthyGateClock(),
      baselineWorktree: "main",
    });
    expect(result.ok).toBe(false);
    expect(result.baselineVerdict).toBe("inconclusive");
    expect(result.baselineInconclusive).toEqual(["test:apps/dev"]);
  });
});

// Pattern 4: OOM under fleet=2 — vitest or pnpm parent gets SIGKILLed.
// The OOM killer signature is exit code 137 / the literal `SIGKILL` in
// the captured output. `verdictIsEnvironment` should catch it.
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
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineInconclusive: [],
      quarantined: [],
    };
    expect(verdictIsEnvironment(result)).toBe(true);
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
      checks: [{ name: "test:apps/dev", script: "test", label: "apps/dev", scope: "apps/dev", status: "failed", record }],
      sidecar: [JSON.stringify(record)],
      baselineInconclusive: [],
      quarantined: [],
    };
    expect(verdictIsEnvironment(result)).toBe(true);
  });
});

// Pattern 5: Orchestrator process dying — every worker process died
// post-commit + vitest with no exit code / signal / stack. The diagnostic
// (process-safety) now records every CATCHABLE death, and — crucially — the
// liveness heartbeat makes the UNCATCHABLE death (SIGKILL/OOM, which fires no
// handler) legible: "installed + heartbeats, then silence" classifies as
// uncatchable, pinned to the last heartbeat. The root cause is still under
// investigation, but it is no longer invisible.
describe("Pattern 5 — orchestrator process dying post-commit (now diagnosable)", () => {
  it("the stalled re-claim cap is 3 (regression guard for the runaway-loop fix in #402)", () => {
    expect(recoveryDecision("stalled", 1, {})).toBe("retry");
    expect(recoveryDecision("stalled", 2, {})).toBe("retry");
    expect(recoveryDecision("stalled", 3, {})).toBe("escalate");
    expect(recoveryCap("stalled", {})).toBe(3);
  });

  it("classifies an UNCATCHABLE death (SIGKILL/OOM) from the diagnostic log — the spike's exact symptom", async () => {
    // The spike workers died with no exit code / signal / stack: that is
    // EXACTLY the uncatchable case. A log with `installed` + heartbeats but no
    // terminal line is classified as SIGKILL/OOM, pinned to the last heartbeat.
    const { classifyDeathFromLog, describeDeath } = await import("../src/core/process-safety.js");
    const log = [
      "T0 pid=1 worker=wQYIB event=installed node=v22 platform=linux",
      "T1 pid=1 worker=wQYIB event=alive rss_mb=900",
      "T2 pid=1 worker=wQYIB event=alive rss_mb=1850", // climbing toward the OOM wall
    ].join("\n");
    const verdict = classifyDeathFromLog(log);
    expect(verdict.kind).toBe("uncatchable");
    expect(describeDeath(verdict)).toContain("SIGKILL/OOM");
  });

  it("a clean exit is NOT misread as an OOM death (no false alarm)", async () => {
    const { classifyDeathFromLog } = await import("../src/core/process-safety.js");
    const log = ["T0 ...event=installed node=v22", "T1 ...event=alive rss_mb=100", "T2 ...event=exit code=0"].join("\n");
    expect(classifyDeathFromLog(log)).toEqual({ kind: "clean-exit", code: "0" });
  });
});

// Pattern 6: the Verdict heals environment rounds in-process. Terminal
// validation outcomes therefore have no second outer retry budget.
describe("Pattern 6 — feedback gate retryability (the structural fix)", () => {
  it("`validation` (semantic) stays non-recoverable — a real worker bug still pages a human", () => {
    expect(recoveryCap("validation", {})).toBeNull();
    expect(recoveryDecision("validation", 1, {})).toBe("escalate");
    expect(recoveryDecision("validation", 99, {})).toBe("escalate");
  });

  it("the branch outcome maps to no outer recovery key", () => {
    expect(recoveryReasonFor("feedback-failed")).toBeNull();
    expect(blockedLabelFor("feedback-failed")).toBe("blocked:validation");
  });

  it("the infra outcome parks after the Verdict ledger, with no rival recovery key", () => {
    expect(recoveryReasonFor("feedback-failed-infra")).toBeNull();
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

// AFK runner improvement: Pattern 5's diagnostic is now wired in. Every
// worker process installs death detectors that record uncaught exceptions,
// signal handlers, and exit codes to a per-worker log at
// `.red/tmp/diagnostics/<id>.log`. The next session (or a human running
// `cat` on the log) can then correlate the spike's "agent idle for 1
// minute → process absent" symptom with the actual cause. This test
// asserts the diagnostic module's contract: the file is written, the
// format is parseable, and the safety log path is canonical.
describe("Pattern 5 — orchestrator dying diagnostic (process-safety)", () => {
  it("exposes a canonical safety log path under `.red/tmp/diagnostics/`", async () => {
    const { safetyLogPath } = await import("../src/core/process-safety.js");
    const { join } = await import("node:path");
    expect(safetyLogPath("/repo/.red/tmp", "wABCD")).toBe(
      join("/repo/.red/tmp", "diagnostics", "wABCD.log"),
    );
  });

  it("fileSafetyLogger writes one line per call, with an ISO timestamp prefix", async () => {
    const { fileSafetyLogger } = await import("../src/core/process-safety.js");
    const { mkdtemp, readFile, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "afk-resilience-"));
    const path = join(dir, "safety.log");
    const logger = fileSafetyLogger(path);
    logger.log("worker=wX event=uncaughtException message=\"boom\" stack=\"...\"");
    const content = await readFile(path, "utf8");
    const lines = content.trimEnd().split("\n");
    expect(lines).toHaveLength(1);
    // ISO 8601 with milliseconds, UTC, 'Z' suffix — the format the post-mortem
    // scripts parse to time-align with the issue thread's claim events.
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /);
    expect(lines[0]).toContain("event=uncaughtException");
    expect(lines[0]).toContain("message=\"boom\"");
    await rm(dir, { recursive: true, force: true });
  });
});
