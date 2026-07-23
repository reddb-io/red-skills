import {
  DEFAULT_BRANCH_TIP,
  SCOUT_EXIT_PROTOCOL,
  describe,
  expect,
  harness,
  installProcessSafety,
  it,
  labelTrace,
  noopSafetyLogger,
  parseCurrentBlocker,
  processIssue,
  upsertCurrentBlocker,
} from "./process-issue.test-helpers.js";
import type { AttemptProgressInfo, ConfigValues, ProcessIssueDeps } from "./process-issue.test-helpers.js";
describe("processIssue — feedback fail", () => {
  it("rejects a DONE attempt whose worker branch has no diff against base", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      changedFiles: [],
      feedbackOk: true,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.closed).toEqual([]);
    expect(trace.pnpmArgs).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    expect(trace.envelopeBodies.at(-1) ?? "").toContain("attempt branch has no diff against the merge-base");
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
  });

  it("/go retries a DONE empty-diff attempt under the existing machine-gate retry cap", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      changedFilesSequence: [[], ["packages/x/src/a.ts"]],
      feedbackOk: true,
      recoveryEnv: { RED_GO_VERIFY_RETRIES: "1" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("<go-machine-gate-retry>");
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("attempt branch has no diff against the merge-base");
    expect(trace.closed).toEqual([9]);
  });

  it("surfaces a docs-only DONE attempt as changed-no-source in the public envelope", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      changedFiles: ["README.md", "docs/setup.md"],
      feedbackOk: true,
      locked: false,
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    expect(trace.iterLogs.some((line) => line.includes("changed no source files"))).toBe(true);
    expect(trace.envelopeBodies.at(-1) ?? "").toContain("changed no source files");
  });

  it("flips to ready-for-human with a failure envelope when validation fails", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    const fbEdit = trace.labelEdits.at(-1)!;
    expect(fbEdit.add).toContain("ready-for-human");
    expect(fbEdit.add).toContain("blocked:validation");
    expect(trace.ensuredLabels).toContain("blocked:validation");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // post_attempt fired (the run authored DONE); the feedback gate ran and
    // FAILED (pre_feedback → on_baseline_probe → post_feedback → on_feedback_classify),
    // so pre_merge was never reached and the worker branch was not pushed.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "on_baseline_probe",
      "post_feedback",
      "on_feedback_classify",
    ]);
    expect(trace.pushedAttempt).toEqual([]);
  });

  it("/go retries a red post-DONE machine gate up to RED_GO_VERIFY_RETRIES, then parks with blocked:validation", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      feedbackResults: [false, false],
      recoveryEnv: { RED_GO_VERIFY_RETRIES: "1" },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("<go-machine-gate-retry>");
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("bounded correction retry 1/1");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.closed).toEqual([]);
  });

  it("/go lands when a bounded machine-gate correction makes feedback green", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      feedbackResults: [false, true],
      recoveryEnv: { RED_GO_VERIFY_RETRIES: "2" },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.closed).toEqual([9]);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(false);
  });

  it("/go also bounds backpressure re-verification and carries the failing output into the retry handoff", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
      goVerifyRetries: 1,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    const retryHandoff = trace.runAgentCalls[1]?.handoffContent ?? "";
    expect(retryHandoff).toContain("<go-machine-gate-retry>");
    expect(retryHandoff).toContain("backpressure machine gate failed");
    expect(retryHandoff).toContain("npm run e2e exploded");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation"))).toBe(true);
  });

  it("retries a simple-classified feedback failure once on the complex tier, then lands when green", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, true],
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: taskClass === "complex" ? "medium" : "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "claude", taskClass: "complex" },
    ]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-simple-model");
    expect(trace.runAgentCalls[1]?.model).toBe("claude-complex-model");
    expect(trace.runAgentCalls[1]?.effort).toBe("medium");
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+"]);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "done" }]);
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "on_baseline_probe", // gate 1 FAILED → the baseline probe ran
      "post_feedback",
      "on_feedback_classify", // SEMANTIC → simple→complex retry
      "pre_attempt", // the complex-tier retry
      "post_attempt",
      "pre_feedback",
      "post_feedback", // gate 2 passed → no baseline probe
      "pre_merge",
      "post_merge",
    ]);
  });

  it("does not escalate a simple-classified attempt when feedback passes", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(tiers).toEqual([{ runner: "claude", taskClass: "simple" }]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-simple-model");
  });

  it("bounds simple feedback escalation to one complex retry", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, false, true],
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return { model: `${runner}-${taskClass}-model`, effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "claude", taskClass: "complex" },
    ]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
  });
});


describe("processIssue — backpressure fail (#430)", () => {
  it("flips to ready-for-human exactly like a feedback fail when a backpressure command fails", async () => {
    // Feedback passes; the operator-declared backpressure command fails AFTER it.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
    });
    const result = await processIssue(deps, input);

    // Parks exactly like a feedback failure (same outcome + labels + envelope).
    expect(result.outcome).toBe("feedback-failed");
    expect(result.preserved).toBe(true);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:validation"]);
    expect(trace.ensuredLabels).toContain("blocked:validation");
    expect(trace.closed).toEqual([]);
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    // The worker branch was NOT pushed for landing (the gate blocked the merge).
    expect(trace.pushedAttempt).toEqual([]);

    // The validation sidecar carries the failing backpressure command + output
    // tail, named `backpressure:<cmd>`.
    const lastSidecar = trace.sidecarWrites.at(-1)!;
    const records = lastSidecar.lines.map((l) => JSON.parse(l) as { schema: string; name: string; status: string; command?: string; summary?: string });
    const bp = records.find((r) => r.name === "backpressure:npm run e2e")!;
    expect(bp.schema).toBe("red.afk.validation.v1");
    expect(bp.status).toBe("failed");
    expect(bp.command).toBe("npm run e2e");
    expect(bp.summary).toBe("npm run e2e exploded stack trace here");
  });

  it("merges + closes when feedback and backpressure both pass, sidecar carrying both", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
    // The DONE-path sidecar union includes the passed backpressure record.
    const sidecar = trace.sidecarWrites.at(-1)!;
    const names = sidecar.lines.map((l) => (JSON.parse(l) as { name: string }).name);
    expect(names).toContain("backpressure:npm run e2e");
  });
});


describe("processIssue — worker branch absent (FIX E: merge-gate bypass guard)", () => {
  it("escalates to the merge-conflict terminal path when the branch never reached the host", async () => {
    // DONE + green would normally merge, but the worker branch is absent on the
    // host (sandcastle push failed). The presence gate must STOP before feedback
    // so an empty changed-file set can't silently bypass validation + merge.
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      branchPresent: false,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(result.preserved).toBe(true);
    // The issue was NOT closed and NOT merged — the gate held on unvalidated work.
    expect(trace.closed).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    // Routed through the merge-conflict BOUNDED-recovery reason. At the default
    // attempt this is a retry (< cap 3), so #402 routes back to ready-for-agent
    // CLEAN — no blocked:* tag — while the merge-conflict envelope records the
    // reason; what matters here is the gate diverted off merge.
    const finalEdit = trace.labelEdits.at(-1)!;
    expect(finalEdit.add).toContain("ready-for-agent");
    expect(finalEdit.add).not.toContain("blocked:merge-conflict");
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "merge-conflict" }]);
    // The claim was released on this terminal path.
    expect(trace.released).toEqual([9]);
    // post_attempt fired (DONE authored), but pre_merge/post_merge never ran.
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
  });

  it("proceeds normally to merge when the branch IS present (default)", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true, branchPresent: true });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toEqual([9]);
  });
});


describe("processIssue — pre_worktree env threading (FIX J)", () => {
  it("threads the pre_worktree hook's env slice onto the runAgent input", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      preWorktreeEnv: { CARGO_TARGET_DIR: "/opt/cargo-target/slot-2" },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    // The env computed by pre_worktree reached the sandcastle execution port.
    expect(trace.runAgentCalls[0]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-2" });
  });

  it("leaves runAgent.env undefined when no pre_worktree hook mutates env", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.env).toBeUndefined();
  });

  it("carries the pre_worktree env onto the fallback runner after an exhaustion swap", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      feedbackOk: true,
      fallbackRunner: true,
      preWorktreeEnv: { CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" },
    });
    await processIssue(deps, input);
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[0]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" });
    expect(trace.runAgentCalls[1]?.env).toEqual({ CARGO_TARGET_DIR: "/opt/cargo-target/slot-5" });
  });
});


describe("processIssue — claim lost", () => {
  it("skips when the local claim lock is already held", async () => {
    const { deps, input, trace } = harness({ acquire: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]);
    expect(result.hooksFired).toEqual([]);
    // never reached sandcastle.
    expect(trace.runAgentCalls).toEqual([]);
  });

  it("skips when ready-for-agent is no longer present (raced)", async () => {
    const { deps, input, trace } = harness({ labels: ["running"] });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // no claim edit submitted; the claim lock was released.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.released).toEqual([9]);
  });

  // #1045: a `lane:go` issue never carries `ready-for-agent` — the isolated lane
  // IS its selection label. The pre-claim recheck must validate against the lane
  // the session selected under, not a hardcoded `ready-for-agent`. Before the
  // fix, `laneLabel: "lane:go"` fell into the recheck's hardcoded
  // `ready-for-agent` test, returned `claim-lost` BEFORE the claim was posted,
  // and the worker died silently while the launcher reported `1/1 exit 0`.
  it("#1045: a lane:go issue is NOT silently skipped — it proceeds past the preflight and claims", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      claim: { winner: "self" },
    });
    const result = await processIssue(deps, input);
    // The bug returned "claim-lost" here (silent boot death). Fixed: the lane
    // matches, so the worker proceeds through the claim to a real attempt.
    expect(result.outcome).not.toBe("claim-lost");
    expect(result.outcome).toBe("done");
    // It actually claimed (posted the GitHub-native claim marker) and ran the agent.
    expect(trace.comments.some((c) => /AFK claim by worker/.test(c.body))).toBe(true);
    expect(trace.runAgentCalls.length).toBeGreaterThan(0);
  });

  it("#1045: the lane-aware recheck still guards — a lane:go issue re-triaged out of its lane is claim-lost", async () => {
    // The issue was selected under lane:go but no longer carries it (e.g. closed
    // or re-labelled between selection and claim) → correctly abandoned, releasing
    // the lock, without spawning an agent.
    const { deps, input, trace } = harness({ labels: ["running"], laneLabel: "lane:go" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]);
    expect(trace.released).toEqual([9]);
    expect(trace.runAgentCalls).toEqual([]);
  });

  // ADR 0066: with the GitHub-native arbiter wired, `running` is a projection and
  // the claim comment decides the winner.
  it("concedes cleanly when it loses the GitHub-native claim (claim-lost, no agent)", async () => {
    // `running` is even PRESENT here — proving it is no longer consulted as the
    // lock; the earlier claim comment is what makes us lose.
    const { deps, input, trace } = harness({ claim: { winner: "other" }, labels: ["ready-for-agent", "running"] });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.labelEdits).toEqual([]); // never projected running — we lost
    expect(trace.released).toEqual([9]);
    expect(trace.runAgentCalls).toEqual([]); // no agent spawned
    // posted a claim then a concede (both recorded as comments).
    expect(trace.comments.some((c) => /conceded/.test(c.body))).toBe(true);
  });

  it("wins the GitHub-native claim solo and proceeds (running projected best-effort)", async () => {
    const { deps, input, trace } = harness({ claim: { winner: "self" } });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // running was PROJECTED (label edit applied) but is not the lock.
    expect(trace.labelEdits.some((e) => e.add.includes("running"))).toBe(true);
    expect(trace.comments.some((c) => /AFK claim by worker/.test(c.body))).toBe(true);
  });

  it("concedes the active GitHub-native claim when a SIGTERM arrives mid-attempt", async () => {
    const safety = installProcessSafety(noopSafetyLogger, { workerId: "wAAAA", heartbeatMs: 0 });
    try {
      const { deps, input, trace } = harness({
        claim: { winner: "self" },
        onRunAgent: () => {
          safety.handlers.sigTerm();
        },
      });
      const result = await processIssue(deps, input);
      expect(result.outcome).toBe("done");
      expect(trace.comments.some((c) => /kind=concede/.test(c.body))).toBe(true);
    } finally {
      safety.uninstall();
    }
  });
});


describe("processIssue — goal predicate (ADR 0057)", () => {
  it("maps a foreign close to claim-lost: releases the claim, drops running, no envelope spam", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // The attempt is moot — nothing is landed/closed and no terminal envelope is posted.
    expect(trace.postedEnvelopes).toEqual([]);
    expect(trace.closed).toEqual([]);
    // The claim lock is released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // Best-effort hygiene: our stale `running` label is shed.
    expect(trace.labelEdits.some((e) => e.remove.includes("running") && e.add.length === 0)).toBe(true);
    // At most one concise local record; the issue thread stays readable.
    const moot = trace.iterLogs.filter((l) => /goal predicate/.test(l));
    expect(moot).toHaveLength(1);
    expect(moot[0]).toMatch(/another lander.*claim-lost/);
  });

  it("maps this attempt's own merge to done (the close carries our landed branch)", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: true });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // Still no re-landing / re-close — the work is already in the world.
    expect(trace.postedEnvelopes).toEqual([]);
    expect(trace.closed).toEqual([]);
    expect(trace.released).toEqual([9]);
    const moot = trace.iterLogs.filter((l) => /goal predicate/.test(l));
    expect(moot).toHaveLength(1);
    expect(moot[0]).toMatch(/own merge.*done/);
  });

  it("threads the goalProbe onto the runAgent input so the guard polls issue state", async () => {
    const { deps, input, trace } = harness({ outcome: "goal-moot", branchMerged: false });
    await processIssue(deps, input);
    expect(typeof trace.runAgentCalls[0]?.goalProbe).toBe("function");
  });
});


describe("processIssue — trust gate (#621)", () => {
  const ALLOW: ConfigValues = { "afk.trust-gate.allowlist": "alice,bob" };

  it("refuses a non-executable issue BEFORE any claim edit / worktree, with a clear log line", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "stranger", readyForAgentActor: "alice" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // No promotion edit, no agent spawn — refused before any work.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.runAgentCalls).toEqual([]);
    // Claim lock released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // A clear, attributable log line names the gate + the reason.
    expect(trace.iterLogs.some((l) => /trust gate refused #9.*untrusted author 'stranger'/.test(l))).toBe(true);
  });

  it("refuses when ready-for-agent was applied by a non-allowlisted actor", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "alice", readyForAgentActor: "github-actions[bot]" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.iterLogs.some((l) => /trust gate refused.*github-actions\[bot\]/.test(l))).toBe(true);
  });

  it("claims normally when author AND label actor are both allowlisted", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      outcome: "done",
      feedbackOk: true,
      trust: { author: "alice", readyForAgentActor: "bob" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // The promotion-to-running claim edit ran (the gate passed).
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("is permissive when no allowlist is configured — the gate never fires even with an untrusted author", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      trust: { author: "stranger", readyForAgentActor: "anybody" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.iterLogs.some((l) => /trust gate/.test(l))).toBe(false);
  });
});


describe("processIssue — untrusted-author sandbox policy (#1112)", () => {
  it("forces container isolation for an untrusted author when the configured sandbox is none", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      sandboxMode: "none",
      availableSandboxes: ["docker"],
      trust: { author: "stranger", authorSourceTrust: "dubious", readyForAgentActor: "alice" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.runAgentCalls[0]?.sandboxMode).toBe("docker");
    expect(trace.iterLogs.some((l) => /sandbox policy: untrusted issue author forced docker isolation/.test(l))).toBe(
      true,
    );
  });

  it("refuses untrusted-author execution and pages a human when no container backend is available", async () => {
    const { deps, input, trace } = harness({
      sandboxMode: "none",
      availableSandboxes: [],
      trust: { author: "stranger", authorSourceTrust: "dubious", readyForAgentActor: "alice" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(trace.runAgentCalls).toEqual([]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+ready-for-human"]);
    expect(trace.comments.some((c) => /requires container isolation.*no docker\/podman sandbox backend/.test(c.body))).toBe(
      true,
    );
    expect(trace.released).toEqual([9]);
  });

  it("parks with the exact build command when the forced backend has no image (#2340)", async () => {
    const { deps, input, trace } = harness({
      sandboxMode: "none",
      availableSandboxes: ["docker"],
      sandboxImage: "sandcastle:red-skills",
      sandboxesWithImage: [],
      trust: { author: "stranger", authorSourceTrust: "dubious", readyForAgentActor: "alice" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(trace.runAgentCalls).toEqual([]);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+ready-for-human"]);
    expect(
      trace.comments.some((c) =>
        /sandbox image 'sandcastle:red-skills' is missing for docker — build it first with: sandcastle docker build-image --image-name sandcastle:red-skills/.test(
          c.body,
        ),
      ),
    ).toBe(true);
    expect(trace.released).toEqual([9]);
  });

  it("prefers the backend that already has the image (#2340)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      sandboxMode: "none",
      availableSandboxes: ["docker", "podman"],
      sandboxImage: "sandcastle:red-skills",
      sandboxesWithImage: ["podman"],
      trust: { author: "stranger", authorSourceTrust: "dubious", readyForAgentActor: "alice" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls[0]?.sandboxMode).toBe("podman");
  });

  it("keeps trusted-author sandbox resolution unchanged", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      sandboxMode: "none",
      availableSandboxes: ["docker"],
      trust: { author: "alice", authorSourceTrust: "trusted", readyForAgentActor: "alice" },
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.runAgentCalls[0]?.sandboxMode).toBe("none");
  });
});


describe("processIssue — trust gate (#621)", () => {
  const ALLOW: ConfigValues = { "afk.trust-gate.allowlist": "alice,bob" };

  it("refuses a non-executable issue BEFORE any claim edit / worktree, with a clear log line", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "stranger", readyForAgentActor: "alice" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // No promotion edit, no agent spawn — refused before any work.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.runAgentCalls).toEqual([]);
    // Claim lock released so the slot is not leaked.
    expect(trace.released).toEqual([9]);
    // A clear, attributable log line names the gate + the reason.
    expect(trace.iterLogs.some((l) => /trust gate refused #9.*untrusted author 'stranger'/.test(l))).toBe(true);
  });

  it("refuses when ready-for-agent was applied by a non-allowlisted actor", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      trust: { author: "alice", readyForAgentActor: "github-actions[bot]" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.iterLogs.some((l) => /trust gate refused.*github-actions\[bot\]/.test(l))).toBe(true);
  });

  it("claims normally when author AND label actor are both allowlisted", async () => {
    const { deps, input, trace } = harness({
      config: ALLOW,
      outcome: "done",
      feedbackOk: true,
      trust: { author: "alice", readyForAgentActor: "bob" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // The promotion-to-running claim edit ran (the gate passed).
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("is permissive when no allowlist is configured — the gate never fires even with an untrusted author", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      trust: { author: "stranger", readyForAgentActor: "anybody" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.iterLogs.some((l) => /trust gate/.test(l))).toBe(false);
  });
});


describe("processIssue — visibility-aware default (#1101)", () => {
  it("PUBLIC repo + no allowlist + untrusted author → held for summon (claim-lost)", async () => {
    const { deps, input, trace } = harness({
      visibility: "public",
      maintainers: ["maint"],
      trust: { author: "stranger", readyForAgentActor: "maint" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    // No promotion edit, no agent spawn — held before any work.
    expect(trace.labelEdits).toEqual([]);
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.released).toEqual([9]);
    expect(
      trace.iterLogs.some((l) => /trust gate refused #9 \[fail-closed\].*untrusted author/.test(l)),
    ).toBe(true);
  });

  it("PUBLIC repo + no allowlist + maintainer author & promoter → claims normally", async () => {
    const { deps, input, trace } = harness({
      visibility: "public",
      maintainers: ["maint", "maint2"],
      outcome: "done",
      feedbackOk: true,
      trust: { author: "maint", readyForAgentActor: "maint2" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("PRIVATE repo + no allowlist → permissive default preserved (untrusted author still runs)", async () => {
    const { deps, input, trace } = harness({
      visibility: "private",
      maintainers: ["maint"],
      outcome: "done",
      feedbackOk: true,
      trust: { author: "stranger", readyForAgentActor: "anybody" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.iterLogs.some((l) => /trust gate/.test(l))).toBe(false);
  });

  it("PUBLIC repo + configured allowlist → strict allowlist gate, not fail-closed", async () => {
    const { deps, input, trace } = harness({
      config: { "afk.trust-gate.allowlist": "alice,bob" },
      visibility: "public",
      maintainers: ["maint"], // a maintainer NOT in the allowlist is still refused
      trust: { author: "maint", readyForAgentActor: "maint" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.iterLogs.some((l) => /trust gate refused #9 \[strict\]/.test(l))).toBe(true);
  });
});

describe("processIssue — origin:external claim gate (#2603)", () => {
  it("HOLDS an unapproved origin:external issue as ready-for-human before any work", async () => {
    const { deps, input, trace } = harness({
      labels: ["ready-for-agent", "origin:external"],
      // No /approve-external markers → the issue stays unapproved and is held.
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    // Parked ready-for-human, ready-for-agent shed, no agent spawn, claim released.
    expect(trace.runAgentCalls).toEqual([]);
    expect(
      trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.remove.includes("ready-for-agent")),
    ).toBe(true);
    expect(trace.labelEdits.some((e) => e.add.includes("running"))).toBe(false);
    expect(trace.released).toEqual([9]);
    expect(trace.comments.some((c) => /external-origin gate/.test(c.body))).toBe(true);
    expect(trace.iterLogs.some((l) => /external-origin gate held #9/.test(l))).toBe(true);
  });

  it("HOLDS when the only /approve-external author lacks write access (public repo)", async () => {
    const { deps, input, trace } = harness({
      labels: ["ready-for-agent", "origin:external"],
      visibility: "public",
      maintainers: ["maint"],
      trust: { author: "stranger", readyForAgentActor: "maint" },
      externalApprovalActors: ["random-drive-by"], // not a maintainer → does not release
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    expect(trace.runAgentCalls).toEqual([]);
    expect(
      trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.remove.includes("ready-for-agent")),
    ).toBe(true);
  });

  it("RELEASES an origin:external issue approved by a write-access maintainer", async () => {
    const { deps, input, trace } = harness({
      labels: ["ready-for-agent", "origin:external"],
      visibility: "public",
      maintainers: ["maint", "maint2"],
      outcome: "done",
      feedbackOk: true,
      // external author, maintainer promoter, and a maintainer /approve-external
      // vouches for the author on the fail-closed path.
      trust: { author: "stranger", readyForAgentActor: "maint2" },
      externalApprovalActors: ["maint"],
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.labelEdits[0]!.add).toEqual(["running"]);
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("does not fire for a non-external issue (regression guard)", async () => {
    const { deps, input, trace } = harness({
      labels: ["ready-for-agent"],
      outcome: "done",
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.comments.some((c) => /external-origin gate/.test(c.body))).toBe(false);
    expect(trace.runAgentCalls).toHaveLength(1);
  });
});


describe("processIssue — lane-aware claim provenance (#2602)", () => {
  it("resolves the promoter from the lane:go label (a lane:go issue never carries ready-for-agent)", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      feedbackOk: true,
      trust: { author: "maint", readyForAgentActor: "maint" },
    });
    await processIssue(deps, input);
    // The claim reads provenance under the lane label the issue was selected
    // under, not a hardcoded `ready-for-agent` that a lane:go issue never has.
    expect(trace.issueTrustCalls).toEqual(["lane:go"]);
  });

  it("scout lane resolves provenance under lane:scout", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:scout"],
      laneLabel: "lane:scout",
      runMode: "scout",
      outcome: "done",
      trust: { author: "maint", readyForAgentActor: "maint" },
    });
    await processIssue(deps, input);
    expect(trace.issueTrustCalls).toEqual(["lane:scout"]);
  });

  it("/afk defaults the promoter label to ready-for-agent (unchanged fleet behaviour)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      trust: { author: "maint", readyForAgentActor: "maint" },
    });
    await processIssue(deps, input);
    expect(trace.issueTrustCalls).toEqual(["ready-for-agent"]);
  });

  it("PUBLIC repo + fail-closed + lane:go minted by a maintainer → executable", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      visibility: "public",
      maintainers: ["maint"],
      outcome: "done",
      feedbackOk: true,
      // Provenance the lane-aware resolver returns: the lane:go applier IS the
      // maintainer minter, so the fail-closed promoter check passes.
      trust: { author: "maint", readyForAgentActor: "maint" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(1);
  });

  it("PUBLIC repo + fail-closed + lane:go applied by an untrusted actor → still refused", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      visibility: "public",
      maintainers: ["maint"],
      trust: { author: "maint", readyForAgentActor: "stranger" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("claim-lost");
    expect(trace.runAgentCalls).toEqual([]);
    expect(
      trace.iterLogs.some((l) => /trust gate refused #9 \[fail-closed\].*promoter/.test(l)),
    ).toBe(true);
  });
});

describe("processIssue — claim sheds stale blocked:* on promote to running (#402)", () => {
  it("removes every blocked:* label the issue carried in the SAME claim edit", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      // A ready-for-agent issue that still drags two stale typed blocks.
      labels: ["ready-for-agent", "blocked:stalled", "blocked:dependency"],
    });
    await processIssue(deps, input);
    // The first edit is the claim: promote to running while removing
    // ready-for-agent AND both blocked:* reasons — one atomic edit, so no live
    // issue is ever `running` together with `blocked:*`.
    const claimEdit = trace.labelEdits[0]!;
    expect(claimEdit.add).toEqual(["running"]);
    expect(claimEdit.remove).toContain("ready-for-agent");
    expect(claimEdit.remove).toContain("blocked:stalled");
    expect(claimEdit.remove).toContain("blocked:dependency");
  });

  it("removes only the blocked:* labels actually present (never asks gh to drop absent ones)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent"],
    });
    await processIssue(deps, input);
    const claimEdit = trace.labelEdits[0]!;
    // No blocked:* present → the claim edit is the plain promotion, unchanged.
    expect(claimEdit.remove).toEqual(["ready-for-agent"]);
    expect(claimEdit.add).toEqual(["running"]);
  });
});


describe("processIssue — pre_worktree hook abort (BOUNDED-recoverable: policy)", () => {
  it("under the cap → RETRY: restores ready-for-agent and never runs the agent", async () => {
    // policy cap is 1 by default; raise it so attempt 1 is under-cap and retries.
    const { deps, input, trace } = harness({
      abortHook: "pre_worktree",
      attempt: 1,
      recoveryEnv: { RED_AFK_RETRY_POLICY: "2" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("hook-aborted");
    expect(result.preserved).toBe(true);
    // claim then CLEAN restore of ready-for-agent (#402: no blocked:* on a
    // re-queue); sandcastle was never invoked.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    const haEdit = trace.labelEdits.at(-1)!;
    expect(haEdit.add).toContain("ready-for-agent");
    expect(haEdit.add).not.toContain("blocked:policy");
    expect(trace.ensuredLabels).not.toContain("blocked:policy");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.mergeCalls).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    expect(result.hooksFired).toEqual(["pre_worktree"]);
    // the restore comment is posted on retry; no budget-exhausted page.
    expect(trace.comments.some((c) => /Restored `ready-for-agent`/.test(c.body))).toBe(true);
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
  });

  it("at the cap → ESCALATE: routes to ready-for-human + posts the budget-exhausted page", async () => {
    // default policy cap is 1, so attempt 1 is at-cap → escalate.
    const { deps, input, trace } = harness({ abortHook: "pre_worktree", attempt: 1 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("hook-aborted");
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-human+blocked:policy"]);
    const haEdit = trace.labelEdits.at(-1)!;
    expect(haEdit.add).toContain("ready-for-human");
    expect(haEdit.add).toContain("blocked:policy");
    expect(trace.ensuredLabels).toContain("blocked:policy");
    expect(trace.runAgentCalls).toEqual([]);
    expect(trace.mergeCalls).toEqual([]);
    expect(trace.pushedAttempt).toEqual([]);
    // the budget-exhausted page is posted; the restore comment is not.
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:policy retry budget exhausted \(attempt 1\/1\)/.test(c.body),
      ),
    ).toBe(true);
    expect(trace.comments.some((c) => /Restored `ready-for-agent`/.test(c.body))).toBe(false);
  });
});


describe("processIssue — runner exhaustion (no --fallback-runner)", () => {
  it("a single exhaustion is terminal: outcome exhausted, ready-for-agent restored, claim released", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("exhausted");
    expect(result.preserved).toBe(true);
    expect(result.swept).toBe(false);
    // only one run; no swap.
    expect(trace.runAgentCalls.length).toBe(1);
    // claim → running, then CLEAN restore of ready-for-agent (not ready-for-human),
    // with NO blocked:quota tag riding the re-queue (#402).
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    const exEdit = trace.labelEdits.at(-1)!;
    expect(exEdit.add).toContain("ready-for-agent");
    expect(exEdit.add).not.toContain("blocked:quota");
    expect(trace.ensuredLabels).not.toContain("blocked:quota");
    expect(trace.closed).toEqual([]);
    expect(trace.released).toEqual([9]);
    // no post_attempt fired (exhaustion is terminal before the sentinel branch).
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt"]);
  });
});


describe("processIssue — runner exhaustion → fallback swap → retry", () => {
  it("swaps claude→codex on exhaustion, fires post_attempt(exhausted)+pre_attempt again, then succeeds", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      fallbackRunner: true,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    // two runs: first claude (exhausted), second codex (done).
    expect(trace.runAgentCalls.length).toBe(2);
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    expect(trace.runAgentCalls[1]?.runner).toBe("codex");
    // both runs target the same worker branch + handoff (reused mid-issue).
    expect(trace.runAgentCalls[1]?.branch).toBe(trace.runAgentCalls[0]?.branch);
    expect(trace.runAgentCalls[1]?.handoffPath).toBe(trace.runAgentCalls[0]?.handoffPath);
    // the fallback run re-anchors at the same attempt dir cwd.
    expect(trace.runAgentCalls[1]?.cwd).toBe(trace.runAgentCalls[0]?.cwd);
    expect(trace.runAgentCalls[1]?.cwd).toBe("/tmp/afk/workers/wAAAA/9-a1");
    // per-runner cadence: pre_attempt fires twice, post_attempt twice
    // (exhausted close + terminal success), bracketing pre_merge/post_merge.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt", // exhausted attempt cycle closes
      "pre_attempt", // second firing for the swapped runner (#226)
      "post_attempt", // terminal success
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
    // the issue closed green.
    expect(trace.closed).toEqual([9]);
  });

  it("double-exhaustion (both runners) is terminal → outcome exhausted", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "exhausted"],
      fallbackRunner: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("exhausted");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls.length).toBe(2);
    // ready-for-agent restored CLEAN (both-runners comment posted); #402: no
    // blocked:quota tag rides the re-queue, claim released.
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.ensuredLabels).not.toContain("blocked:quota");
    expect(trace.released).toEqual([9]);
    expect(trace.closed).toEqual([]);
    // both attempts closed their post_attempt cycle; no merge ever reached.
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_attempt",
      "post_attempt",
    ]);
  });

  it("resolves a fresh model and effort for the fallback runner", async () => {
    const tiers: Array<{ runner: string; taskClass: string | undefined }> = [];
    const { deps, input, trace } = harness({
      outcomes: ["exhausted", "done"],
      fallbackRunner: true,
      feedbackOk: true,
      classifyIssue: async () => "simple",
      resolveTier: (runner, taskClass) => {
        tiers.push({ runner, taskClass });
        return runner === "codex"
          ? { model: "gpt-fallback", effort: "medium" }
          : { model: "claude-primary", effort: "high" };
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(tiers).toEqual([
      { runner: "claude", taskClass: "simple" },
      { runner: "codex", taskClass: "simple" },
    ]);
    expect(trace.runAgentCalls[0]?.model).toBe("claude-primary");
    expect(trace.runAgentCalls[0]?.effort).toBe("high");
    expect(trace.runAgentCalls[1]?.model).toBe("gpt-fallback");
    expect(trace.runAgentCalls[1]?.effort).toBe("medium");
  });
});


describe("processIssue — runner transient transport/setup failure", () => {
  it("routes through bounded recovery without throwing a worker crash", async () => {
    const { deps, input, trace } = harness({ outcome: "runner-transient", fallbackRunner: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("runner-transient");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls.length).toBe(1);
    expect(labelTrace(trace)).toEqual(["-ready-for-agent|+running", "-running|+ready-for-agent"]);
    expect(trace.ensuredLabels).not.toContain("blocked:runner-transient");
    expect(trace.released).toEqual([9]);
    expect(trace.closed).toEqual([]);
    expect(trace.comments.some((c) => /transient transport\/setup failure/.test(c.body))).toBe(true);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt"]);
  });

  it("uses --fallback-runner once before terminating the issue", async () => {
    const { deps, input, trace } = harness({
      outcomes: ["runner-transient", "done"],
      fallbackRunner: true,
      feedbackOk: true,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls.length).toBe(2);
    expect(trace.runAgentCalls[0]?.runner).toBe("claude");
    expect(trace.runAgentCalls[1]?.runner).toBe("codex");
    expect(result.hooksFired).toEqual([
      "pre_worktree",
      "pre_attempt",
      "post_attempt",
      "pre_attempt",
      "post_attempt",
      "pre_feedback",
      "post_feedback",
      "pre_merge",
      "post_merge",
    ]);
    expect(trace.closed).toEqual([9]);
  });
});

describe("processIssue — fatal host configuration", () => {
  it("runs once, never falls back, and escalates with an actionable host-config label", async () => {
    const { deps, input, trace } = harness({ outcome: "host-config", fallbackRunner: true });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("host-config");
    expect(result.preserved).toBe(true);
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(labelTrace(trace)).toEqual([
      "-ready-for-agent|+running",
      "-running|+ready-for-human+blocked:host-config",
    ]);
    expect(trace.ensuredLabels).toContain("blocked:host-config");
    expect(trace.postedEnvelopes).toEqual([{ issue: 9, status: "blocked" }]);
    expect(trace.released).toEqual([9]);
    expect(result.hooksFired).toEqual(["pre_worktree", "pre_attempt", "post_attempt"]);
    expect(trace.bodyEdits[0]?.body).toContain("kind: host-config");
    expect(trace.bodyEdits[0]?.body).toContain("Install or restore the required shell");
  });
});


describe("processIssue — base reaches sandcastle (ADR 0031)", () => {
  it("fetches the resolved base and forks the worker branch off it (not HEAD)", async () => {
    const fetchedBases: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true, // lock value "main" → base resolves to main
      fetchedBases,
    });
    const result = await processIssue(deps, input);

    expect(result.base).toBe("main");
    // the base ref is fetched current before the run (ADR 0031 caller contract).
    expect(fetchedBases).toEqual(["main"]);
    // runAgent receives the remote-tracking ref so sandcastle forks from the
    // freshly-fetched ref, not the potentially-stale local branch.
    expect(trace.runAgentCalls[0]?.base).toBe("red-trunk");
  });

  it("resolves feedback scopes from the fetched origin base, not a stale local base", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      packageScopes: ["packages/stale", "packages/fresh"],
      changedFilesByBase: {
        main: ["packages/stale/src/old.ts"],
        "red-trunk": ["packages/fresh/src/new.ts"],
      },
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.changedFileCalls).toContainEqual({
      branch: "afk/9-fix-the-thing",
      base: "red-trunk",
    });
    const pnpmDirs = trace.pnpmArgs
      .map((args) => {
        const idx = args.indexOf("-C");
        return idx >= 0 ? args[idx + 1] : undefined;
      })
      .filter(Boolean);
    expect(pnpmDirs).toContain("afk/9-fix-the-thing/packages/fresh");
    expect(pnpmDirs).not.toContain("afk/9-fix-the-thing/packages/stale");
  });

  it("resolves an unlocked, pinless issue to the configured Trunk and forks off red-trunk", async () => {
    const fetchedBases: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: false,
      configTrunk: "develop",
      fetchedBases,
    });
    const result = await processIssue(deps, input);

    expect(result.base).toBe("develop");
    // the trunk is fetched current before the run and projected through the
    // fleet-owned mirror, never the primary checkout's local branch.
    expect(fetchedBases).toEqual(["develop"]);
    expect(trace.runAgentCalls[0]?.base).toBe("red-trunk");
  });
});


describe("processIssue — merge-conflict one-shot self-resolve (gap 3)", () => {
  it("recovers a locked merge conflict via the resolver and closes done", async () => {
    const resolverCalls: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1, // landMerge's merge --no-ff conflicts
      conflictResolve: "resolve",
      resolverCalls,
    });
    const result = await processIssue(deps, input);
    // the resolver was dispatched with a conflict-resolver prompt.
    expect(resolverCalls).toHaveLength(1);
    expect(resolverCalls[0]).toContain("merge-conflict resolver");
    // resolved → the issue lands done, not ready-for-human.
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(false);
  });

  it("falls back to ready-for-human when the resolver cannot resolve the conflict (at the cap)", async () => {
    // merge-conflict cap is 3; run at attempt 3 (at-cap) so the unresolved
    // conflict ESCALATES to a human rather than re-queuing.
    const resolverCalls: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      conflictResolve: "fail",
      resolverCalls,
      attempt: 3,
    });
    const result = await processIssue(deps, input);
    expect(resolverCalls).toHaveLength(1);
    expect(result.outcome).toBe("merge-conflict");
    // unresolved + at-cap → ready-for-human + the typed blocked:merge-conflict tag,
    // issue not closed.
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(true);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:merge-conflict"))).toBe(true);
    expect(trace.ensuredLabels).toContain("blocked:merge-conflict");
    expect(trace.closed).not.toContain(9);
  });

  it("escalates to ready-for-human when no resolver is registered (at the cap)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      attempt: 3, // at the merge-conflict cap → escalate
      // conflictResolve undefined → deps.conflictResolver is undefined
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human"))).toBe(true);
  });
});

describe("processIssue — /afk post-DONE gate-correction convergence (#2285)", () => {
  it("retries an empty-diff DONE up to stallConvergenceBudget, then parks with convergence note", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      changedFilesSequence: [[], []],
      feedbackOk: true,
      stallConvergenceBudget: 1,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("<afk-gate-correction>");
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("bounded correction retry 1/1");
    expect(trace.envelopeBodies.at(-1) ?? "").toContain("Post-DONE gate-correction budget exhausted");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.closed).toEqual([]);
  });

  it("lands when a gate-correction retry produces a diff", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      changedFilesSequence: [[], ["packages/x/src/a.ts"]],
      feedbackOk: true,
      stallConvergenceBudget: 1,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.runAgentCalls[1]?.handoffContent).toContain("<afk-gate-correction>");
    expect(trace.closed).toEqual([9]);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(false);
  });

  it("retries a red feedback gate up to stallConvergenceBudget, then parks; handoff carries <afk-gate-correction>", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, false],
      stallConvergenceBudget: 1,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    const retryHandoff = trace.runAgentCalls[1]?.handoffContent ?? "";
    expect(retryHandoff).toContain("<afk-gate-correction>");
    expect(retryHandoff).toContain("feedback machine gate failed after DONE");
    expect(trace.envelopeBodies.at(-1) ?? "").toContain("Post-DONE gate-correction budget exhausted");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.closed).toEqual([]);
  });

  it("lands when a feedback gate-correction retry makes the gate green", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackResults: [false, true],
      stallConvergenceBudget: 2,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.runAgentCalls).toHaveLength(2);
    expect(trace.closed).toEqual([9]);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(false);
  });

  it("retries a red backpressure gate up to stallConvergenceBudget, then parks", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      backpressureCommands: ["npm run e2e"],
      backpressureOk: false,
      stallConvergenceBudget: 1,
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(2);
    const retryHandoff = trace.runAgentCalls[1]?.handoffContent ?? "";
    expect(retryHandoff).toContain("<afk-gate-correction>");
    expect(retryHandoff).toContain("backpressure machine gate failed after DONE");
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-human") && e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.closed).toEqual([]);
  });

  it("go lane ignores stallConvergenceBudget — retryAfkMachineGate is a no-op for lane:go", async () => {
    const { deps, input, trace } = harness({
      labels: ["lane:go"],
      laneLabel: "lane:go",
      outcome: "done",
      feedbackResults: [false],
      recoveryEnv: { RED_GO_VERIFY_RETRIES: "0" },
      stallConvergenceBudget: 99,
    });
    const result = await processIssue(deps, input);

    // go lane with cap=0 parks on first failure; stallConvergenceBudget has no effect
    expect(result.outcome).toBe("feedback-failed");
    expect(trace.runAgentCalls).toHaveLength(1);
    expect(trace.labelEdits.some((e) => e.add.includes("blocked:validation"))).toBe(true);
    expect(trace.closed).toEqual([]);
  });
});
