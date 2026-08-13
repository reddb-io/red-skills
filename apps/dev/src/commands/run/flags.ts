import type { SelectionFilter } from "../../core/session.js";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { LABEL_GO_LANE, LABEL_SCOUT_LANE } from "../../core/triage-labels.js";
import { GO_KIND, GO_ORIGIN } from "../../core/go.js";
import { SCOUT_ORIGIN, SCOUT_WORKERS_SEGMENT } from "../../core/scout.js";
import { readFile } from "node:fs/promises";
import { isLivePid } from "../../runtime/kill-tree.js";
import { parseWorkSelector } from "@reddb-io/red-castle/engine";

export interface RunOptions {
  args: string[];
  cwd?: string;
}

interface ParsedRunFlags {
  filter: SelectionFilter;
  iterCap?: number;
  once: boolean;
  runnerFlag?: string;
  /** --model <slug>: override the resolved tier model for every tier (flag > env > config). */
  model?: string;
  /** --effort <e>: override the resolved tier effort (still provider-gated downstream). */
  effort?: string;
  request?: string;
  /** --alternate: rotate the runner between consecutive issues (claude↔codex). */
  alternate: boolean;
  /** --fallback-runner: swap runners mid-issue on RUNNER_EXHAUSTED. */
  fallbackRunner: boolean;
  /** --boot-only: run the boot sweeps then exit without selecting/claiming/processing. */
  bootOnly: boolean;
  /**
   * --reconcile-issue <n>: supervisor-dispatched reconcile worker mode (ADR 0055,
   * #562). Bypass the normal boot+session; validate-and-land the parked branch for
   * issue `n` without re-running the agent.
   */
  reconcileIssue?: number;
  /** --origin <label>: spawn-time provenance stamped on the worker state
   * (`"afk"` | `"go"` | …). Set by each entry point so the
   * monitor/statusline can render per-source counts. */
  origin?: string;
  /** --kind <kind>: castle worker kind recorded in state.toon (`afk`, `go`, or
   * `scout`). */
  kind?: string;
  /** --lane <label>: the candidate-listing label the session drains. Defaults
   * to `ready-for-agent` (the fleet). `/go` passes its isolated `lane:go` so
   * its dedicated worker sees only the minted disposable issue and the running
   * fleet never does. */
  lane?: string;
  /** --pre-pr: route the run through the hardened pre-PR pipeline before opening
   * the PR (the `/go` `no-mistakes` dispatch mode, issue #923). */
  prePr: boolean;
  /** --local-merge: land the branch by an approved local fast-forward instead of
   * opening a PR (the `/go` `local-only` dispatch mode, issue #923). */
  localMerge: boolean;
  /** --yolo: the opt-in autonomy bump (`/go +yolo`, issue #923). */
  yolo: boolean;
  /** --verify <cmd>: one-shot inline command appended to backpressure for a
   * single `/go` dispatch when no configured harness exists. */
  verifyCommand?: string;
  /** --go-verify-retries <n>: bounded post-DONE machine-gate retry cap for `/go`. */
  goVerifyRetries?: number;
  /** --run-mode <mode>: execution mode modifier forwarded to `processIssue`.
   * `"scout"` activates the read-only investigation path — no commits, no push,
   * no PR, no merge; the agent report is posted as a comment and the disposable
   * issue closes. Additional modes may be added by future dispatch tiers. */
  runMode?: string;
  /** --force: bypass the live-supervisor boot guard (#1027). Operator accepts
   * the collision risk; a warning is printed but the run proceeds. */
  force: boolean;
}

export interface RunDispatchIdentity {
  origin: string;
  kind: string;
  lane?: string;
}

/**
 * Shared fleet hygiene must never delay an explicit target. A supervisor has
 * already run the sweeps for its workers; a targeted solo dispatch defers them
 * to the next fleet/untargeted boot so its first issue operation is the claim.
 */
export function shouldSkipBootSweeps(
  filter: SelectionFilter,
  supervisorSweepsDone: boolean,
): boolean {
  return supervisorSweepsDone || filter.kind === "issues";
}

/** Boot-only Workers reconcile shared state; they never check out or process work. */
export function runNeedsAdmittedFork(flags: Pick<ParsedRunFlags, "bootOnly">): boolean {
  return !flags.bootOnly;
}

/** Raised when --alternate is combined with --runner (mutually exclusive). */
export class RunFlagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunFlagError";
  }
}

/**
 * Probe the fleet supervisor pid file. Returns `{ live: true, pid }` when a
 * running supervisor is detected, `{ live: false }` otherwise (no file, stale
 * pid, or invalid content). `checkLivePid` is injectable so tests can provide a
 * fake process probe without spawning real processes (#1027).
 */
export async function probeFleetSupervisor(
  pidFile: string,
  checkLivePid: (pid: number) => boolean = isLivePid,
): Promise<{ live: true; pid: number } | { live: false }> {
  try {
    const raw = (await readFile(pidFile, "utf8")).trim();
    if (!/^\d+$/.test(raw)) return { live: false };
    const pid = Number(raw);
    if (!checkLivePid(pid)) return { live: false };
    return { live: true, pid };
  } catch {
    return { live: false };
  }
}

/**
 * Detect a `/go` or `--scout` dispatch (#1087). These runs carry their own
 * castle worker kind and lane (`lane:go` / `lane:scout`, never
 * `ready-for-agent`) so they do not collide with a fleet drain. The
 * fleet-supervisor boot guard exists ONLY to stop a second fleet from stomping
 * the first; it must not apply to these isolated dispatches, which the SKILL.md
 * contract requires to boot "whether or not a fleet is up". Detected via the
 * flags threaded through the boot context, plus the legacy namespace env while
 * scout still migrates.
 */
export function isNamespacedDispatch(
  args: { origin?: string; kind?: string; lane?: string },
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (args.kind === GO_KIND || args.kind === SCOUT_ORIGIN) return true;
  if (args.origin === GO_ORIGIN || args.origin === SCOUT_ORIGIN) return true;
  if (args.lane === LABEL_GO_LANE || args.lane === LABEL_SCOUT_LANE) return true;
  const ns = env.RED_AFK_WORKERS_NAMESPACE;
  if (ns === SCOUT_WORKERS_SEGMENT) return true;
  return false;
}

/**
 * Apply the boot guard: refuse to start if a fleet supervisor is already live
 * (unless `--force` was passed). Returns `"refused"` when the caller should
 * abort, `"forced"` when the guard was bypassed with a warning, or `"clear"`
 * when no live supervisor was found.
 *
 * `exempt` (#1087) skips the `afk-supervisor.pid` check entirely for a
 * `/go`/`--scout` dispatch — an isolated, namespaced run that cannot collide
 * with the fleet, so a live supervisor must never block it.
 */
export async function checkBootGuard(
  pidFile: string,
  force: boolean,
  stdout: NodeJS.WritableStream,
  checkLivePid: (pid: number) => boolean = isLivePid,
  exempt = false,
): Promise<"refused" | "forced" | "clear"> {
  if (exempt) return "clear";
  const probe = await probeFleetSupervisor(pidFile, checkLivePid);
  if (!probe.live) return "clear";
  if (force) {
    stdout.write(`warn: --force: fleet supervisor pid=${probe.pid} is still running; collision risk accepted.\n`);
    return "forced";
  }
  stdout.write(
    `afk: a fleet supervisor is already running (pid=${probe.pid}).\n` +
      `  monitor the running fleet: /dev:afk fleet\n` +
      `  stop it first:             afk stop\n` +
      `  override (risk):           afk run --force\n`,
  );
  return "refused";
}

/** Parse a comma-separated issue list into an ordered, finite number list. */
function parseIssueList(raw: string): number[] {
  return raw.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n));
}

/**
 * Coerce a `--issues` value into the issues filter, rejecting an all-invalid
 * value. `--issues banana` (or any value yielding zero finite numbers) would
 * otherwise produce `{ kind: "issues", numbers: [] }`, which `selectIssues`
 * reads as "select nothing" — the run then silently drains only urgents (or
 * nothing). Erroring here forces the operator to fix the typo instead of
 * launching a worker that quietly does the wrong thing.
 */
function coerceIssuesFilter(raw: string): SelectionFilter {
  const numbers = parseIssueList(raw);
  if (numbers.length === 0) {
    throw new RunFlagError(`--issues requires at least one valid issue number (got: ${JSON.stringify(raw)})`);
  }
  return { kind: "issues", numbers };
}

/**
 * Coerce a `--selector` value into a NAMED FLEET's work-scope filter. The value
 * is the selector object as compact JSON (`{"spec":2303,"lane":"go"}`) — the
 * same encoding the supervisor forwards to each slot, so a fleet's scope survives
 * the launch → supervise → `run --once` hop intact.
 */
function coerceSelectorFilter(raw: string): SelectionFilter {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new RunFlagError(`--selector requires a JSON object (got: ${JSON.stringify(raw)})`);
  }
  try {
    return { kind: "selector", selector: parseWorkSelector(parsed) };
  } catch (err) {
    throw new RunFlagError(`--selector is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Coerce a `--tags` value into an ordered bare-value list. Comma-separated,
 * whitespace-trimmed; an all-empty value errors for the same reason
 * `coerceIssuesFilter` does — a silent empty list would launch a worker that
 * quietly drains the wrong scope.
 */
function coerceTagList(raw: string): string[] {
  const tags = raw.split(",").map((t) => t.trim()).filter(Boolean);
  if (tags.length === 0) {
    throw new RunFlagError(`--tags requires at least one tag value (got: ${JSON.stringify(raw)})`);
  }
  return tags;
}

/**
 * Fold `--tags`/`--user` into the base filter as selector facets. The selector
 * stays the single wire format: explicit flags win over the same field inside
 * `--selector` JSON, `--spec` merges into a selector filter (identical
 * semantics — `matchesSpec` is a selector facet), and `--issues` refuses the
 * combination outright: explicit issue numbers plus a territory filter is
 * contradictory, and the strict `issues`-kind erroring would be lost.
 */
function foldTerritoryFacets(
  filter: SelectionFilter,
  tags: string[] | undefined,
  user: string | undefined,
): SelectionFilter {
  if (tags === undefined && user === undefined) return filter;
  if (filter.kind === "issues") {
    throw new RunFlagError("--tags/--user cannot be combined with --issues");
  }
  const base: Record<string, unknown> =
    filter.kind === "selector"
      ? { ...filter.selector }
      : filter.kind === "spec"
        ? { spec: filter.spec }
        : {};
  if (tags !== undefined) base.tags = tags;
  if (user !== undefined) base.user = user;
  try {
    return { kind: "selector", selector: parseWorkSelector(base) };
  } catch (err) {
    throw new RunFlagError(`--tags/--user is invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Flag schema for the `run` command, expressed against the shared CLI layer
 * (`packages/shared/args.ts`, built over `cli-args-parser`). The coercions here
 * reproduce the exact semantics the dev suite asserts: `--spec`/`-n` map through
 * `Number`, `--issues` trims and filters to finite numbers, booleans are
 * present-or-absent, and `--request` accepts the `-r` short alias.
 */
const RUN_FLAG_SCHEMA = {
  spec: { kind: "value", coerce: (raw: string): SelectionFilter => ({ kind: "spec", spec: Number(raw) }) },
  issues: { kind: "value", coerce: coerceIssuesFilter },
  selector: { kind: "value", coerce: coerceSelectorFilter },
  tags: { kind: "value", coerce: coerceTagList },
  user: { kind: "value", coerce: (raw: string): string => raw.trim() },
  n: { kind: "value", coerce: (raw: string): number => Number(raw) },
  once: { kind: "boolean" },
  runner: { kind: "value", coerce: (raw: string): string => raw },
  model: { kind: "value", coerce: (raw: string): string => raw },
  effort: { kind: "value", coerce: (raw: string): string => raw },
  request: { kind: "value", aliases: ["r"], coerce: (raw: string): string => raw },
  alternate: { kind: "boolean" },
  "fallback-runner": { kind: "boolean" },
  "boot-only": { kind: "boolean" },
  "reconcile-issue": { kind: "value", coerce: (raw: string): number => Number(raw) },
  origin: { kind: "value", coerce: (raw: string): string => raw },
  kind: { kind: "value", coerce: (raw: string): string => raw },
  lane: { kind: "value", coerce: (raw: string): string => raw },
  "pre-pr": { kind: "boolean" },
  "local-merge": { kind: "boolean" },
  yolo: { kind: "boolean" },
  verify: { kind: "value", coerce: (raw: string): string => raw },
  "go-verify-retries": { kind: "value", coerce: (raw: string): number => Number(raw) },
  "run-mode": { kind: "value", coerce: (raw: string): string => raw },
  force: { kind: "boolean" },
} satisfies FlagSchema;

/** Parse the `run` flags: --spec N / --issues a,b,c / -n N / --once / --request / --runner. */
export function parseRunFlags(args: readonly string[]): ParsedRunFlags {
  const { values } = parseFlags(args, RUN_FLAG_SCHEMA);

  // --spec and --issues both feed `filter`; the last of the two in argv wins,
  // matching the original single-pass scan. Resolve order from the raw argv.
  let filter: SelectionFilter = { kind: "all" };
  let lastFilterPos = -1;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if ((arg === "--spec" || arg.startsWith("--spec=")) && values.spec !== undefined && i > lastFilterPos) {
      filter = values.spec as SelectionFilter;
      lastFilterPos = i;
    } else if ((arg === "--issues" || arg.startsWith("--issues=")) && values.issues !== undefined && i > lastFilterPos) {
      filter = values.issues as SelectionFilter;
      lastFilterPos = i;
    } else if ((arg === "--selector" || arg.startsWith("--selector=")) && values.selector !== undefined && i > lastFilterPos) {
      filter = values.selector as SelectionFilter;
      lastFilterPos = i;
    }
  }

  filter = foldTerritoryFacets(
    filter,
    values.tags as string[] | undefined,
    values.user as string | undefined,
  );

  const runnerFlag = values.runner as string | undefined;
  const alternate = values.alternate === true;
  // --alternate (round-robin rotation) is mutually exclusive with a pinned
  // --runner: pinning fixes one backend, rotation cycles them — asking for both
  // is contradictory (SKILL.md §Runner Fallback).
  if (alternate && runnerFlag !== undefined) {
    throw new RunFlagError("--alternate is mutually exclusive with --runner");
  }

  const rawReconcileIssue = values["reconcile-issue"];
  const reconcileIssue =
    typeof rawReconcileIssue === "number" && Number.isFinite(rawReconcileIssue) && rawReconcileIssue > 0
      ? rawReconcileIssue
      : undefined;

  return {
    filter,
    iterCap: values.n as number | undefined,
    once: values.once === true,
    runnerFlag,
    model: values.model as string | undefined,
    effort: values.effort as string | undefined,
    request: values.request as string | undefined,
    alternate,
    fallbackRunner: values["fallback-runner"] === true,
    bootOnly: values["boot-only"] === true,
    reconcileIssue,
    origin: values.origin as string | undefined,
    kind: values.kind as string | undefined,
    lane: values.lane as string | undefined,
    prePr: values["pre-pr"] === true,
    localMerge: values["local-merge"] === true,
    yolo: values.yolo === true,
    verifyCommand: values.verify as string | undefined,
    goVerifyRetries:
      typeof values["go-verify-retries"] === "number" && Number.isFinite(values["go-verify-retries"])
        ? values["go-verify-retries"] as number
        : undefined,
    runMode: values["run-mode"] as string | undefined,
    force: values.force === true,
  };
}

export function resolveRunDispatchIdentity(flags: Pick<ParsedRunFlags, "origin" | "kind" | "lane">): RunDispatchIdentity {
  const origin = flags.origin?.trim() || "afk";
  const kind = flags.kind?.trim() || origin;
  // The Worker kind is the durable lane declaration; `--lane` is only its
  // transport to candidate listing. Recovering the queue from kind/origin keeps
  // a /go or scout Worker isolated even when an older/skewed dispatch path drops
  // that optional argv pair (#3175). It also prevents a contradictory explicit
  // lane from collapsing an isolated Worker into the fleet pool.
  const declaredLane =
    kind === GO_KIND || origin === GO_ORIGIN
      ? LABEL_GO_LANE
      : kind === SCOUT_ORIGIN || origin === SCOUT_ORIGIN
        ? LABEL_SCOUT_LANE
        : undefined;
  const lane = declaredLane ?? flags.lane?.trim();
  return lane ? { origin, kind, lane } : { origin, kind };
}
