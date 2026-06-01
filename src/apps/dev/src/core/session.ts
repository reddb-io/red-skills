// session — the AFK outer session loop + issue selection, ported from afk.sh's
// select_issues (~905-962), slugify (~901) / gen_worker_id (~124), and the MAIN
// LOOP at the bottom (~3441-3524): pre/post pick → on empty queue emit
// NO MORE TASKS → for each queued number (under the -n cap) call process_issue,
// accumulate AGG_DONE/AGG_BLOCKED, emit a progress line per issue → post-loop
// summary. Plus the "Issue Selection" / "Stop Conditions" / "Reporting"
// sections of SKILL.md (authoritative for the selection rules + the sentinel).
//
// This is the LAST orchestrator: it composes runBoot (boot.ts) and processIssue
// (process-issue.ts) into one drain. Like the other core orchestrators it is
// PURE SEQUENCING — it owns the queue-selection rule (selectIssues, pure) and
// the outer loop SEQUENCE + stop conditions; every gh/git/fs/clock/process side
// effect is injected. No real IO lives here.

import { slugifyRef } from "./remote-branch.js";
import { runBoot, type BootDeps, type BootOptions, type BootResult } from "./boot.js";
import {
  processIssue,
  type ProcessIssueDeps,
  type ProcessIssueInput,
  type ProcessIssueResult,
} from "./process-issue.js";
import { dispatchHooks, type HookExec } from "./hook-dispatcher.js";
import { resolveHooks, type ResolveHooksOptions, type ResolvedHooks, type HookName } from "./hook-config.js";
import type { ConfigValues } from "./config.js";
import type { Runner } from "../types/runner.js";

// ---------- pure helpers (slugify / gen_worker_id) ----------

/** Lowercase / collapse-to-dash / trim / cap-40 title slug. afk.sh's `slugify`
 * delegates straight to `afk_ref_slugify`, so this is a re-export of the shared
 * `slugifyRef` (lib/branch-ref.sh) for selection-site callers. */
export const slugify = slugifyRef;

/** The worker-id alphabet: literal "w" + 4 chars from [A-Z0-9] (e.g. wZ2R4). */
const WORKER_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/**
 * Generate a worker id — `"w"` + 4 chars from [A-Z0-9]. Mirrors
 * `gen_worker_id`: it regenerates until `exists(id)` is false so a fresh worker
 * never collides with a live/retained worker tree. Both the randomness and the
 * collision probe are injected so the function stays pure and deterministic.
 *
 * @param rand returns a float in [0, 1) per call (4 calls per candidate id).
 * @param exists true when `.red/tmp/workers/{id}/` already exists (collision).
 */
export function genWorkerId(rand: () => number, exists: (id: string) => boolean = () => false): string {
  for (;;) {
    let id = "w";
    for (let i = 0; i < 4; i++) {
      const idx = Math.min(WORKER_ID_ALPHABET.length - 1, Math.floor(rand() * WORKER_ID_ALPHABET.length));
      id += WORKER_ID_ALPHABET[idx];
    }
    if (!exists(id)) return id;
  }
}

// ---------- issue selection (pure) ----------

/** One candidate from `gh issue list --json number,title,labels,body,author`.
 * The labels are the flat name list jq projects from `.labels | map(.name)`. */
export interface IssueCandidate {
  number: number;
  title: string;
  body: string;
  labels: string[];
}

/** The selection filter, mirroring FILTER_KIND/FILTER_VALUE. `issues` keeps the
 * argument order; `prd` keeps prd-linked issues; `all` keeps every remainder. */
export type SelectionFilter =
  | { kind: "all" }
  | { kind: "issues"; numbers: number[] }
  | { kind: "prd"; prd: number };

const LABEL_PRD = "type:prd";
const LABEL_URGENT = "priority:urgent";
const LABEL_HIGH = "priority:high";
const LABEL_READY = "ready-for-agent";

function hasLabel(c: IssueCandidate, label: string): boolean {
  return c.labels.includes(label);
}

/** prd-link test: `prd: #N` / `prd: N` in the body, or a `prd:N` label.
 * Mirrors the select_issues `prd` jq clause (body regex + label index). */
function matchesPrd(c: IssueCandidate, prd: number): boolean {
  if (hasLabel(c, `prd:${prd}`)) return true;
  // `prd:\s*#?<N>\b` — optional whitespace, optional `#`, then the number on a
  // word boundary (so prd:24 does not match a prd:240 candidate).
  return new RegExp(`prd:\\s*#?${prd}\\b`).test(c.body ?? "");
}

/** Stable priority sort for the non-urgent remainder: `priority:high` (rank 0)
 * before everything else (rank 1), then issue number ascending. */
function sortByPriority(list: IssueCandidate[]): IssueCandidate[] {
  return [...list].sort((a, b) => {
    const ra = hasLabel(a, LABEL_HIGH) ? 0 : 1;
    const rb = hasLabel(b, LABEL_HIGH) ? 0 : 1;
    if (ra !== rb) return ra - rb;
    return a.number - b.number;
  });
}

/** A candidate-list problem `selectIssues` raises for the `--issues` path —
 * mirrors the bash "Error if any are missing or not labelled ready-for-agent". */
export class IssueSelectionError extends Error {
  constructor(
    message: string,
    /** The offending issue numbers (missing-from-candidates or unlabelled). */
    readonly numbers: number[],
  ) {
    super(message);
    this.name = "IssueSelectionError";
  }
}

/**
 * PURE queue selection, exactly per SKILL.md "Issue Selection". Operates on the
 * already-listed candidate pool (the caller injects the `gh issue list` result),
 * applying — in order:
 *
 *   1. PRD exclusion (hard): drop every `type:prd` candidate before any filter.
 *   2. Urgent prepend (hard, ahead of filters): split out `priority:urgent`;
 *      they jump the head sorted by number ascending (oldest fires first).
 *   3. Filter the non-urgent remainder:
 *        - issues: keep the requested numbers in ARGUMENT order; throw an
 *          IssueSelectionError if any requested number is missing from the pool
 *          or (present but) not labelled ready-for-agent. type:prd numbers were
 *          already dropped in step 1, so an explicit PRD reads as "missing".
 *        - prd: keep candidates with a prd:#N body ref / prd:N label.
 *        - all: keep the whole remainder.
 *      The filtered remainder is sorted priority:high→rest, then number asc.
 *   4. Concat `[urgent…] + [filtered…]`, deduped by number keeping the urgent
 *      slot at the front.
 */
export function selectIssues(candidates: readonly IssueCandidate[], filter: SelectionFilter): IssueCandidate[] {
  // 1. PRD exclusion (hard).
  const pool = candidates.filter((c) => !hasLabel(c, LABEL_PRD));

  // 2. Urgent prepend — split, sorted by number ascending.
  const urgent = pool.filter((c) => hasLabel(c, LABEL_URGENT)).sort((a, b) => a.number - b.number);
  const rest = pool.filter((c) => !hasLabel(c, LABEL_URGENT));

  // 3. Filter the non-urgent remainder.
  let filtered: IssueCandidate[];
  switch (filter.kind) {
    case "issues": {
      const byNumber = new Map(rest.map((c) => [c.number, c] as const));
      // A requested number is "unselectable" when it is absent from the
      // ready-for-agent pool entirely. (The pool is the ready-for-agent list,
      // so absence covers both missing and not-labelled-ready-for-agent.)
      const ordered: IssueCandidate[] = [];
      const missing: number[] = [];
      for (const n of filter.numbers) {
        const c = byNumber.get(n);
        if (c) ordered.push(c);
        else missing.push(n);
      }
      if (missing.length > 0) {
        throw new IssueSelectionError(
          `requested issue(s) missing from the ready-for-agent queue: ${missing.map((n) => `#${n}`).join(", ")}`,
          missing,
        );
      }
      filtered = ordered; // argument order preserved, no priority re-sort.
      break;
    }
    case "prd":
      filtered = sortByPriority(rest.filter((c) => matchesPrd(c, filter.prd)));
      break;
    case "all":
    default:
      filtered = sortByPriority(rest);
      break;
  }

  // 4. Concat [urgent…] + [filtered…], deduped by number (urgents win the slot).
  const urgentNumbers = new Set(urgent.map((c) => c.number));
  const tail = filtered.filter((c) => !urgentNumbers.has(c.number));
  return [...urgent, ...tail];
}

// ---------- the outer session loop ----------

/** Static session-level inputs the caller resolves once before `runSession`. */
export interface SessionContext {
  runner: Runner;
  workerId: string;
  /** Per-issue iteration cap (-n N). 0/undefined means "drain the whole queue". */
  iterCap?: number;
  /** Stop after the first processed issue (--once). */
  once?: boolean;
  filter: SelectionFilter;
  /** Static per-issue input fields the caller resolves once (repo/remote/dirs). */
  issueTemplate: SessionIssueTemplate;
  /**
   * --alternate: rotate the runner between consecutive issues
   * (claude → codex → claude → …). The first issue uses `runner`; each later
   * issue toggles. Off by default (every issue uses `runner`).
   */
  alternate?: boolean;
  /**
   * --boot-only: run the boot sweeps then exit without selecting/claiming/
   * processing — a dry-run for inspecting the boot, never spawns an agent.
   */
  bootOnly?: boolean;
}

/** Toggle a runner to the other backend (claude↔codex). */
function otherRunner(r: Runner): Runner {
  return r === "claude" ? "codex" : "claude";
}

/** The per-issue ProcessIssueInput fields that are identical across the drain.
 * `runSession` fills in the per-issue {issue,title,body,…} and attempt/dir on
 * top of these. Mirrors the loop reading TITLE/BODY per number while every
 * repo/worker constant is fixed for the session. */
export interface SessionIssueTemplate {
  tmpDir: string;
  repo: string;
  repoDir: string;
  remote: string;
  model?: string;
}

/** A function the caller injects to build the full ProcessIssueInput for one
 * queued candidate. Keeps the attempt-ledger / attempt-dir / base-input wiring
 * out of session.ts (that lives in the CLI), so the loop stays pure sequencing. */
export type BuildProcessInput = (
  candidate: IssueCandidate,
  ctx: SessionContext,
) => ProcessIssueInput;

/** The injected gh listing — the candidate pool the selection runs over. */
export interface SessionGh {
  /** gh issue list --label ready-for-agent --state open (projected to candidates). */
  listCandidates(): Promise<IssueCandidate[]>;
}

/** All injected IO + composed orchestrators for one session drain. The boot +
 * processIssue deps are surfaced through here so the loop never reaches a real
 * gh/git/fs/clock — exactly the parity seam the tests inject a fake into. */
export interface SessionDeps {
  /** Candidate listing (the `gh issue list` the selection consumes). */
  gh: SessionGh;
  /** Compose boot.ts: runs once at the top of the drain. */
  runBoot(deps: BootDeps, options: BootOptions): Promise<BootResult>;
  /** Boot deps + options, resolved by the caller. */
  bootDeps: BootDeps;
  bootOptions: BootOptions;
  /** Compose process-issue.ts: runs once per queued issue under the -n cap. */
  processIssue(deps: ProcessIssueDeps, input: ProcessIssueInput): Promise<ProcessIssueResult>;
  /** The shared per-issue deps (gh/git/fs/runAgent/hooks/…). */
  processDeps: ProcessIssueDeps;
  /** Build the per-issue ProcessIssueInput for a queued candidate. */
  buildProcessInput: BuildProcessInput;
  /** Emit one line of session output (progress lines + the NO MORE TASKS sentinel). */
  emit(line: string): void;
  /**
   * Session-scoped lifecycle hooks (PRD #207). When present, runSession fires
   * the session-level points — pre_session / pre_pick / post_pick / on_idle /
   * post_session / on_session_error — through the same dispatcher composed in
   * commands/run.ts. Absent → no session hooks fire (back-compat for callers /
   * tests that predate them).
   */
  hooks?: SessionHooks;
}

/** The session hook dispatch surface, mirroring ProcessHooks. resolveHooks runs
 * once at the top of the drain; dispatchHooks fires per point. */
export interface SessionHooks {
  config: ConfigValues;
  resolveOptions: ResolveHooksOptions;
  exec: HookExec;
  /** RED_AFK_* env handed to every hook command (defaults to {}). */
  env?: Record<string, string>;
}

export const NO_MORE_TASKS = "<promise>NO MORE TASKS</promise>";

/** The per-issue outcome bucketing the aggregate counters track. `done` is the
 * sole success; every other terminal outcome counts as blocked/failed for the
 * summary (mirroring AGG_DONE vs AGG_BLOCKED/AGG_FAILED). */
export interface SessionProcessed {
  issue: number;
  outcome: ProcessIssueResult["outcome"];
}

/** The session summary returned after the drain — the parity target for the
 * post-loop `/afk done. … processed: $AGG_DONE done, $AGG_BLOCKED blocked` line. */
export interface SessionSummary {
  runner: Runner;
  workerId: string;
  /** AGG_DONE — issues that closed green. */
  done: number;
  /** AGG_BLOCKED — issues that flipped to ready-for-human (blocked-family). */
  blocked: number;
  /** AGG_FAILED — issues whose attempt was lost/aborted before a clean outcome. */
  failed: number;
  /** AGG_TOTAL — the queued count (length of the selected queue, pre-cap). */
  total: number;
  /** The boot run outcome (precheck verdict + cleanup results). */
  boot: BootResult;
  /** Per-issue outcomes in processing order. */
  processed: SessionProcessed[];
  /** True when the queue was empty (NO MORE TASKS was emitted). */
  drained: boolean;
  /**
   * True when the drain stopped because an issue ended `exhausted` (both runners
   * exhausted, or a single exhaustion without --fallback-runner). The CLI threads
   * this into exit 75 (EX_TEMPFAIL) so a supervisor can retry once quota resets.
   */
  exhausted: boolean;
  /**
   * True when the drain stopped because the runner transport/setup path failed
   * before the inner agent could work. This is session-level backpressure: once
   * Codex/Claude is unavailable, do not keep claiming unrelated issues and
   * marking them transient.
   */
  runnerTransient: boolean;
  /** Session-scoped lifecycle points that fired, in order — the parity target. */
  sessionHooksFired: HookName[];
}

/** `done` is the only success; blocked/no-sentinel/merge-conflict/feedback flip
 * the issue to ready-for-human → AGG_BLOCKED; claim-lost/hook-aborted abandon
 * the attempt → AGG_FAILED. */
function classify(outcome: ProcessIssueResult["outcome"]): "done" | "blocked" | "failed" {
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

/**
 * Run the AFK outer session: boot → pre_session → select → drain → summary. The
 * SEQUENCE + the stop conditions + the session-scoped lifecycle hooks are the
 * parity target (afk.sh MAIN LOOP + PRD #207):
 *
 *   1. runBoot — the boot sequence runs once. A precheck FAILURE aborts the
 *      drain (the bash `die`): no listing, no NO MORE TASKS, an empty summary.
 *   2. pre_session — fires before any queue work; an abort (pre_* policy) stops
 *      the session before listing.
 *   3. pre_pick → selectIssues → post_pick around issue selection.
 *   4. Empty queue → on_idle, emit `<promise>NO MORE TASKS</promise>`, drained.
 *   5. For each queued number (1-based index `I`), stop once `I > iterCap`
 *      (the `-n` cap), call processIssue, accumulate done/blocked/failed, and
 *      emit the per-issue progress line. `--once` breaks after the first issue.
 *   6. post_session on normal end; on_session_error on a crash (the error is
 *      re-thrown after the notification so the CLI still sees the failure).
 *
 * Session hooks respect the exit-code policy: pre_ points abort, post_ / on_
 * points log and continue. They fire only when `deps.hooks` is wired.
 */
export async function runSession(deps: SessionDeps, ctx: SessionContext): Promise<SessionSummary> {
  const sessionHooksFired: HookName[] = [];
  const resolved: ResolvedHooks | undefined = deps.hooks
    ? resolveHooks(deps.hooks.config, deps.hooks.resolveOptions)
    : undefined;

  /** Fire a session-scoped point. Returns false only when a pre_* point aborts. */
  const fireSessionHook = async (name: HookName, context: string): Promise<boolean> => {
    if (!deps.hooks || !resolved) return true;
    sessionHooksFired.push(name);
    const result = await dispatchHooks(name, resolved[name], context, deps.hooks.exec, {
      env: deps.hooks.env ?? {},
    });
    return !result.aborted;
  };

  const statsContext = (done: number, blocked: number, total: number): string =>
    JSON.stringify({
      runner: ctx.runner,
      worker_id: ctx.workerId,
      stats: { done, blocked, total },
    });

  const empty: SessionSummary = {
    runner: ctx.runner,
    workerId: ctx.workerId,
    done: 0,
    blocked: 0,
    failed: 0,
    total: 0,
    boot: { precheck: { ok: true, warnings: [] } },
    processed: [],
    drained: false,
    exhausted: false,
    runnerTransient: false,
    sessionHooksFired,
  };

  // ---- 1. boot (precheck failure aborts the drain) ----
  const boot = await deps.runBoot(deps.bootDeps, deps.bootOptions);
  empty.boot = boot;
  if (!boot.precheck.ok) {
    return empty;
  }

  // ---- 1a. --boot-only: dry-run. The boot sweeps ran above; return before
  // any selection/claim/processing so no agent is ever spawned. ----
  if (ctx.bootOnly) {
    deps.emit("boot complete (--boot-only): sweeps ran, no issues processed");
    return { ...empty, boot };
  }

  try {
    // ---- 2. pre_session (before any queue work) — pre_* abort stops here ----
    if (!(await fireSessionHook("pre_session", statsContext(0, 0, 0)))) {
      return { ...empty, boot };
    }

    // ---- 3. pre_pick → select → post_pick ----
    await fireSessionHook("pre_pick", JSON.stringify({ filter: ctx.filter }));
    const candidates = await deps.gh.listCandidates();
    const queue = selectIssues(candidates, ctx.filter);
    const total = queue.length;
    await fireSessionHook("post_pick", JSON.stringify({ issues: queue.map((c) => c.number) }));

    // ---- 4. empty queue → on_idle → NO MORE TASKS ----
    if (total === 0) {
      await fireSessionHook("on_idle", statsContext(0, 0, 0));
      deps.emit(NO_MORE_TASKS);
      await fireSessionHook("post_session", statsContext(0, 0, 0));
      return { ...empty, boot, total: 0, drained: true };
    }

    // ---- 5. drain under the -n cap ----
    const cap = ctx.iterCap && ctx.iterCap > 0 ? ctx.iterCap : total;
    const processed: SessionProcessed[] = [];
    let done = 0;
    let blocked = 0;
    let failed = 0;
    let exhaustedStop = false;
    let runnerTransientStop = false;
    // --alternate: the runner rotates per issue. The first issue uses ctx.runner.
    let activeRunner: Runner = ctx.runner;

    for (let i = 0; i < queue.length; i++) {
      if (i >= cap) break; // -n N reached → stop the drain (Stop Conditions).
      const candidate = queue[i]!;
      const input = deps.buildProcessInput(candidate, ctx);
      // Override the per-issue runner when rotating (--alternate); without it
      // every issue keeps the resolved session runner.
      const perIssueInput = ctx.alternate ? { ...input, runner: activeRunner } : input;
      const result = await deps.processIssue(deps.processDeps, perIssueInput);

      const bucket = classify(result.outcome);
      if (bucket === "done") done++;
      else if (bucket === "blocked") blocked++;
      else failed++;
      processed.push({ issue: candidate.number, outcome: result.outcome });

      // Per-issue progress line: `progress: I/TOTAL (PCT%) — REMAINING remaining`.
      const idx = i + 1;
      const pct = Math.floor((idx * 100) / total);
      const remaining = total - idx;
      deps.emit(`progress: ${idx}/${total} (${pct}%) — ${remaining} remaining`);

      // Runner availability failures end the whole session: stop draining and
      // signal exit 75 (EX_TEMPFAIL). A dead backend is global enough that
      // claiming more issues just spreads blocked:runner-transient labels.
      if (result.outcome === "exhausted") {
        exhaustedStop = true;
        break;
      }
      if (result.outcome === "runner-transient") {
        runnerTransientStop = true;
        break;
      }

      if (ctx.once) break;
      if (ctx.alternate) activeRunner = otherRunner(activeRunner);
    }

    // ---- 6. post_session (normal end) ----
    await fireSessionHook("post_session", statsContext(done, blocked, total));

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
      sessionHooksFired,
    };
  } catch (error) {
    // on_session_error death-notification path: fire the crash hook (log-and-
    // continue policy) then re-throw so the CLI still surfaces the failure.
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
