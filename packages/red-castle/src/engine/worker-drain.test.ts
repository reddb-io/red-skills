import { describe, expect, it, vi } from "vitest";
import {
  CASTLE_NO_MORE_TASKS,
  matchesWorkSelector,
  runCastleWorkerDrain,
  selectCastleIssues,
  type CastleIssueCandidate,
  type CastleSessionHookName,
  type CastleWorkerDrainPolicy,
  type CastleWorkerOutcome,
} from "./worker-drain.js";
import type { Runner } from "./runner-types.js";
import type { HostCapabilityProfile } from "./host-capability-profile.js";

const boot = { precheck: { ok: true } };
const processDeps = {};

function candidate(
  number: number,
  labels: string[] = ["ready-for-agent"],
): CastleIssueCandidate {
  return {
    number,
    title: `Issue ${number}`,
    body: "",
    labels,
  };
}

interface DrainHarnessOptions {
  candidates?: CastleIssueCandidate[];
  runner?: Runner;
  once?: boolean;
  alternate?: boolean;
  iterCap?: number;
  outcomeFor?: (issue: number) => CastleWorkerOutcome;
  policy?: CastleWorkerDrainPolicy;
  circuitOpenFor?: Runner[];
  processError?: Error;
  onProcess?: () => void;
  dispatchSessionHook?: (
    name: CastleSessionHookName,
    context: string,
  ) => Promise<{ aborted: boolean }>;
  hostProfile?: HostCapabilityProfile;
}

function makeDrainHarness(options: DrainHarnessOptions = {}) {
  const emitted: string[] = [];
  const builtInputs: number[] = [];
  const processedIssues: number[] = [];
  const processedRunners: Runner[] = [];
  const processIssue = vi.fn(
    async (_deps: object, input: { issue: number; runner: Runner }) => {
      processedIssues.push(input.issue);
      processedRunners.push(input.runner);
      options.onProcess?.();
      if (options.processError) throw options.processError;
      return { outcome: options.outcomeFor?.(input.issue) ?? "done" };
    },
  );

  const run = () =>
    runCastleWorkerDrain(
      {
        gh: {
          listCandidates: async () =>
            options.candidates ?? [candidate(1), candidate(2), candidate(3)],
        },
        runBoot: async () => boot,
        bootDeps: {},
        bootOptions: {},
        processIssue,
        processDeps,
        buildProcessInput: (row, ctx) => {
          builtInputs.push(row.number);
          return { issue: row.number, runner: ctx.runner };
        },
        runnerCircuit: options.circuitOpenFor
          ? {
              isOpen: async (runner) =>
                options.circuitOpenFor!.includes(runner),
            }
          : undefined,
        emit: (line) => emitted.push(line),
        dispatchSessionHook: options.dispatchSessionHook,
      },
      {
        runner: options.runner ?? "claude",
        workerId: "wTEST",
        filter: { kind: "all" },
        once: options.once,
        alternate: options.alternate,
        iterCap: options.iterCap,
        issueTemplate: {},
        policy: options.policy,
        hostProfile: options.hostProfile,
      },
    );

  return {
    run,
    emitted,
    builtInputs,
    processedIssues,
    processedRunners,
    processIssue,
  };
}

describe("castle worker drain", () => {
  it("selects urgent first, drops specs, and keeps issue filters ordered", () => {
    const candidates = [
      candidate(30),
      candidate(10, ["ready-for-agent", "priority:urgent"]),
      candidate(20, ["ready-for-agent", "priority:high"]),
      candidate(7, ["ready-for-agent", "type:spec"]),
    ];

    expect(
      selectCastleIssues(candidates, { kind: "all" }).map((row) => row.number),
    ).toEqual([10, 20, 30]);
    expect(
      selectCastleIssues(candidates, { kind: "issues", numbers: [30, 10] }).map(
        (row) => row.number,
      ),
    ).toEqual([10, 30]);
  });

  // #2894 — the lane label, not the absence of `ready-for-agent`, is what keeps
  // an isolated dispatch out of the fleet. A stale promotion must not hand one
  // over, and the lane's own worker must still see it.
  it("hides a lane-isolated issue from the fleet pool even when it carries ready-for-agent", () => {
    const candidates = [
      candidate(10),
      candidate(20, ["ready-for-agent", "lane:go"]),
      candidate(30, ["ready-for-agent", "lane:scout"]),
    ];

    // The fleet lists `ready-for-agent` — neither isolated issue is a candidate.
    expect(
      selectCastleIssues(candidates, { kind: "all" }).map((row) => row.number),
    ).toEqual([10]);
    // Not even when the operator names the number outright: the issue is not in
    // this pool, so `--issues` reports it missing rather than claiming it.
    expect(() => selectCastleIssues(candidates, { kind: "issues", numbers: [20] })).toThrow(
      /declared lane `ready-for-agent`; consulted queue `ready-for-agent`/,
    );

    // A future transport regression must expose the mismatch directly: the
    // declared /go lane and the queue boot actually consulted are both facts.
    expect(() =>
      selectCastleIssues(
        candidates,
        { kind: "issues", numbers: [20] },
        undefined,
        "ready-for-agent",
        "lane:go",
      ),
    ).toThrow(/declared lane `lane:go`; consulted queue `ready-for-agent`/);

    // The `/go` worker lists `lane:go` as its pool and still sees its own issue.
    expect(
      selectCastleIssues(
        candidates,
        { kind: "issues", numbers: [20] },
        undefined,
        "lane:go",
      ).map((row) => row.number),
    ).toEqual([20]);
    // A pool is one lane: the go worker does not inherit the scout's issue.
    expect(
      selectCastleIssues(candidates, { kind: "all" }, undefined, "lane:go").map(
        (row) => row.number,
      ),
    ).toEqual([10, 20]);
  });

  it("ANDs every requested tag facet and excludes untagged candidates outright", () => {
    const both = candidate(1, ["ready-for-agent", "tag:backend", "tag:infra"]);
    const oneOfTwo = candidate(2, ["ready-for-agent", "tag:backend"]);
    const untagged = candidate(3);

    const selector = { tags: ["backend", "infra"] };
    expect(matchesWorkSelector(both, selector)).toBe(true);
    // AND semantics: carrying one of the two requested tags is not enough.
    expect(matchesWorkSelector(oneOfTwo, selector)).toBe(false);
    // Strict untagged exclusion: no tag labels at all → outside every tag scope.
    expect(matchesWorkSelector(untagged, selector)).toBe(false);
  });

  it("matches the user facet against the author case-insensitively and never without one", () => {
    const authored = { ...candidate(1), author: "FilipeForattini" };
    const anonymous = candidate(2);

    expect(matchesWorkSelector(authored, { user: "filipeforattini" })).toBe(true);
    expect(matchesWorkSelector(authored, { user: "gustavo" })).toBe(false);
    expect(matchesWorkSelector(anonymous, { user: "filipeforattini" })).toBe(false);
  });

  it("never prepends an urgent issue that sits outside the tag scope", () => {
    const candidates = [
      candidate(30, ["ready-for-agent", "tag:infra"]),
      candidate(10, ["ready-for-agent", "priority:urgent"]),
    ];

    expect(
      selectCastleIssues(candidates, {
        kind: "selector",
        selector: { tags: ["infra"] },
      }).map((row) => row.number),
    ).toEqual([30]);
  });

  it("runs the castle-owned drain loop through claim/work and preserves progress output", async () => {
    const emitted: string[] = [];
    const processIssue = vi
      .fn()
      .mockResolvedValueOnce({ outcome: "claim-lost" })
      .mockResolvedValueOnce({ outcome: "done" });

    const result = await runCastleWorkerDrain(
      {
        gh: { listCandidates: async () => [candidate(1), candidate(2)] },
        runBoot: async () => boot,
        bootDeps: {},
        bootOptions: {},
        processIssue,
        processDeps,
        buildProcessInput: (row, ctx) => ({
          issue: row.number,
          runner: ctx.runner,
        }),
        emit: (line) => emitted.push(line),
      },
      {
        runner: "codex",
        workerId: "wAB12",
        filter: { kind: "all" },
        once: true,
        issueTemplate: {},
      },
    );

    expect(processIssue).toHaveBeenCalledTimes(2);
    expect(processIssue.mock.calls.map((call) => call[1])).toEqual([
      { issue: 1, runner: "codex" },
      { issue: 2, runner: "codex" },
    ]);
    expect(result).toMatchObject({
      done: 1,
      blocked: 0,
      failed: 1,
      total: 2,
      stopReason: "once",
    });
    expect(emitted).toEqual([
      "progress: 1/2 (50%) — 1 remaining",
      "progress: 2/2 (100%) — 0 remaining",
      "worker stop: once",
    ]);
  });

  it("emits the frozen no-more-tasks sentinel on an empty queue", async () => {
    const emitted: string[] = [];
    const result = await runCastleWorkerDrain(
      {
        gh: { listCandidates: async () => [] },
        runBoot: async () => boot,
        bootDeps: {},
        bootOptions: {},
        processIssue: async () => ({ outcome: "done" }),
        processDeps,
        buildProcessInput: (row, ctx) => ({
          issue: row.number,
          runner: ctx.runner,
        }),
        emit: (line) => emitted.push(line),
      },
      {
        runner: "claude",
        workerId: "wZZ99",
        filter: { kind: "all" },
        issueTemplate: {},
      },
    );

    expect(result.drained).toBe(true);
    expect(result.stopReason).toBe("drain-empty");
    expect(emitted).toEqual([CASTLE_NO_MORE_TASKS]);
  });

  it("reports a fully trust-held queue without claiming progress", async () => {
    const emitted: string[] = [];
    const processIssue = vi.fn(async () => ({ outcome: "done" as const }));
    const result = await runCastleWorkerDrain(
      {
        gh: { listCandidates: async () => [{ ...candidate(2062), author: "github-actions" }] },
        classifyEligibility: async () => ({
          eligible: false,
          reason: "untrusted author — held for maintainer summon",
        }),
        runBoot: async () => boot,
        bootDeps: {},
        bootOptions: {},
        processIssue,
        processDeps,
        buildProcessInput: (row, ctx) => ({ issue: row.number, runner: ctx.runner }),
        emit: (line) => emitted.push(line),
      },
      {
        runner: "codex",
        workerId: "wHELD",
        filter: { kind: "all" },
        issueTemplate: {},
      },
    );

    expect(processIssue).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, heldForSummon: 1, drained: true });
    expect(emitted).toContain(
      "0 eligible, 1 held for summon (#2062) — release with `triage:summon`, `dev triage --summon`, or `afk.trust-gate.allowlist`",
    );
    expect(emitted.some((line) => line.includes("progress:") || line.includes("100%"))).toBe(false);
  });

  it.each([
    {
      name: "supervisor kill before budget, lifetime, and iteration caps",
      expected: "supervisor-kill",
      active: {
        supervisor: true,
        budget: true,
        lifetime: true,
        maxIssues: true,
        iterCap: true,
      },
      checks: ["now:start", "supervisor"],
      processed: 0,
    },
    {
      name: "budget before lifetime and iteration caps",
      expected: "budget-cap",
      active: {
        supervisor: false,
        budget: true,
        lifetime: true,
        maxIssues: true,
        iterCap: true,
      },
      checks: ["now:start", "supervisor", "budget"],
      processed: 0,
    },
    {
      name: "runtime lifetime before issue and iteration caps",
      expected: "lifetime-cap",
      active: {
        supervisor: false,
        budget: false,
        lifetime: true,
        maxIssues: true,
        iterCap: true,
      },
      checks: ["now:start", "supervisor", "budget", "now:loop"],
      processed: 0,
    },
    {
      name: "issue lifetime before the iteration cap",
      expected: "lifetime-cap",
      active: {
        supervisor: false,
        budget: false,
        lifetime: false,
        maxIssues: true,
        iterCap: true,
      },
      checks: ["now:start", "supervisor", "budget", "now:loop"],
      processed: 0,
    },
    {
      name: "iteration cap after every lifetime check",
      expected: "iter-cap",
      active: {
        supervisor: false,
        budget: false,
        lifetime: false,
        maxIssues: false,
        iterCap: true,
      },
      checks: [
        "now:start",
        "supervisor",
        "budget",
        "now:loop",
        "supervisor",
        "budget",
        "now:loop",
      ],
      processed: 1,
    },
  ])(
    "checks $name",
    async ({ expected, active, checks: expectedChecks, processed }) => {
      const checks: string[] = [];
      let nowCalls = 0;
      const harness = makeDrainHarness({
        iterCap: active.iterCap ? 1 : undefined,
        policy: {
          supervisorKilled: () => {
            checks.push("supervisor");
            return active.supervisor;
          },
          budget: () => {
            checks.push("budget");
            return active.budget ? { used: 1, cap: 1 } : { used: 0, cap: 1 };
          },
          nowMs: () => {
            checks.push(nowCalls++ === 0 ? "now:start" : "now:loop");
            return active.lifetime && nowCalls > 1 ? 1 : 0;
          },
          maxRuntimeMs: 1,
          maxIssues: active.maxIssues ? 0 : undefined,
        },
      });

      const result = await harness.run();

      expect(result.stopReason).toBe(expected);
      expect(harness.processIssue).toHaveBeenCalledTimes(processed);
      expect(checks).toEqual(expectedChecks);
    },
  );

  it.each([
    {
      outcome: "exhausted" as const,
      expected: "exhausted",
      exhausted: true,
      runnerTransient: false,
      hostConfig: false,
      retirementChecks: 0,
    },
    {
      outcome: "runner-transient" as const,
      expected: "runner-unavailable",
      exhausted: false,
      runnerTransient: true,
      hostConfig: false,
      retirementChecks: 0,
    },
    {
      outcome: "host-config" as const,
      expected: "host-config",
      exhausted: false,
      runnerTransient: false,
      hostConfig: true,
      retirementChecks: 0,
    },
    {
      outcome: "done" as const,
      expected: "once",
      exhausted: false,
      runnerTransient: false,
      hostConfig: false,
      retirementChecks: 0,
    },
    {
      outcome: "claim-lost" as const,
      expected: "graceful-retirement",
      exhausted: false,
      runnerTransient: false,
      hostConfig: false,
      retirementChecks: 1,
    },
  ])(
    "orders the $outcome result before lower-priority post-process stops",
    async ({
      outcome,
      expected,
      exhausted,
      runnerTransient,
      hostConfig,
      retirementChecks,
    }) => {
      const shouldRetire = vi.fn(() => true);
      const harness = makeDrainHarness({
        once: true,
        alternate: true,
        outcomeFor: () => outcome,
        policy: { shouldRetire },
      });

      const result = await harness.run();

      expect(result).toMatchObject({
        stopReason: expected,
        exhausted,
        runnerTransient,
        hostConfig,
      });
      expect(shouldRetire).toHaveBeenCalledTimes(retirementChecks);
      expect(harness.processedRunners).toEqual(["claude"]);
    },
  );

  it("keeps --once draining lost claims until a real attempt is processed", async () => {
    const harness = makeDrainHarness({
      candidates: [candidate(1), candidate(2), candidate(3)],
      once: true,
      outcomeFor: () => "claim-lost",
    });

    const result = await harness.run();

    expect(harness.processedIssues).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ done: 0, blocked: 0, failed: 3 });
    expect(result.stopReason).toBeUndefined();
  });

  it("stops at an open runner circuit before building or claiming the next issue", async () => {
    const harness = makeDrainHarness({ circuitOpenFor: ["claude"] });

    const result = await harness.run();

    expect(harness.builtInputs).toEqual([]);
    expect(harness.processIssue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      blocked: 0,
      failed: 0,
      runnerTransient: true,
      stopReason: "runner-unavailable",
    });
    expect(harness.emitted).toEqual([
      "runner claude circuit open — stopping before claiming more issues",
      "worker stop: runner-unavailable",
    ]);
  });

  it("skips dispatch before claiming when the host profile lacks the selected runner", async () => {
    const harness = makeDrainHarness({
      runner: "claude",
      hostProfile: {
        machineIdHash: "8cb3eafdcbd2",
        runners: ["codex"],
        maxGateWeight: "full-workspace",
        defaultFleetWidth: 2,
      },
    });

    const result = await harness.run();

    expect(harness.builtInputs).toEqual([]);
    expect(harness.processIssue).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      blocked: 0,
      failed: 0,
      stopReason: "runner-unavailable",
    });
    expect(harness.emitted).toEqual([
      "runner claude unavailable in host capability profile — skipping dispatch",
      "worker stop: runner-unavailable",
    ]);
  });

  it.each<[Runner, Runner[]]>([
    ["claude", ["claude", "codex", "claude"]],
    ["claude-minimax", ["claude-minimax", "claude", "claude-minimax"]],
    ["codex", ["codex", "claude", "codex"]],
    ["hermes", ["hermes", "claude", "hermes"]],
    ["opencode", ["opencode", "claude", "opencode"]],
  ])(
    "alternates the %s session through its runner ladder",
    async (runner, expected) => {
      const harness = makeDrainHarness({ runner, alternate: true });

      await harness.run();

      expect(harness.processedRunners).toEqual(expected);
    },
  );

  it("classifies drain outcomes into done, blocked, and failed summary buckets", async () => {
    const outcomes: CastleWorkerOutcome[] = [
      "done",
      "claim-lost",
      "hook-aborted",
      "parked-for-review",
    ];
    const harness = makeDrainHarness({
      candidates: outcomes.map((_, index) => candidate(index + 1)),
      outcomeFor: (issue) => outcomes[issue - 1]!,
    });

    const result = await harness.run();

    expect(result).toMatchObject({ done: 1, blocked: 1, failed: 2, total: 4 });
    expect(result.processed).toEqual([
      { issue: 1, outcome: "done" },
      { issue: 2, outcome: "claim-lost" },
      { issue: 3, outcome: "hook-aborted" },
      { issue: 4, outcome: "parked-for-review" },
    ]);
  });

  it("fires on_session_error before rethrowing the original process failure", async () => {
    const failure = new Error("worker process crashed");
    const events: string[] = [];
    const hookNames: string[] = [];
    const harness = makeDrainHarness({
      processError: failure,
      onProcess: () => events.push("process"),
      dispatchSessionHook: async (name, context) => {
        hookNames.push(name);
        if (name === "on_session_error") {
          events.push("error-hook");
          expect(JSON.parse(context)).toEqual({
            runner: "claude",
            worker_id: "wTEST",
            error: { message: "worker process crashed" },
          });
        }
        return { aborted: false };
      },
    });

    const rejection = harness.run().catch((error: unknown) => {
      events.push("rethrow");
      throw error;
    });

    await expect(rejection).rejects.toBe(failure);
    expect(events).toEqual(["process", "error-hook", "rethrow"]);
    expect(hookNames).toEqual([
      "pre_session",
      "pre_pick",
      "post_pick",
      "on_session_error",
    ]);
  });
});
