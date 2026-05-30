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
}

interface RunHarnessOptions {
  candidates?: IssueCandidate[];
  filter?: SelectionFilter;
  iterCap?: number;
  once?: boolean;
  /** Map an issue number → the outcome its fake processIssue returns. */
  outcomeFor?: (issue: number) => ProcessIssueResult["outcome"];
  bootResult?: BootResult;
}

function makeSession(opts: RunHarnessOptions = {}): {
  deps: SessionDeps;
  ctx: SessionContext;
  trace: SessionTrace;
} {
  const trace: SessionTrace = { emitted: [], processedOrder: [], builtInputs: [] };
  const candidates = opts.candidates ?? [cand(1), cand(2), cand(3)];
  const boot: BootResult = opts.bootResult ?? { precheck: { ok: true, warnings: [] } };

  // The composed boot/process deps are opaque to the loop — the fakes below
  // ignore them entirely, so we pass minimal stubs cast through `unknown`.
  const bootDeps = {} as unknown as BootDeps;
  const bootOptions = {} as unknown as BootOptions;
  const processDeps = {} as unknown as ProcessIssueDeps;

  const deps: SessionDeps = {
    gh: {
      async listCandidates() {
        return candidates;
      },
    },
    async runBoot() {
      return boot;
    },
    bootDeps,
    bootOptions,
    async processIssue(_deps, input) {
      trace.processedOrder.push(input.issue);
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
  };

  const ctx: SessionContext = {
    runner: "claude",
    workerId: "wAAAA",
    iterCap: opts.iterCap,
    once: opts.once,
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
