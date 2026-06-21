import { describe, expect, it } from "vitest";
import {
  genWorkerId,
  selectIssues,
  slugify,
  runSession,
  IssueSelectionError,
  NO_MORE_TASKS,
  type IssueCandidate,
  type SelectionFilter,
  type SessionContext,
  type SessionDeps,
} from "../src/core/session.js";
import type { BootResult } from "../src/core/boot.js";
import type { ProcessIssueDeps, ProcessIssueInput, ProcessIssueResult } from "../src/core/process-issue.js";
import type { BootDeps, BootOptions } from "../src/core/boot.js";
import type { Runner } from "../src/types/runner.js";

// ---------- candidate builder ----------

function cand(number: number, labels: string[] = ["ready-for-agent"], over: Partial<IssueCandidate> = {}): IssueCandidate {
  return { number, title: `issue ${number}`, body: "", labels, ...over };
}

// ---------- selectIssues ----------

describe("selectIssues", () => {
  it("drops every type:prd candidate before any filter", () => {
    const list = [
      cand(1, ["ready-for-agent", "type:prd"]),
      cand(2, ["ready-for-agent"]),
    ];
    const out = selectIssues(list, { kind: "all" });
    expect(out.map((c) => c.number)).toEqual([2]);
  });

  it("prepends priority:urgent ahead of the filtered remainder, oldest number first", () => {
    const list = [
      cand(5, ["ready-for-agent"]),
      cand(9, ["ready-for-agent", "priority:urgent"]),
      cand(3, ["ready-for-agent", "priority:urgent"]),
      cand(2, ["ready-for-agent"]),
    ];
    const out = selectIssues(list, { kind: "all" });
    // urgents (3, 9) sorted asc, then the rest by number asc (2, 5).
    expect(out.map((c) => c.number)).toEqual([3, 9, 2, 5]);
  });

  it("urgents jump even past a --prd filter and the filter applies only to the rest", () => {
    const list = [
      cand(9, ["ready-for-agent", "priority:urgent"]),
      cand(2, ["ready-for-agent"], { body: "prd: #44" }),
      cand(3, ["ready-for-agent"]), // not in prd 44 → dropped by the filter
    ];
    const out = selectIssues(list, { kind: "prd", prd: 44 });
    expect(out.map((c) => c.number)).toEqual([9, 2]);
  });

  it("--issues keeps the requested numbers in ARGUMENT order (no priority re-sort)", () => {
    const list = [cand(10), cand(20), cand(30)];
    const out = selectIssues(list, { kind: "issues", numbers: [30, 10, 20] });
    expect(out.map((c) => c.number)).toEqual([30, 10, 20]);
  });

  it("--issues throws when a requested number is missing from the ready-for-agent pool", () => {
    const list = [cand(10), cand(20)];
    try {
      selectIssues(list, { kind: "issues", numbers: [10, 99] });
      throw new Error("expected IssueSelectionError");
    } catch (err) {
      expect(err).toBeInstanceOf(IssueSelectionError);
      expect((err as IssueSelectionError).numbers).toEqual([99]);
    }
  });

  it("--issues treats an explicit type:prd number as missing (it was dropped)", () => {
    const list = [cand(10), cand(7, ["ready-for-agent", "type:prd"])];
    expect(() => selectIssues(list, { kind: "issues", numbers: [10, 7] })).toThrow(IssueSelectionError);
  });

  it("--prd matches body `prd: #N`, `prd:N` label, and word-boundary-rejects a superstring", () => {
    const list = [
      cand(1, ["ready-for-agent"], { body: "implements prd: #24 stuff" }),
      cand(2, ["ready-for-agent", "prd:24"]),
      cand(3, ["ready-for-agent"], { body: "prd: #240 not this one" }),
      cand(4, ["ready-for-agent"]),
    ];
    const out = selectIssues(list, { kind: "prd", prd: 24 });
    expect(out.map((c) => c.number)).toEqual([1, 2]);
  });

  it("all: sorts priority:high before the rest, then by number ascending", () => {
    const list = [
      cand(5, ["ready-for-agent"]),
      cand(3, ["ready-for-agent", "priority:high"]),
      cand(8, ["ready-for-agent", "priority:high"]),
      cand(1, ["ready-for-agent"]),
    ];
    const out = selectIssues(list, { kind: "all" });
    expect(out.map((c) => c.number)).toEqual([3, 8, 1, 5]);
  });

  it("dedupes an urgent that also matched the filter, keeping it at the front only", () => {
    const list = [
      cand(9, ["ready-for-agent", "priority:urgent"], { body: "prd: #44" }),
      cand(2, ["ready-for-agent"], { body: "prd: #44" }),
    ];
    const out = selectIssues(list, { kind: "prd", prd: 44 });
    expect(out.map((c) => c.number)).toEqual([9, 2]);
  });
});

// ---------- slugify ----------

describe("slugify", () => {
  it("lowercases, collapses to dashes, trims, and caps at 40", () => {
    expect(slugify("Fix the Thing!")).toBe("fix-the-thing");
    expect(slugify("  Wire OAuth  ")).toBe("wire-oauth");
  });
});

// ---------- genWorkerId ----------

describe("genWorkerId", () => {
  it("returns `w` + 4 chars drawn from [A-Z0-9]", () => {
    let i = 0;
    const seq = [0, 0, 0, 0]; // → AAAA
    const id = genWorkerId(() => seq[i++ % seq.length]!);
    expect(id).toBe("wAAAA");
    expect(id).toMatch(/^w[A-Z0-9]{4}$/);
  });

  it("draws across the full alphabet deterministically", () => {
    // 36-char alphabet; 35/36 → 'Z' (index 25 is 'Z'? alphabet = A..Z0..9).
    const vals = [25 / 36, 26 / 36, 35 / 36, 0]; // Z, 0, 9, A
    let i = 0;
    expect(genWorkerId(() => vals[i++]!)).toBe("wZ09A");
  });

  it("retries on a collision until `exists` returns false", () => {
    // First candidate (AAAA) collides; second (BAAA) is free.
    let call = 0;
    const rand = () => {
      // 8 draws total: AAAA then BAAA.
      const draws = [0, 0, 0, 0, 1 / 36, 0, 0, 0];
      return draws[call++]!;
    };
    const exists = (id: string) => id === "wAAAA";
    expect(genWorkerId(rand, exists)).toBe("wBAAA");
  });
});

// ---------- runSession harness ----------

interface SessionTrace {
  emitted: string[];
  processedOrder: number[];
  builtInputs: number[];
  /** Runner seen on each processed issue, in order (for --alternate assertions). */
  processedRunners: string[];
  /** Session-scoped hook commands the fake exec ran, in order. */
  hookCommands: string[];
  /** How many times the fake runBoot was invoked. */
  runBootCalls: number;
  /** How many times the fake gh.listCandidates was invoked. */
  listCandidatesCalls: number;
}

interface RunHarnessOptions {
  candidates?: IssueCandidate[];
  filter?: SelectionFilter;
  iterCap?: number;
  once?: boolean;
  alternate?: boolean;
  /** Map an issue number → the outcome its fake processIssue returns. */
  outcomeFor?: (issue: number) => ProcessIssueResult["outcome"];
  bootResult?: BootResult;
  /** Wire session hooks; the config maps each point to a marker command. */
  withHooks?: boolean;
  /** When set, this session point's hook command aborts (rc=1). */
  abortHook?: string;
  /** When true, the fake processIssue throws to exercise on_session_error. */
  throwOnProcess?: boolean;
  /** --boot-only: run the boot then return before selection/processing. */
  bootOnly?: boolean;
  /** #623: the supervisor already ran the sweeps; shape the boot-only line. */
  sweepsSkipped?: boolean;
  /** Runners whose shared circuit is already open before the next claim. */
  circuitOpenFor?: Runner[];
}

function makeSession(opts: RunHarnessOptions = {}): {
  deps: SessionDeps;
  ctx: SessionContext;
  trace: SessionTrace;
} {
  const trace: SessionTrace = {
    emitted: [],
    processedOrder: [],
    builtInputs: [],
    processedRunners: [],
    hookCommands: [],
    runBootCalls: 0,
    listCandidatesCalls: 0,
  };
  const candidates = opts.candidates ?? [cand(1), cand(2), cand(3)];
  const boot: BootResult = opts.bootResult ?? { precheck: { ok: true, warnings: [] } };

  // Session hooks: map every session-scoped point to a marker command the fake
  // exec records; the canonical point names double as their command strings.
  const sessionPoints = [
    "pre_session",
    "pre_pick",
    "post_pick",
    "on_idle",
    "post_session",
    "on_session_error",
  ] as const;
  const hookConfig: Record<string, string> = {};
  for (const p of sessionPoints) hookConfig[`afk.hooks.${p}`] = `cmd:${p}`;
  const hooks = opts.withHooks
    ? {
        config: hookConfig,
        resolveOptions: { defaultCommand: () => undefined },
        exec: async (command: string) => {
          trace.hookCommands.push(command);
          if (opts.abortHook && command === `cmd:${opts.abortHook}`) {
            return { code: 1, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
      }
    : undefined;

  // The composed boot/process deps are opaque to the loop — the fakes below
  // ignore them entirely, so we pass minimal stubs cast through `unknown`.
  const bootDeps = {} as unknown as BootDeps;
  const bootOptions = {} as unknown as BootOptions;
  const processDeps = {} as unknown as ProcessIssueDeps;

  const deps: SessionDeps = {
    gh: {
      async listCandidates() {
        trace.listCandidatesCalls += 1;
        return candidates;
      },
    },
    async runBoot() {
      trace.runBootCalls += 1;
      return boot;
    },
    bootDeps,
    bootOptions,
    async processIssue(_deps, input) {
      trace.processedOrder.push(input.issue);
      trace.processedRunners.push(input.runner);
      if (opts.throwOnProcess) throw new Error("boom in processIssue");
      const outcome = opts.outcomeFor ? opts.outcomeFor(input.issue) : "done";
      return {
        outcome,
        issue: input.issue,
        hooksFired: [],
        preserved: outcome !== "claim-lost",
        swept: outcome === "done",
      };
    },
    processDeps,
    runnerCircuit: opts.circuitOpenFor
      ? {
          isOpen: async (runner) => opts.circuitOpenFor!.includes(runner),
        }
      : undefined,
    buildProcessInput(candidate, ctx) {
      trace.builtInputs.push(candidate.number);
      return {
        issue: candidate.number,
        title: candidate.title,
        body: candidate.body,
        runner: ctx.runner,
        workerId: ctx.workerId,
        tmpDir: ctx.issueTemplate.tmpDir,
        attempt: 1,
        attemptDir: `${ctx.issueTemplate.tmpDir}/workers/${ctx.workerId}/${candidate.number}-a1`,
        repo: ctx.issueTemplate.repo,
        repoDir: ctx.issueTemplate.repoDir,
        remote: ctx.issueTemplate.remote,
        baseInput: { issueBody: candidate.body },
      } satisfies ProcessIssueInput;
    },
    emit(line) {
      trace.emitted.push(line);
    },
    hooks,
  };

  const ctx: SessionContext = {
    runner: "claude",
    workerId: "wAAAA",
    iterCap: opts.iterCap,
    once: opts.once,
    alternate: opts.alternate,
    bootOnly: opts.bootOnly,
    sweepsSkipped: opts.sweepsSkipped,
    filter: opts.filter ?? { kind: "all" },
    issueTemplate: {
      tmpDir: "/tmp/afk",
      repo: "o/r",
      repoDir: "/repo",
      remote: "origin",
    },
  };

  return { deps, ctx, trace };
}

describe("runSession", () => {
  it("drains the whole queue, calling processIssue in selection order", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(2), cand(1), cand(3)] });
    const summary = await runSession(deps, ctx);
    // `all` sorts by number asc → 1, 2, 3.
    expect(trace.processedOrder).toEqual([1, 2, 3]);
    expect(summary.total).toBe(3);
    expect(summary.done).toBe(3);
    expect(summary.drained).toBe(false);
  });

  it("accumulates done / blocked / failed counters by outcome", async () => {
    const outcomeFor = (issue: number): ProcessIssueResult["outcome"] => {
      if (issue === 1) return "done";
      if (issue === 2) return "blocked";
      return "claim-lost"; // issue 3 → failed
    };
    const { deps, ctx } = makeSession({ candidates: [cand(1), cand(2), cand(3)], outcomeFor });
    const summary = await runSession(deps, ctx);
    expect(summary.done).toBe(1);
    expect(summary.blocked).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.processed).toEqual([
      { issue: 1, outcome: "done" },
      { issue: 2, outcome: "blocked" },
      { issue: 3, outcome: "claim-lost" },
    ]);
  });

  it("emits one progress line per processed issue", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1), cand(2)] });
    await runSession(deps, ctx);
    expect(trace.emitted).toEqual([
      "progress: 1/2 (50%) — 1 remaining",
      "progress: 2/2 (100%) — 0 remaining",
    ]);
  });

  it("emits NO MORE TASKS and never processes when the queue is empty", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [] });
    const summary = await runSession(deps, ctx);
    expect(trace.emitted).toEqual([NO_MORE_TASKS]);
    expect(trace.processedOrder).toEqual([]);
    expect(summary.drained).toBe(true);
    expect(summary.total).toBe(0);
  });

  it("honours the -n cap, stopping after N issues with total = full queue", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3), cand(4)],
      iterCap: 2,
    });
    const summary = await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([1, 2]);
    expect(summary.total).toBe(4); // queue length is the pre-cap total.
    expect(summary.done).toBe(2);
    // progress %s are computed against the full queue total.
    expect(trace.emitted).toEqual([
      "progress: 1/4 (25%) — 3 remaining",
      "progress: 2/4 (50%) — 2 remaining",
    ]);
  });

  it("--once stops after the first processed issue", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1), cand(2), cand(3)], once: true });
    await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([1]);
  });

  it("--once skips past a lost claim race to the next candidate (#644 churn)", async () => {
    // Under the fleet supervisor every worker is --once. A claim-lost on the
    // head issue must not consume the single iteration — exiting here respawns
    // a fresh worker that re-races the same head issue forever.
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      once: true,
      outcomeFor: (issue) => (issue === 1 ? "claim-lost" : "done"),
    });
    const summary = await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([1, 2]); // lost #1 → moved on, ran #2, then stopped
    expect(summary.done).toBe(1);
    expect(summary.failed).toBe(1);
  });

  it("--once with every claim lost drains the whole queue without an attempt", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2)],
      once: true,
      outcomeFor: () => "claim-lost",
    });
    const summary = await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([1, 2]);
    expect(summary.done).toBe(0);
    expect(summary.failed).toBe(2);
  });

  it("aborts the drain on a precheck failure — no listing, no NO MORE TASKS", async () => {
    const bootResult: BootResult = { precheck: { ok: false, failed: "gh-missing" } };
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1)], bootResult });
    const summary = await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([]);
    expect(trace.emitted).toEqual([]);
    expect(summary.total).toBe(0);
    expect(summary.drained).toBe(false);
    expect(summary.boot).toBe(bootResult);
  });
});

describe("runSession — --boot-only dry-run", () => {
  it("runs the boot then returns before selecting/claiming/processing — never spawns an agent", async () => {
    const bootResult: BootResult = { precheck: { ok: true, warnings: ["a-warning"] } };
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      bootResult,
      bootOnly: true,
    });
    const summary = await runSession(deps, ctx);
    // The boot sweeps ran exactly once...
    expect(trace.runBootCalls).toBe(1);
    // ...but selection and per-issue processing were skipped entirely.
    expect(trace.listCandidatesCalls).toBe(0);
    expect(trace.processedOrder).toEqual([]);
    expect(trace.builtInputs).toEqual([]);
    // No drain happened: zero counters, not flagged as a drained empty queue.
    expect(summary.total).toBe(0);
    expect(summary.done).toBe(0);
    expect(summary.drained).toBe(false);
    // The boot result still surfaces on the summary.
    expect(summary.boot).toBe(bootResult);
    // A single informational line is emitted, never the NO MORE TASKS sentinel.
    expect(trace.emitted).not.toContain(NO_MORE_TASKS);
    expect(trace.emitted).toEqual(["boot complete (--boot-only): sweeps ran, no issues processed"]);
  });

  it("reports the sweeps as supervisor-owned when sweepsSkipped is set (#623)", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2)],
      bootOnly: true,
      sweepsSkipped: true,
    });
    const summary = await runSession(deps, ctx);
    // Still a dry-run: no selection / processing, just the supervisor-owned line.
    expect(trace.listCandidatesCalls).toBe(0);
    expect(trace.processedOrder).toEqual([]);
    expect(trace.emitted).toEqual([
      "boot complete (--boot-only): sweeps skipped (supervisor-owned), no issues processed",
    ]);
    expect(summary.drained).toBe(false);
  });
});

describe("runSession — --alternate runner rotation", () => {
  it("rotates the runner between consecutive issues (claude → codex → claude)", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      alternate: true,
    });
    await runSession(deps, ctx);
    expect(trace.processedRunners).toEqual(["claude", "codex", "claude"]);
  });

  it("rotates claude-minimax ↔ claude when the session starts on claude-minimax (#792)", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3), cand(4)],
      alternate: true,
    });
    ctx.runner = "claude-minimax";
    await runSession(deps, ctx);
    expect(trace.processedRunners).toEqual(["claude-minimax", "claude", "claude-minimax", "claude"]);
  });

  it("keeps the session runner for every issue when --alternate is off", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1), cand(2), cand(3)] });
    await runSession(deps, ctx);
    expect(trace.processedRunners).toEqual(["claude", "claude", "claude"]);
  });
});

describe("runSession — exhaustion stops the drain (exit-75 signal)", () => {
  it("stops draining and flags exhausted when an issue ends exhausted", async () => {
    const outcomeFor = (issue: number): ProcessIssueResult["outcome"] =>
      issue === 2 ? "exhausted" : "done";
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      outcomeFor,
    });
    const summary = await runSession(deps, ctx);
    // issue 3 is never processed — exhaustion on #2 breaks the loop.
    expect(trace.processedOrder).toEqual([1, 2]);
    expect(summary.exhausted).toBe(true);
    expect(summary.runnerTransient).toBe(false);
    expect(summary.done).toBe(1);
  });

  it("stops draining and flags runnerTransient when runner transport fails", async () => {
    const outcomeFor = (issue: number): ProcessIssueResult["outcome"] =>
      issue === 2 ? "runner-transient" : "done";
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      outcomeFor,
    });
    const summary = await runSession(deps, ctx);
    // issue 3 is never claimed while the runner backend is unhealthy.
    expect(trace.processedOrder).toEqual([1, 2]);
    expect(summary.runnerTransient).toBe(true);
    expect(summary.exhausted).toBe(false);
    expect(summary.done).toBe(1);
    expect(summary.blocked).toBe(1);
  });

  it("honors a shared runner circuit before claiming another issue", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2), cand(3)],
      circuitOpenFor: ["claude"],
    });
    const summary = await runSession(deps, ctx);
    expect(trace.builtInputs).toEqual([]);
    expect(trace.processedOrder).toEqual([]);
    expect(summary.runnerTransient).toBe(true);
    expect(summary.blocked).toBe(0);
    expect(trace.emitted).toEqual([
      "runner claude circuit open — stopping before claiming more issues",
    ]);
  });

  it("a clean drain leaves exhausted false", async () => {
    const { deps, ctx } = makeSession({ candidates: [cand(1), cand(2)] });
    const summary = await runSession(deps, ctx);
    expect(summary.exhausted).toBe(false);
    expect(summary.runnerTransient).toBe(false);
  });
});

describe("runSession — session-level lifecycle hooks", () => {
  it("fires pre_session → pre_pick → post_pick → post_session in order on a normal drain", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1)], withHooks: true });
    const summary = await runSession(deps, ctx);
    expect(summary.sessionHooksFired).toEqual(["pre_session", "pre_pick", "post_pick", "post_session"]);
    expect(trace.hookCommands).toEqual(["cmd:pre_session", "cmd:pre_pick", "cmd:post_pick", "cmd:post_session"]);
  });

  it("fires on_idle then post_session when the queue is empty", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [], withHooks: true });
    const summary = await runSession(deps, ctx);
    expect(summary.sessionHooksFired).toEqual(["pre_session", "pre_pick", "post_pick", "on_idle", "post_session"]);
    // NO MORE TASKS is still emitted between on_idle and post_session.
    expect(trace.emitted).toContain(NO_MORE_TASKS);
  });

  it("pre_session abort stops the session before any issue is picked", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1), cand(2)],
      withHooks: true,
      abortHook: "pre_session",
    });
    const summary = await runSession(deps, ctx);
    expect(trace.processedOrder).toEqual([]);
    expect(summary.sessionHooksFired).toEqual(["pre_session"]);
    // no listing happened → no NO MORE TASKS, no progress lines.
    expect(trace.emitted).toEqual([]);
  });

  it("fires on_session_error and re-throws when processIssue crashes", async () => {
    const { deps, ctx, trace } = makeSession({
      candidates: [cand(1)],
      withHooks: true,
      throwOnProcess: true,
    });
    await expect(runSession(deps, ctx)).rejects.toThrow("boom in processIssue");
    expect(trace.hookCommands).toContain("cmd:on_session_error");
  });

  it("does not fire any session hook when hooks are not wired (back-compat)", async () => {
    const { deps, ctx, trace } = makeSession({ candidates: [cand(1)] });
    const summary = await runSession(deps, ctx);
    expect(summary.sessionHooksFired).toEqual([]);
    expect(trace.hookCommands).toEqual([]);
  });
});
