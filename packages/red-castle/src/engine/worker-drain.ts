import type { FleetSelector } from "./fleet-registry.js";
import type { Runner } from "./runner-types.js";
import {
  resolveHostCapabilities,
  type HostCapabilityProfile,
} from "./host-capability-profile.js";

export interface CastleIssueCandidate {
  number: number;
  title: string;
  body: string;
  labels: readonly string[];
}

export type CastleSelectionFilter =
  | { kind: "all" }
  | { kind: "issues"; numbers: number[] }
  | { kind: "spec"; spec: number }
  /** A named fleet's work scope — every declared facet narrows the pool. */
  | { kind: "selector"; selector: FleetSelector };

/** True when a candidate falls inside a named fleet's work scope. Every facet
 * the selector declares must hold; an empty selector matches everything. */
export function matchesFleetSelector(
  candidate: CastleIssueCandidate,
  selector: FleetSelector,
): boolean {
  if (selector.spec !== undefined && !matchesSpec(candidate, selector.spec)) return false;
  if (selector.lane !== undefined && !hasLabel(candidate, `lane:${selector.lane}`)) return false;
  if (selector.label !== undefined && !hasLabel(candidate, selector.label)) return false;
  if (selector.issues !== undefined && !selector.issues.includes(candidate.number)) return false;
  return true;
}

export interface CastleSelectionLabels {
  ready: string;
  typeSpec: string;
  urgent: string;
  high: string;
}

export const DEFAULT_CASTLE_SELECTION_LABELS: CastleSelectionLabels = {
  ready: "ready-for-agent",
  typeSpec: "type:spec",
  urgent: "priority:urgent",
  high: "priority:high",
};

export class CastleIssueSelectionError extends Error {
  constructor(
    message: string,
    readonly numbers: number[],
  ) {
    super(message);
    this.name = "CastleIssueSelectionError";
  }
}

function hasLabel(candidate: CastleIssueCandidate, label: string): boolean {
  return candidate.labels.includes(label);
}

function matchesSpec(candidate: CastleIssueCandidate, spec: number): boolean {
  if (hasLabel(candidate, `spec:${spec}`)) return true;
  return new RegExp(`spec:\\s*#?${spec}\\b`).test(candidate.body ?? "");
}

function sortByPriority(
  candidates: readonly CastleIssueCandidate[],
  labels: CastleSelectionLabels,
): CastleIssueCandidate[] {
  return [...candidates].sort((a, b) => {
    const ar = hasLabel(a, labels.high) ? 0 : 1;
    const br = hasLabel(b, labels.high) ? 0 : 1;
    if (ar !== br) return ar - br;
    return a.number - b.number;
  });
}

export function selectCastleIssues(
  candidates: readonly CastleIssueCandidate[],
  filter: CastleSelectionFilter,
  labels: CastleSelectionLabels = DEFAULT_CASTLE_SELECTION_LABELS,
): CastleIssueCandidate[] {
  const excluded = candidates.filter((candidate) => !hasLabel(candidate, labels.typeSpec));
  // A named fleet's scope applies BEFORE the urgent prepend, so an urgent issue
  // another fleet owns is never pulled across the boundary into a double-claim.
  const pool =
    filter.kind === "selector"
      ? excluded.filter((candidate) => matchesFleetSelector(candidate, filter.selector))
      : excluded;
  const urgent = pool
    .filter((candidate) => hasLabel(candidate, labels.urgent))
    .sort((a, b) => a.number - b.number);
  const rest = pool.filter((candidate) => !hasLabel(candidate, labels.urgent));

  let filtered: CastleIssueCandidate[];
  switch (filter.kind) {
    case "issues": {
      const byNumber = new Map(pool.map((candidate) => [candidate.number, candidate] as const));
      const ordered: CastleIssueCandidate[] = [];
      const missing: number[] = [];
      for (const number of filter.numbers) {
        const candidate = byNumber.get(number);
        if (candidate) ordered.push(candidate);
        else missing.push(number);
      }
      if (missing.length > 0) {
        throw new CastleIssueSelectionError(
          `requested issue(s) missing from the ${labels.ready} queue: ${missing.map((number) => `#${number}`).join(", ")}`,
          missing,
        );
      }
      filtered = ordered;
      break;
    }
    case "spec":
      filtered = sortByPriority(
        rest.filter((candidate) => matchesSpec(candidate, filter.spec)),
        labels,
      );
      break;
    case "selector":
    case "all":
    default:
      filtered = sortByPriority(rest, labels);
      break;
  }

  const urgentNumbers = new Set(urgent.map((candidate) => candidate.number));
  return [...urgent, ...filtered.filter((candidate) => !urgentNumbers.has(candidate.number))];
}

export type CastleWorkerOutcome =
  | "done"
  | "claim-lost"
  | "hook-aborted"
  | "exhausted"
  | "runner-transient"
  | "host-config"
  | (string & {});

export interface CastleWorkerProcessResult {
  outcome: CastleWorkerOutcome;
}

export interface CastleWorkerDrainBudgetSnapshot {
  used: number;
  cap: number;
}

export interface CastleWorkerDrainPolicy {
  maxIssues?: number;
  maxRuntimeMs?: number;
  nowMs?: () => number;
  budget?: () => CastleWorkerDrainBudgetSnapshot;
  supervisorKilled?: () => boolean;
  shouldRetire?: () => boolean;
}

export type CastleWorkerStopReason =
  | "drain-empty"
  | "lifetime-cap"
  | "budget-cap"
  | "supervisor-kill"
  | "graceful-retirement"
  | "iter-cap"
  | "once"
  | "runner-unavailable"
  | "host-config"
  | "exhausted";

export type CastleSessionHookName =
  | "pre_session"
  | "pre_pick"
  | "post_pick"
  | "on_idle"
  | "post_session"
  | "on_session_error";

export interface CastleWorkerDrainContext<TIssueTemplate = unknown> {
  runner: Runner;
  workerId: string;
  iterCap?: number;
  once?: boolean;
  filter: CastleSelectionFilter;
  alternate?: boolean;
  bootOnly?: boolean;
  sweepsSkipped?: boolean;
  issueTemplate: TIssueTemplate;
  policy?: CastleWorkerDrainPolicy;
  /** This machine's durable capability declaration. Absent keeps legacy permissive routing. */
  hostProfile?: HostCapabilityProfile;
}

export interface CastleWorkerDrainProcessed {
  issue: number;
  outcome: CastleWorkerOutcome;
}

export interface CastleWorkerDrainSummary<TBootResult = unknown> {
  runner: Runner;
  workerId: string;
  done: number;
  blocked: number;
  failed: number;
  total: number;
  boot: TBootResult;
  processed: CastleWorkerDrainProcessed[];
  drained: boolean;
  exhausted: boolean;
  runnerTransient: boolean;
  hostConfig: boolean;
  sessionHooksFired: CastleSessionHookName[];
  stopReason?: CastleWorkerStopReason;
}

export interface CastleWorkerDrainDeps<
  TBootDeps,
  TBootOptions,
  TBootResult extends { precheck: { ok: boolean } },
  TProcessDeps,
  TProcessInput,
  TProcessResult extends CastleWorkerProcessResult,
  TIssueTemplate = unknown,
> {
  gh: {
    listCandidates(): Promise<CastleIssueCandidate[]>;
  };
  runBoot(deps: TBootDeps, options: TBootOptions): Promise<TBootResult>;
  bootDeps: TBootDeps;
  bootOptions: TBootOptions;
  processIssue(deps: TProcessDeps, input: TProcessInput): Promise<TProcessResult>;
  processDeps: TProcessDeps;
  buildProcessInput(
    candidate: CastleIssueCandidate,
    ctx: CastleWorkerDrainContext<TIssueTemplate>,
  ): TProcessInput;
  runnerCircuit?: {
    isOpen(runner: Runner): Promise<boolean>;
  };
  emit(line: string): void;
  dispatchSessionHook?(
    name: CastleSessionHookName,
    context: string,
  ): Promise<{ aborted: boolean }>;
  labels?: CastleSelectionLabels;
}

export const CASTLE_NO_MORE_TASKS = "<promise>NO MORE TASKS</promise>";

function otherRunner(runner: Runner, initial: Runner): Runner {
  if (runner !== initial) return initial;
  if (initial === "claude-minimax") return "claude";
  if (initial === "claude") return "codex";
  return "claude";
}

function classify(outcome: CastleWorkerOutcome): "done" | "blocked" | "failed" {
  switch (outcome) {
    case "done":
      return "done";
    case "claim-lost":
    case "hook-aborted":
      return "failed";
    default:
      return "blocked";
  }
}

function budgetSpent(snapshot: CastleWorkerDrainBudgetSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.cap > 0 && snapshot.used >= snapshot.cap;
}

export async function runCastleWorkerDrain<
  TBootDeps,
  TBootOptions,
  TBootResult extends { precheck: { ok: boolean } },
  TProcessDeps,
  TProcessInput extends { runner: Runner },
  TProcessResult extends CastleWorkerProcessResult,
  TIssueTemplate = unknown,
>(
  deps: CastleWorkerDrainDeps<
    TBootDeps,
    TBootOptions,
    TBootResult,
    TProcessDeps,
    TProcessInput,
    TProcessResult,
    TIssueTemplate
  >,
  ctx: CastleWorkerDrainContext<TIssueTemplate>,
): Promise<CastleWorkerDrainSummary<TBootResult>> {
  const sessionHooksFired: CastleSessionHookName[] = [];
  const fireSessionHook = async (name: CastleSessionHookName, context: string): Promise<boolean> => {
    if (!deps.dispatchSessionHook) return true;
    sessionHooksFired.push(name);
    const result = await deps.dispatchSessionHook(name, context);
    return !result.aborted;
  };
  const statsContext = (done: number, blocked: number, total: number): string =>
    JSON.stringify({
      runner: ctx.runner,
      worker_id: ctx.workerId,
      stats: { done, blocked, total },
    });

  const nowMs = ctx.policy?.nowMs ?? (() => Date.now());
  const startedMs = nowMs();
  const boot = await deps.runBoot(deps.bootDeps, deps.bootOptions);
  const empty: CastleWorkerDrainSummary<TBootResult> = {
    runner: ctx.runner,
    workerId: ctx.workerId,
    done: 0,
    blocked: 0,
    failed: 0,
    total: 0,
    boot,
    processed: [],
    drained: false,
    exhausted: false,
    runnerTransient: false,
    hostConfig: false,
    sessionHooksFired,
  };

  if (!boot.precheck.ok) return empty;

  if (ctx.bootOnly) {
    deps.emit(
      ctx.sweepsSkipped
        ? "boot complete (--boot-only): sweeps skipped (supervisor-owned), no issues processed"
        : "boot complete (--boot-only): sweeps ran, no issues processed",
    );
    return empty;
  }

  try {
    if (!(await fireSessionHook("pre_session", statsContext(0, 0, 0)))) return empty;

    await fireSessionHook("pre_pick", JSON.stringify({ filter: ctx.filter }));
    const candidates = await deps.gh.listCandidates();
    const queue = selectCastleIssues(candidates, ctx.filter, deps.labels);
    const total = queue.length;
    await fireSessionHook("post_pick", JSON.stringify({ issues: queue.map((candidate) => candidate.number) }));

    if (total === 0) {
      await fireSessionHook("on_idle", statsContext(0, 0, 0));
      deps.emit(CASTLE_NO_MORE_TASKS);
      await fireSessionHook("post_session", statsContext(0, 0, 0));
      return { ...empty, total: 0, drained: true, stopReason: "drain-empty" };
    }

    const cap = ctx.iterCap && ctx.iterCap > 0 ? ctx.iterCap : total;
    const processed: CastleWorkerDrainProcessed[] = [];
    let done = 0;
    let blocked = 0;
    let failed = 0;
    let exhaustedStop = false;
    let runnerTransientStop = false;
    let hostConfigStop = false;
    let stopReason: CastleWorkerStopReason | undefined;
    let activeRunner: Runner = ctx.runner;
    const hostCapabilities = resolveHostCapabilities(ctx.hostProfile);

    for (let i = 0; i < queue.length; i++) {
      if (ctx.policy?.supervisorKilled?.()) {
        stopReason = "supervisor-kill";
        break;
      }
      if (budgetSpent(ctx.policy?.budget?.())) {
        stopReason = "budget-cap";
        break;
      }
      if (ctx.policy?.maxRuntimeMs !== undefined && nowMs() - startedMs >= ctx.policy.maxRuntimeMs) {
        stopReason = "lifetime-cap";
        break;
      }
      if (ctx.policy?.maxIssues !== undefined && processed.length >= ctx.policy.maxIssues) {
        stopReason = "lifetime-cap";
        break;
      }
      if (i >= cap) {
        stopReason = "iter-cap";
        break;
      }

      const candidate = queue[i]!;
      const issueRunner = ctx.alternate ? activeRunner : ctx.runner;
      if (!hostCapabilities.runners.includes(issueRunner)) {
        stopReason = "runner-unavailable";
        deps.emit(
          `runner ${issueRunner} unavailable in host capability profile — skipping dispatch`,
        );
        break;
      }
      if (
        deps.runnerCircuit &&
        (await deps.runnerCircuit.isOpen(issueRunner))
      ) {
        runnerTransientStop = true;
        stopReason = "runner-unavailable";
        deps.emit(`runner ${issueRunner} circuit open — stopping before claiming more issues`);
        break;
      }

      const input = deps.buildProcessInput(candidate, ctx);
      const perIssueInput = ctx.alternate ? { ...input, runner: issueRunner } : input;
      const result = await deps.processIssue(deps.processDeps, perIssueInput);
      const bucket = classify(result.outcome);
      if (bucket === "done") done++;
      else if (bucket === "blocked") blocked++;
      else failed++;
      processed.push({ issue: candidate.number, outcome: result.outcome });

      const idx = i + 1;
      const pct = Math.floor((idx * 100) / total);
      const remaining = total - idx;
      deps.emit(`progress: ${idx}/${total} (${pct}%) — ${remaining} remaining`);

      if (result.outcome === "exhausted") {
        exhaustedStop = true;
        stopReason = "exhausted";
        break;
      }
      if (result.outcome === "runner-transient") {
        runnerTransientStop = true;
        stopReason = "runner-unavailable";
        break;
      }
      if (result.outcome === "host-config") {
        hostConfigStop = true;
        stopReason = "host-config";
        break;
      }
      if (ctx.once && result.outcome !== "claim-lost") {
        stopReason = "once";
        break;
      }
      if (ctx.policy?.shouldRetire?.()) {
        stopReason = "graceful-retirement";
        break;
      }
      if (ctx.alternate) activeRunner = otherRunner(activeRunner, ctx.runner);
    }

    await fireSessionHook("post_session", statsContext(done, blocked, total));
    if (stopReason) deps.emit(`worker stop: ${stopReason}`);

    return {
      runner: ctx.runner,
      workerId: ctx.workerId,
      done,
      blocked,
      failed,
      total,
      boot,
      processed,
      drained: false,
      exhausted: exhaustedStop,
      runnerTransient: runnerTransientStop,
      hostConfig: hostConfigStop,
      sessionHooksFired,
      stopReason,
    };
  } catch (error) {
    await fireSessionHook(
      "on_session_error",
      JSON.stringify({
        runner: ctx.runner,
        worker_id: ctx.workerId,
        error: { message: error instanceof Error ? error.message : String(error) },
      }),
    );
    throw error;
  }
}
