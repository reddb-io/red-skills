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
import type { BootDeps, BootOptions, BootResult } from "./boot.js";
import type {
  ProcessIssueDeps,
  ProcessIssueInput,
  ProcessIssueResult,
} from "./process-issue.js";
import type { HookExec } from "./hook-dispatcher.js";
import type { ResolveHooksOptions, HookName } from "./hook-config.js";
import type { ConfigValues } from "./config.js";
import type { Runner } from "../types/runner.js";
import type { WorkSelector } from "@reddb-io/worker/engine";

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

/**
 * The id this Worker answers to — ADOPTED when the host assigned one. PURE.
 *
 * **One Worker, one id** (#3081). A Worker born through the daemon is handed its
 * identity in `RED_AFK_WORKER_ID`: the host recorded that exact string on its
 * event lane, keyed its budget and its unit by it, and told every one of its
 * surfaces about it before this process existed. Minting a second id here would
 * leave the host and the work naming one Worker differently, and there is no
 * later join that recovers from that — which is precisely what happened while
 * the launch env never reached the process: `project_status` compared daemon
 * UUIDs against project `wXXXX` handles, matched nothing, and rendered a busy
 * fleet as an empty one.
 *
 * **There is deliberately no collision fallback on the assigned id.** A probe
 * that regenerated on collision is an id generator that runs after the host has
 * already named the Worker, which is the defect rather than a safety net: the
 * assigned string is a fact, not a preference. Only a `run` invoked directly —
 * no daemon, no assignment — mints, and that is what keeps the standalone lane
 * working.
 *
 * @param assigned the value of `RED_AFK_WORKER_ID`; empty/absent when unassigned.
 * @param exists true when `.red/tmp/workers/{id}/` is already taken.
 */
export function resolveWorkerId(
  assigned: string | undefined,
  exists: (id: string) => boolean = () => false,
  rand: () => number = Math.random,
): string {
  const handed = (assigned ?? "").trim();
  return handed !== "" ? handed : genWorkerId(rand, exists);
}

// ---------- issue selection (pure) ----------

/** One candidate from `gh issue list --json number,title,labels,body,author`.
 * The labels are the flat name list jq projects from `.labels | map(.name)`. */
export interface IssueCandidate {
  number: number;
  title: string;
  body: string;
  labels: string[];
  /** GitHub login of the issue author (creator); a `user` selector facet never
   * matches a candidate without it. */
  author?: string;
}

/** The selection filter, mirroring FILTER_KIND/FILTER_VALUE. `issues` keeps the
 * argument order; `spec` keeps spec-linked Tickets; `all` keeps every remainder;
 * `selector` is a NAMED FLEET's work scope — every facet present narrows the
 * pool, so a producer drains only the slice its work policy declares. */
export type SelectionFilter =
  | { kind: "all" }
  | { kind: "issues"; numbers: number[] }
  | { kind: "spec"; spec: number }
  | { kind: "selector"; selector: WorkSelector };

import { LABEL_TYPE_SPEC, LABEL_URGENT, LABEL_HIGH, LABEL_READY, LABEL_TYPE_SCOUT } from "./triage-labels.js";

function hasLabel(c: IssueCandidate, label: string): boolean {
  return c.labels.includes(label);
}

/** spec-link test: `spec: #N` / `spec: N` in the body, or a `spec:N` label.
 * Mirrors the select_issues `spec` jq clause (body regex + label index). */
function matchesSpec(c: IssueCandidate, spec: number): boolean {
  if (hasLabel(c, `spec:${spec}`)) return true;
  // `spec:\s*#?<N>\b` — optional whitespace, optional `#`, then the number on a
  // word boundary (so spec:24 does not match a spec:240 candidate).
  return new RegExp(`spec:\\s*#?${spec}\\b`).test(c.body ?? "");
}

/**
 * The producer's work-scope test: every facet the selector declares must hold
 * (AND), so `{spec, lane}` keeps only that Spec's Tickets inside that lane. An
 * empty selector matches everything — a producer with no scope drains the whole
 * backlog, exactly like the `all` filter.
 *
 * Keep in sync with `matchesWorkSelector` in
 * `packages/worker/src/engine/worker-drain.ts` — the castle copy drives the
 * live drain; this copy backs the dev-side previews.
 */
export function matchesSelector(c: IssueCandidate, selector: WorkSelector): boolean {
  if (selector.spec !== undefined && !matchesSpec(c, selector.spec)) return false;
  if (selector.lane !== undefined && !hasLabel(c, `lane:${selector.lane}`)) return false;
  if (selector.label !== undefined && !hasLabel(c, selector.label)) return false;
  if (selector.issues !== undefined && !selector.issues.includes(c.number)) return false;
  // AND over every requested tag: a candidate missing any of them — including
  // a fully untagged candidate — falls outside the territory.
  if (selector.tags !== undefined && !selector.tags.every((tag) => hasLabel(c, `tag:${tag}`)))
    return false;
  if (
    selector.user !== undefined &&
    (c.author === undefined || c.author.toLowerCase() !== selector.user.toLowerCase())
  )
    return false;
  return true;
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


/** Derive the execution run-mode for a fleet candidate from its labels.
 * A `type:scout` label activates read-only investigation mode — no commits,
 * no push, no PR. The caller's explicit `flagRunMode` (from `--run-mode`) wins
 * when both are set, so CLI overrides always take priority. Issues WITHOUT
 * `type:scout` return `undefined` (normal ship dispatch — unaffected). */
export function runModeForCandidate(candidate: IssueCandidate, flagRunMode?: string): string | undefined {
  if (flagRunMode !== undefined) return flagRunMode;
  if (candidate.labels.includes(LABEL_TYPE_SCOUT)) return "scout";
  return undefined;
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
  /**
   * The fleet supervisor already ran the shared boot sweeps before spawning this
   * worker (#623, `RED_AFK_SWEEPS_DONE`): the worker booted bootstrap+claim only.
   * Purely informational — it only shapes the `--boot-only` line so the dry-run
   * reports the sweeps as supervisor-owned rather than worker-run. The actual
   * skip is driven by `BootOptions.skipSweeps` in `runBoot`, not here.
   */
  sweepsSkipped?: boolean;
  /** Long-running worker stop policy. Omitted fields leave that exit disabled. */
  policy?: SessionStopPolicy;
}

export type SessionStopReason =
  | "drain-empty"
  | "lifetime-cap"
  | "budget-cap"
  | "supervisor-kill"
  | "graceful-retirement"
  | "iter-cap"
  | "once"
  | "runner-unavailable"
  | "exhausted";

export interface SessionBudgetSnapshot {
  used: number;
  cap: number;
}

export interface SessionStopPolicy {
  /** Stop after this many successfully claimed/processed issue slots. */
  maxIssues?: number;
  /** Stop once wall-clock runtime reaches this many milliseconds. */
  maxRuntimeMs?: number;
  /** Optional runtime clock for deterministic tests. Defaults to Date.now. */
  nowMs?: () => number;
  /** Stop before claiming when the session budget is spent. */
  budget?: () => SessionBudgetSnapshot;
  /** Supervisor-requested hard stop before the next claim. */
  supervisorKilled?: () => boolean;
  /** Finish the current issue, then retire without claiming another. */
  shouldRetire?: () => boolean;
}

/**
 * Toggle a runner to the other backend for --alternate rotation.
 * The pair is determined by the initial runner so every run is a two-runner cycle:
 *   claude-minimax ↔ claude  (new pair; claude-minimax is paired with claude)
 *   claude         ↔ codex   (original pair when the session starts on claude)
 *   codex/opencode ↔ claude  (everything else pairs with claude)
 */
function otherRunner(r: Runner, initial: Runner): Runner {
  if (r !== initial) return initial;
  if (initial === "claude-minimax") return "claude";
  if (initial === "claude") return "codex";
  return "claude";
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
 * queued candidate. Keeps the workspace-dir / ordinal / base-input wiring
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
  /**
   * Shared runner circuit breaker. When another worker already observed a
   * runner transport/setup outage, stop before claiming the next issue.
   */
  runnerCircuit?: {
    isOpen(runner: Runner): Promise<boolean>;
  };
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
  /** Why this long-running worker stopped, when a named stop condition fired. */
  stopReason?: SessionStopReason;
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

function budgetSpent(snapshot: SessionBudgetSnapshot | undefined): boolean {
  return snapshot !== undefined && snapshot.cap > 0 && snapshot.used >= snapshot.cap;
}

function emitStop(deps: SessionDeps, reason: SessionStopReason): void {
  deps.emit(`worker stop: ${reason}`);
}

