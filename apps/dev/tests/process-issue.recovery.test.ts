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
describe("processIssue — BOUNDED auto-recovery routing (the policy wired in)", () => {
  it("merge-conflict at attempt 1 (< cap 3) → RETRY: CLEAN ready-for-agent, no blocked:* tag, no page (#402)", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1, // merge --no-ff conflicts; no resolver registered
      attempt: 1,
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-agent");
    // #402: a re-queue routes back CLEAN — no blocked:* rides the promotion.
    expect(edit.add).not.toContain("blocked:merge-conflict");
    expect(edit.add).not.toContain("ready-for-human");
    expect(trace.ensuredLabels).not.toContain("blocked:merge-conflict");
    // a retry never pages; no budget-exhausted comment.
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    expect(trace.closed).not.toContain(9);
  });

  it("merge-conflict at attempt = cap (3) → ESCALATE: ready-for-human + blocked:merge-conflict + budget-exhausted page", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      attempt: 3,
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:merge-conflict");
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:merge-conflict retry budget exhausted \(attempt 3\/3\)/.test(c.body),
      ),
    ).toBe(true);
  });

  it("merge-conflict at worker-local attempt 1 but 2 prior ledgered land-heals → ESCALATE (#2576: cap survives worker replacement)", async () => {
    // The 2026-07-23 incidents: every replacement worker restarts at attempt 1,
    // so the worker-local cap never trips and identical land-failed cycles loop
    // 100+ times. The ADR 0122 heal ledger supplies the durable per-issue count.
    // The harness clock is nowEpoch()=1000 (seconds) → the ledger window filter
    // compares against 1000*1000 ms; prior heals must sit just before that.
    const NOW_MS = 1000 * 1000;
    const ledger = {
      value: { version: 1 as const, issues: { "9": [NOW_MS - 120_000, NOW_MS - 60_000] } },
      async read() {
        return this.value;
      },
      async write(v: typeof this.value) {
        this.value = v;
      },
    };
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      attempt: 1,
    });
    (deps as { healLedger?: unknown }).healLedger = ledger;
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("merge-conflict");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:merge-conflict");
    // The heal was recorded — 3 entries now, budget consumed durably.
    expect(ledger.value.issues["9"]).toHaveLength(3);
  });

  it("quota (exhausted) at attempt < cap → RETRY: CLEAN ready-for-agent, no blocked:* tag (#402)", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false, attempt: 2 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-agent");
    expect(edit.add).not.toContain("blocked:quota");
    expect(edit.add).not.toContain("ready-for-human");
    expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
  });

  it("quota (exhausted) at attempt = cap (3) → ESCALATE: ready-for-human + blocked:quota + budget-exhausted page", async () => {
    const { deps, input, trace } = harness({ outcome: "exhausted", fallbackRunner: false, attempt: 3 });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("exhausted");
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).toContain("blocked:quota");
    expect(
      trace.comments.some((c) =>
        /escalating to ready-for-human: blocked:quota retry budget exhausted \(attempt 3\/3\)/.test(c.body),
      ),
    ).toBe(true);
  });

  it("crashed (no-sentinel) RETRIES once then escalates (cap 1)", async () => {
    // cap 1: attempt 1 is at-cap → escalate. Raise to 2 to see the single retry.
    // changedFiles:[] = a real crash (empty branch), so the no-sentinel salvage
    // (issue #332) does NOT apply and the crash-retry path is exercised.
    const retry = harness({ outcome: "no-sentinel", attempt: 1, changedFiles: [], recoveryEnv: { RED_AFK_RETRY_CRASH: "2" } });
    const r1 = await processIssue(retry.deps, retry.input);
    expect(r1.outcome).toBe("no-sentinel");
    expect(retry.trace.labelEdits.at(-1)!.add).toContain("ready-for-agent");
    // #402: clean re-queue — the crash reason no longer tags the ready-for-agent promotion.
    expect(retry.trace.labelEdits.at(-1)!.add).not.toContain("blocked:crashed");

    const escalate = harness({ outcome: "no-sentinel", attempt: 1, changedFiles: [] }); // default cap 1 → escalate
    const r2 = await processIssue(escalate.deps, escalate.input);
    expect(r2.outcome).toBe("no-sentinel");
    expect(escalate.trace.labelEdits.at(-1)!.add).toContain("ready-for-human");
    expect(escalate.trace.labelEdits.at(-1)!.add).toContain("blocked:crashed");
  });

  it("spec (BLOCKED) ALWAYS escalates to ready-for-human, even at attempt 1 and high attempts", async () => {
    for (const attempt of [1, 5, 99]) {
      const { deps, input, trace } = harness({ outcome: "blocked", attempt });
      const result = await processIssue(deps, input);
      expect(result.outcome).toBe("blocked");
      const edit = trace.labelEdits.at(-1)!;
      expect(edit.add).toContain("ready-for-human");
      expect(edit.add).toContain("blocked:spec");
      expect(edit.add).not.toContain("ready-for-agent");
      // non-recoverable → no budget-exhausted page (it was never auto-recovering).
      expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    }
  });

  it("validation (feedback-failed) ALWAYS escalates to ready-for-human", async () => {
    for (const attempt of [1, 5, 99]) {
      const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false, attempt });
      const result = await processIssue(deps, input);
      expect(result.outcome).toBe("feedback-failed");
      const edit = trace.labelEdits.at(-1)!;
      expect(edit.add).toContain("ready-for-human");
      expect(edit.add).toContain("blocked:validation");
      expect(edit.add).not.toContain("ready-for-agent");
      expect(trace.comments.some((c) => /retry budget exhausted/.test(c.body))).toBe(false);
    }
  });
});


describe("close cascade (event-driven auto-unblock)", () => {
  it("promotes a dependent whose req:* deps are all closed, leaves a still-blocked one", async () => {
    // Issue 9 closes. Two open dependents carry req:9:
    //   #20 has req:9 only → all closed → promote
    //   #21 has req:9 + req:8 (8 still open) → stays blocked:dependency
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      dependentsByLabel: {
        "req:9": [
          { number: 20, labels: ["blocked:dependency", "req:9"] },
          { number: 21, labels: ["blocked:dependency", "req:9", "req:8"] },
        ],
      },
      closedIssues: [], // #8 is NOT closed; #9 is known-closed implicitly
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.closed).toContain(9);
    // queried the req:9 dependents exactly once.
    expect(trace.listByLabelCalls).toEqual(["req:9"]);

    const promote = trace.labelEdits.filter((e) => e.add.includes("ready-for-agent"));
    expect(promote).toEqual([{ issue: 20, remove: ["blocked:dependency", "req:9"], add: ["ready-for-agent"] }]);
    expect(trace.comments).toContainEqual({
      issue: 20,
      body: "🤖 /afk unblocked: all dependencies closed (#9).",
    });
    // #21 is never promoted nor commented (req:8 still open).
    expect(trace.labelEdits.some((e) => e.issue === 21)).toBe(false);
    expect(trace.comments.some((c) => c.issue === 21)).toBe(false);
  });

  it("names every now-satisfied dep when a multi-req dependent fully unblocks", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      dependentsByLabel: {
        "req:9": [{ number: 30, labels: ["blocked:dependency", "req:9", "req:8"] }],
      },
      closedIssues: [8], // both deps closed (#9 implicit, #8 explicit)
    });
    await processIssue(deps, input);
    expect(trace.comments).toContainEqual({
      issue: 30,
      body: "🤖 /afk unblocked: all dependencies closed (#8, #9).",
    });
    expect(trace.labelEdits).toContainEqual({
      issue: 30,
      remove: ["blocked:dependency", "req:8", "req:9"],
      add: ["ready-for-agent"],
    });
  });

  it("renders close-cascade dependency refs as title+number links when metadata resolves", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      dependentsByLabel: {
        "req:9": [{ number: 20, labels: ["blocked:dependency", "req:9"] }],
      },
      issueRefs: {
        9: {
          title: "Wayfinder fidelity restoration",
          url: "https://github.com/reddb-io/red-skills/issues/9",
        },
      },
    });
    await processIssue(deps, input);
    expect(trace.comments).toContainEqual({
      issue: 20,
      body: "🤖 /afk unblocked: all dependencies closed ([Wayfinder fidelity restoration (#9)](https://github.com/reddb-io/red-skills/issues/9)).",
    });
  });

  it("does nothing when there are no req:N dependents", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    await processIssue(deps, input);
    expect(trace.listByLabelCalls).toEqual(["req:9"]);
    expect(trace.labelEdits.some((e) => e.add.includes("ready-for-agent"))).toBe(false);
  });

  it("does not run the cascade on a non-done (blocked) close", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    expect(trace.listByLabelCalls).toEqual([]);
  });
});

// ---------- ADR 0017: validation.jsonl sidecar + AFK→Memory recording ----------


describe("processIssue — validation.jsonl sidecar (SKILL.md §Validation Sidecar)", () => {
  it("writes the feedback sidecar to <attemptDir>/validation.jsonl on the DONE close", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: true });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.sidecarWrites).toHaveLength(1);
    const write = trace.sidecarWrites[0]!;
    expect(write.path).toBe(`${input.attemptDir}/validation.jsonl`);
    expect(write.lines.length).toBeGreaterThan(0);
    // Each line is a red.afk.validation.v1 JSON record.
    for (const line of write.lines) {
      expect(JSON.parse(line).schema).toBe("red.afk.validation.v1");
    }
  });

  it("writes the sidecar on the feedback-FAILED close too", async () => {
    const { deps, input, trace } = harness({ outcome: "done", feedbackOk: false });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("feedback-failed");
    expect(trace.sidecarWrites).toHaveLength(1);
    expect(trace.sidecarWrites[0]!.path).toBe(`${input.attemptDir}/validation.jsonl`);
    expect(trace.sidecarWrites[0]!.lines.length).toBeGreaterThan(0);
  });

  it("does NOT write a sidecar on a path with no feedback result (BLOCKED)", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });
    await processIssue(deps, input);
    expect(trace.sidecarWrites).toEqual([]);
  });

  it("is a no-op (and the close still succeeds) when the sidecar port is absent", async () => {
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, withSidecarPort: false });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(result.envelopePosted).toBe(true);
  });
});

describe("processIssue — AFK→Brain outcome-event recording", () => {
  it("emits one versioned outcome event for a completed DONE attempt", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "type:bug"],
      classifyIssue: async () => "simple",
      recordOutcomeEvent: "ok",
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(trace.outcomeEvents).toHaveLength(1);
    expect(trace.outcomeEvents[0]).toEqual({
      schemaVersion: 1,
      id: "afk:o/r:9:1",
      emitter: "afk",
      occurredAt: "2026-05-30T00:00:00Z",
      taskClass: "simple",
      chosenOption: {
        kind: "runner",
        runner: "claude",
        model: "claude-opus-4-8",
        effort: "high",
      },
      outcome: "success",
      cost: { signal: "unknown" },
      context: {
        repository: "o/r",
        issueNumber: 9,
        attemptNumber: 1,
        issueType: "bug",
        workerId: "wAAAA",
        branch: "afk/9-fix-the-thing",
        durationMs: 0,
        status: "done",
      },
    });
  });

  it("keeps the DONE close and timing path unchanged when Brain recording throws", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      recordOutcomeEvent: "throw",
    });
    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.envelopePosted).toBe(true);
    expect(result.swept).toBe(true);
    expect(trace.closed).toEqual([9]);
    expect(trace.postedEnvelopes).toContainEqual({ issue: 9, status: "done" });
    expect(trace.outcomeEvents).toEqual([]);
  });

  it("does not wait for a slow Brain recorder before completing DONE", async () => {
    const { deps, input } = harness({
      outcome: "done",
      feedbackOk: true,
      recordOutcomeEvent: "hang",
    });

    const result = await Promise.race([
      processIssue(deps, input),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);

    expect(result).not.toBe("timed-out");
    expect(result).toMatchObject({ outcome: "done", swept: true });
  });
});


describe("processIssue — emitHeartbeat receives resolved base (issue #570)", () => {
  it("passes the resolved non-main base to emitHeartbeat when the issue body pins a branch", async () => {
    const heartbeatInfos: AttemptProgressInfo[] = [];
    const pinBody = "branch: release/v2\n## Agent brief\nDo it.";
    const { deps, input } = harness({ outcome: "done", feedbackOk: true, body: pinBody });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      emitHeartbeat: (info) => heartbeatInfos.push(info),
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(heartbeatInfos).toHaveLength(1);
    expect(heartbeatInfos[0]?.base).toBe("release/v2");
  });

  it("passes main as base when no pin and no lock", async () => {
    const heartbeatInfos: AttemptProgressInfo[] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      emitHeartbeat: (info) => heartbeatInfos.push(info),
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(heartbeatInfos).toHaveLength(1);
    expect(heartbeatInfos[0]?.base).toBe("main");
  });
});


describe("processIssue — new lifecycle checkpoints (#832)", () => {
  it("on_heartbeat context carries the full worker vitals", async () => {
    const stdins: string[] = [];
    const { deps, input } = harness({ outcome: "done", feedbackOk: true });
    const vitals = {
      tools_called_count: 7,
      text_chunk_count: 3,
      reasoning_events: 2,
      reasoning_tokens: 128,
      waiting_count: 1,
      input_tokens: 900,
      output_tokens: 450,
      cost_usd: 0.12,
      loc_added: 40,
      loc_removed: 5,
    };
    const customDeps: ProcessIssueDeps = {
      ...deps,
      heartbeatVitals: () => vitals,
      hooks: {
        ...deps.hooks,
        config: { "afk.hooks.on_heartbeat": "hb-cmd" },
        exec: async (command, _env, stdin) => {
          if (command === "hb-cmd") stdins.push(stdin);
          return { code: 0, stdout: "" };
        },
      },
      runAgent: async (ri) => {
        ri.onHeartbeat?.({ head: "abc123", lastProgressMs: 0, nowMs: 0 });
        return {
          outcome: "done",
          branch: ri.branch,
          commits: [{ sha: "deadbee" }],
          completionSignal: "<promise>DONE</promise>",
          stdout: "",
        };
      },
    };
    await processIssue(customDeps, input);
    expect(stdins).toHaveLength(1);
    const ctx = JSON.parse(stdins[0]!) as { vitals?: Record<string, number> };
    expect(ctx.vitals).toEqual(vitals);
  });

  it("on_recovery_decision (mutable) overrides retry→escalate", async () => {
    // pre_worktree abort routes through routeRecovery("hook-aborted"), bounded-
    // recoverable → RETRY under a raised cap. A hook returning {"decision":
    // "escalate"} forces the human gate instead of the clean re-queue.
    const { deps, input, trace } = harness({
      abortHook: "pre_worktree",
      attempt: 1,
      recoveryEnv: { RED_AFK_RETRY_POLICY: "2" },
    });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      hooks: {
        ...deps.hooks,
        config: {
          "afk.hooks.pre_worktree": "abort:pre_worktree",
          "afk.hooks.on_recovery_decision": "dec",
        },
        exec: async (command) => {
          if (command === "abort:pre_worktree") return { code: 1, stdout: "" };
          if (command === "dec") return { code: 0, stdout: JSON.stringify({ decision: "escalate" }) };
          return { code: 0, stdout: "" };
        },
      },
    };
    await processIssue(customDeps, input);
    const edit = trace.labelEdits.at(-1)!;
    expect(edit.add).toContain("ready-for-human");
    expect(edit.add).not.toContain("ready-for-agent");
  });

  it("on_blocked fires when an issue is parked to the human gate", async () => {
    // Default policy cap (1) → attempt 1 escalates, so the issue is parked to a
    // human gate and the on_blocked hook fires with the typed blocked label.
    const commands: string[] = [];
    const { deps, input } = harness({ abortHook: "pre_worktree", attempt: 1 });
    const customDeps: ProcessIssueDeps = {
      ...deps,
      hooks: {
        ...deps.hooks,
        config: {
          "afk.hooks.pre_worktree": "abort:pre_worktree",
          "afk.hooks.on_blocked": "blk",
        },
        exec: async (command, env) => {
          commands.push(command);
          if (command === "blk") {
            // The typed blocked:* label rides the env (RED_AFK_BLOCKED_LABEL).
            expect(env.RED_AFK_BLOCKED_LABEL).toBe("blocked:policy");
            return { code: 0, stdout: "" };
          }
          if (command === "abort:pre_worktree") return { code: 1, stdout: "" };
          return { code: 0, stdout: "" };
        },
      },
    };
    await processIssue(customDeps, input);
    expect(commands).toContain("blk");
  });
});

// ---------- scout mode (fleet-native read-only dispatch, issue #991) ----------


describe("processIssue — scout mode (runMode: 'scout')", () => {
  it("uses SCOUT_EXIT_PROTOCOL as the system prompt (read-only handoff)", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "done" });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.systemPrompt).toBe(SCOUT_EXIT_PROTOCOL);
  });

  it("disables continuous push — no-commit sandbox config", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "done" });
    await processIssue(deps, input);
    expect(trace.runAgentCalls[0]?.continuousPush).toBe(false);
  });

  it("posts the agent's text output as a scout report comment and closes the issue", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "done" });
    await processIssue(deps, input);
    const report = trace.comments.find((c) => c.issue === 9 && c.body.includes("Scout Report"));
    expect(report).toBeDefined();
    expect(trace.closed).toContain(9);
  });

  it("returns outcome 'done' after a successful scout", async () => {
    const { deps, input } = harness({ runMode: "scout", outcome: "done" });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(result.issue).toBe(9);
  });

  it("does not push a branch to the remote (no worker-branch push)", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "done" });
    await processIssue(deps, input);
    expect(trace.pushedAttempt).toHaveLength(0);
  });

  it("releases the claim lock after a scout completion", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "done" });
    await processIssue(deps, input);
    expect(trace.released).toContain(9);
  });

  it("parks the issue as ready-for-human on no-sentinel (no report)", async () => {
    const { deps, input, trace } = harness({ runMode: "scout", outcome: "no-sentinel", commits: [] });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("no-sentinel");
    const humanLabel = trace.labelEdits.find((e) => e.add.includes("ready-for-human"));
    expect(humanLabel).toBeDefined();
    expect(trace.closed).not.toContain(9);
  });

  it("recovers a scout report when AgentOutput enforcement downgraded a captured DONE stream", async () => {
    const { deps, input, trace } = harness({
      runMode: "scout",
      outcome: "no-sentinel",
      commits: [],
      completionSignal: "<promise>DONE</promise>",
      agentTextEvents: ["# Findings\n\nReport body.\n", "<promise>DONE</promise>"],
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    const report = trace.comments.find((c) => c.issue === 9 && c.body.includes("Scout Report"));
    expect(report?.body).toContain("# Findings");
    expect(report?.body).toContain("Report body.");
    expect(report?.body).not.toContain("<promise>DONE</promise>");
    expect(trace.closed).toContain(9);
    expect(trace.pushedAttempt).toHaveLength(0);
  });
});

// ---------- Spec cascade rebase (#1007) ----------


describe("Spec cascade rebase after DONE landing", () => {
  it("rebases two sibling branches onto the exact landing merge SHA (spec:42)", async () => {
    const rebaseTargets: string[] = [];
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      // Issue 9 carries spec:42 — so after close, AFK should rebase spec:42 siblings.
      labels: ["ready-for-agent", "spec:42"],
      // Two open issues carry spec:42; they are the siblings.
      dependentsByLabel: {
        "spec:42": [
          { number: 20, labels: ["spec:42", "ready-for-agent"] },
          { number: 21, labels: ["spec:42", "ready-for-agent"] },
        ],
      },
      // Two remote afk branches, one for each sibling.
      siblingBranches: [
        "afk/wBBBB/20-fix-sibling-a",
        "afk/wCCCC/21-fix-sibling-b",
      ],
    });
    const rebaseAndPush = deps.cascadeRebase!.rebaseAndPush;
    deps.cascadeRebase!.rebaseAndPush = async (repoDir, branch, target) => {
      rebaseTargets.push(target);
      return await rebaseAndPush(repoDir, branch, target);
    };
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // Both sibling branches were rebased.
    expect(trace.cascadeRebaseAttempts).toEqual([
      "afk/wBBBB/20-fix-sibling-a",
      "afk/wCCCC/21-fix-sibling-b",
    ]);
    expect(rebaseTargets).toEqual(["forge-merge-sha", "forge-merge-sha"]);
    // The spec:42 label lookup fired.
    expect(trace.listByLabelCalls).toContain("spec:42");
    // Each sibling learns on ITS OWN issue that its branch moved (ADR 0118) —
    // the worker log belongs to the landing worker and is unreachable from here.
    for (const sibling of [20, 21]) {
      const posted = trace.comments.filter(
        (c) => c.issue === sibling && c.body.includes("cascade-rebase"),
      );
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body).toContain("forge-merge-sha");
      expect(posted[0]!.body).toContain("#9");
    }
  });

  // #2986: a PR that is merely QUEUED has produced no merge SHA and no merge.
  // Nothing downstream of the landing may run — not the cascade, and above all
  // not the close/cleanup steps that a rejected merge group would strand.
  it("does not close, clean up or cascade while the queued PR still reports merged=false", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        "spec:42": [{ number: 20, labels: ["spec:42", "ready-for-agent"] }],
      },
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
      queueOutcome: "pending",
    });
    deps.nativeMergeQueue = true;

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-pending");
    expect(trace.closed).not.toContain(9);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.cascadeRebaseAttempts).toEqual([]);
  });

  it("parks blocked:ci with the issue and the branch intact when the merge queue rejects the PR", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent"],
      queueOutcome: "rejected",
    });
    deps.nativeMergeQueue = true;

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("ci-failed");
    expect(trace.closed).not.toContain(9);
    expect(trace.deletedRemote).toEqual([]);
    expect(trace.comments.some((c) => c.issue === 9 && c.body.includes("dequeued PR #42"))).toBe(true);
  });

  it("closes and cascades only once the queued PR reports merged=true", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        "spec:42": [{ number: 20, labels: ["spec:42", "ready-for-agent"] }],
      },
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
      queueOutcome: "merged",
    });
    deps.nativeMergeQueue = true;

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("done");
    expect(result.mergeSha).toBe("forge-merge-sha");
    expect(trace.closed).toContain(9);
    expect(trace.cascadeRebaseAttempts).toEqual(["afk/wBBBB/20-fix-sibling-a"]);
  });

  it("skips a sibling branch whose worker is still alive", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        "spec:42": [
          { number: 20, labels: ["spec:42"] },
          { number: 21, labels: ["spec:42"] },
        ],
      },
      siblingBranches: [
        "afk/wBBBB/20-fix-sibling-a",
        "afk/wCCCC/21-fix-sibling-b",
      ],
      // wBBBB is alive — its branch must be skipped.
      liveWorkers: ["wBBBB"],
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    // Only the dead-worker branch is rebased.
    expect(trace.cascadeRebaseAttempts).toEqual(["afk/wCCCC/21-fix-sibling-b"]);
    expect(trace.iterLogs.some((l) => l.includes("wBBBB is alive"))).toBe(true);
    // The skipped sibling is told WHY its branch was left alone, on its own issue.
    const skipped = trace.comments.find((c) => c.issue === 20 && c.body.includes("cascade-rebase"));
    expect(skipped?.body).toContain("was NOT rebased");
    expect(skipped?.body).toContain("wBBBB");
  });

  it("cascade rebase failure is logged as a warning and does not fail the primary landing", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        "spec:42": [{ number: 20, labels: ["spec:42"] }],
      },
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
      cascadeRebaseFail: true,
    });
    const result = await processIssue(deps, input);
    // Primary landing is unaffected.
    expect(result.outcome).toBe("done");
    // rebaseAndPush was still called (the attempt is recorded).
    expect(trace.cascadeRebaseAttempts).toEqual(["afk/wBBBB/20-fix-sibling-a"]);
    // A warning was logged.
    expect(trace.iterLogs.some((l) => l.includes("cascade-rebase warning"))).toBe(true);
    // …and the sibling learns its branch is still on the pre-landing base.
    const failed = trace.comments.find((c) => c.issue === 20 && c.body.includes("cascade-rebase"));
    expect(failed?.body).toContain("could NOT be rebased");
  });

  it("does not rebase when the issue carries no spec:N label", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent"],
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.cascadeRebaseAttempts).toEqual([]);
  });

  it("does not rebase when afk.landing.cascade_rebase is false", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        "spec:42": [{ number: 20, labels: ["spec:42"] }],
      },
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
      config: { "afk.landing.cascade_rebase": "false" },
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("done");
    expect(trace.cascadeRebaseAttempts).toEqual([]);
  });

  it("does not run cascade rebase on a non-done outcome (blocked)", async () => {
    const { deps, input, trace } = harness({
      outcome: "blocked",
      labels: ["ready-for-agent", "spec:42"],
      siblingBranches: ["afk/wBBBB/20-fix-sibling-a"],
    });
    const result = await processIssue(deps, input);
    expect(result.outcome).toBe("blocked");
    expect(trace.cascadeRebaseAttempts).toEqual([]);
  });

  it("skips branches that do not belong to a spec sibling issue", async () => {
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      labels: ["ready-for-agent", "spec:42"],
      dependentsByLabel: {
        // Only issue 20 is a sibling; issue 99 is not listed.
        "spec:42": [{ number: 20, labels: ["spec:42"] }],
      },
      siblingBranches: [
        "afk/wBBBB/20-fix-sibling-a",
        "afk/wCCCC/99-unrelated-branch",
      ],
    });
    await processIssue(deps, input);
    // Only issue 20's branch is rebased; issue 99's is not a sibling.
    expect(trace.cascadeRebaseAttempts).toEqual(["afk/wBBBB/20-fix-sibling-a"]);
  });
});

// ADR 0103: terminal disposition flows through the ENVELOPE alone. No terminal
// path crosses an exit barrier, salvage-commits a dirty worktree, or carries an
// ExitReceipt/TerminalReceipt. One named test per terminal path, resilience-suite
// style — each asserts the SAME two-part invariant: (1) the terminal still
// REPORTS its outcome and PRESERVES the worker branch, (2) it carries NO receipt
// and announces no exit-barrier salvage. A path that re-grew a receipt would
// fail these.

describe("processIssue — terminal disposition without an exit barrier (ADR 0103)", () => {
  const BRANCH = "afk/9-fix-the-thing";
  const noReceipt = (result: object, trace: { iterLogs: string[] }): void => {
    expect("exitReceipt" in result).toBe(false);
    expect(trace.iterLogs.some((l) => l.includes("exit barrier"))).toBe(false);
    expect(trace.iterLogs.some((l) => l.includes("uncommitted file(s)"))).toBe(false);
  };

  it("BLOCKED sentinel reports and preserves the branch — no receipt", async () => {
    const { deps, input, trace } = harness({ outcome: "blocked" });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("blocked");
    expect(result.branch).toBe(BRANCH);
    expect(result.preserved).toBe(true);
    noReceipt(result, trace);
  });

  it("stall-kill (lane-idle reap → no-sentinel) leaves the dirty worktree UNSALVAGED", async () => {
    // With the attempt-progress guard gone (ADR 0103) an in-run stall arrives as
    // the lane-idle reaper's `no-sentinel`; changedFiles:[] means the branch
    // carries no COMMITTED work. The worker was killed with a dirty worktree —
    // that work is disposable now: nothing is salvage-committed on the way out.
    const { deps, input, trace } = harness({ outcome: "no-sentinel", changedFiles: [] });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("no-sentinel");
    expect(result.preserved).toBe(true);
    noReceipt(result, trace);
  });

  it("crash teardown (pre_worktree hook abort) reports without a barrier crossing", async () => {
    const { deps, input, trace } = harness({ abortHook: "pre_worktree" });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("hook-aborted");
    expect(result.preserved).toBe(true);
    noReceipt(result, trace);
  });

  it("merge-conflict terminal preserves the branch without a receipt", async () => {
    // A locked merge that conflicts and cannot be auto-resolved lands on the
    // merge-conflict terminal (mergeFailed).
    const { deps, input, trace } = harness({
      outcome: "done",
      feedbackOk: true,
      locked: true,
      mergeNoFfCode: 1,
      conflictResolve: "fail",
    });

    const result = await processIssue(deps, input);

    expect(result.outcome).toBe("merge-conflict");
    expect(result.preserved).toBe(true);
    noReceipt(result, trace);
  });
});
