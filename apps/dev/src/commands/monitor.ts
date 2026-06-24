import { renderCompactDashboard, type CompactWorker } from "../core/monitor.js";
import { collectMonitorInputs } from "../runtime/wire.js";
import { resolveSupervisorConfig } from "../core/supervisor.js";
import { runWatchdog } from "../core/watchdog.js";
import { buildWatchdogIO } from "../runtime/watchdog-io.js";
import {
  mirrorPlan,
  codexSinkPlan,
  taskMirrorCapability,
  type MirrorCall,
  type TaskMirrorHost,
  type TrackedTask,
  type WorkerRecord,
} from "../core/mirror.js";

/**
 * Map the dashboard's live worker inputs onto the desired WorkerRecord set the
 * mirror reconciler consumes. This is the same normalization `readWorkers`
 * performs, applied to the compact dashboard's CompactWorker shape so the mirror
 * sees exactly the same live/dead/stage the dashboard renders: a worker between
 * issues (no current number) owns no task and is omitted; live → running,
 * not-live → gone (surfaced terminal).
 */
export function workersToDesired(workers: readonly CompactWorker[]): WorkerRecord[] {
  const out: WorkerRecord[] = [];
  for (const w of workers) {
    const number = w.state.current.number;
    if (number === "" || number === null || number === undefined) continue;
    const issue = typeof number === "number" ? number : Number(number);
    if (!Number.isFinite(issue)) continue;
    const phase = w.state.current.phase ?? "";
    out.push({
      worker_id: w.state.worker_id,
      issue,
      title: w.state.current.title,
      slug: w.state.current.slug || w.state.current.title,
      stage: w.state.current.stage,
      phase,
      started_at: w.state.current.started_at || w.state.started_at,
      // A dead worker whose last macro phase is `blocked` is a terminal failure
      // (→ task failed); any other dead worker is a normal completion (→ gone).
      status: w.live ? "running" : phase === "blocked" ? "blocked" : "gone",
    });
  }
  return out;
}

/** Parse the tracked-task JSONL (one TrackedTask per line) read from the agent's
 * current mirror-owned task list. Blank lines and unparseable lines are skipped;
 * empty input → empty tracked set (a cold reconcile). */
export function parseTrackedJsonl(text: string): TrackedTask[] {
  const out: TrackedTask[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    const rec = parsed as { key?: unknown; stage?: unknown; phase?: unknown };
    if (typeof rec.key !== "string") continue;
    out.push({
      key: rec.key,
      stage: typeof rec.stage === "string" ? rec.stage : "",
      phase: typeof rec.phase === "string" ? rec.phase : "",
    });
  }
  return out;
}

export interface MirrorPlanOptions {
  /** The host whose Task-mirror capability picks the sink. Default "claude". */
  host?: TaskMirrorHost;
  /** Legacy shorthand for `host: "codex"`; ignored when `host` is set. */
  codex?: boolean;
}

/**
 * Pure, testable core of `monitor --mirror-plan`: given the live worker inputs,
 * the tracked-task JSONL, and the host, compute the mirror call plan and emit
 * it as JSONL (one MirrorCall per line, trailing newline). An empty plan yields
 * the empty string (idempotent: nothing changed → no output).
 *
 * The sink is picked by the host's {@link taskMirrorCapability}, keeping each
 * adapter explicit per runner (issue #886 / ADR 0003) — never a generic merge:
 *   native-task   (claude)   → mirrorPlan, the host TaskCreate/TaskUpdate sink.
 *   monitor-agent (codex)    → codexSinkPlan, empty today (dashboard fallback).
 *   headless      (opencode) → empty plan, no host session to mirror into.
 */
export function runMirrorPlan(
  workers: readonly CompactWorker[],
  trackedJsonl: string,
  options: MirrorPlanOptions = {},
): string {
  const desired = workersToDesired(workers);
  const tracked = parseTrackedJsonl(trackedJsonl);
  const host: TaskMirrorHost = options.host ?? (options.codex ? "codex" : "claude");
  let calls: MirrorCall[];
  switch (taskMirrorCapability(host).surface) {
    case "native-task":
      calls = mirrorPlan(desired, tracked);
      break;
    case "monitor-agent":
      calls = codexSinkPlan(desired, tracked).plan;
      break;
    case "headless":
      // OpenCode is a headless Worker with no in-session surface — no native
      // calls are ever emitted, so the plan is always empty.
      calls = [];
      break;
  }
  if (calls.length === 0) return "";
  return `${calls.map((c) => JSON.stringify(c)).join("\n")}\n`;
}

/** Read all of stdin to a string (empty when nothing is piped / TTY). */
async function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stdin) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * `monitor [--once]` — native compact dashboard. Globs the worker state files
 * and reads the history ledger (no bash), then renders via the pure
 * renderCompactDashboard.
 *
 * `monitor --mirror-plan [--runner codex | --codex]` — one-shot Task-mirror
 * mode: read the agent's tracked mirror tasks as JSONL from stdin, diff against
 * the live worker state (the same reads the dashboard uses), and emit the mirror
 * call plan as JSONL to stdout for the agent to apply via TaskCreate/TaskUpdate.
 * Renders no dashboard; empty plan → no output.
 */
export async function monitorCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  if (args.includes("--mirror-plan")) {
    const runnerIdx = args.indexOf("--runner");
    const runnerFlag = runnerIdx !== -1 ? args[runnerIdx + 1] : undefined;
    const host: TaskMirrorHost =
      args.includes("--codex") || args.includes("--runner=codex") || runnerFlag === "codex"
        ? "codex"
        : args.includes("--runner=opencode") || runnerFlag === "opencode"
          ? "opencode"
          : "claude";
    const { workers } = await collectMonitorInputs(cwd);
    const trackedJsonl = await readStdin(stdin);
    const out = runMirrorPlan(workers, trackedJsonl, { host });
    if (out !== "") stdout.write(out);
    return 0;
  }

  // Recovery watchdog (#407): a supervisor whose #406 heartbeat is stale past
  // RED_AFK_SUPERVISOR_STALE_S is hard-hung (live PID, drain loop wedged), and
  // the watchdog tears it down and relaunches a fresh fleet. That is a real
  // side effect, so `monitor` — a read-only dashboard the operator reaches for
  // to *observe* the fleet — must NOT run it by default (#589): an inspect must
  // never start/stop a supervisor. It is now strictly OPT-IN, for a caller that
  // wants the dashboard to double as the recovery tick (`monitor --watchdog`,
  // or RED_AFK_WATCHDOG=1 for a recurring loop). Best-effort — a watchdog
  // failure never blocks the render.
  const watchdogRequested = args.includes("--watchdog") || process.env.RED_AFK_WATCHDOG === "1";
  if (watchdogRequested) {
    try {
      const supervisorCfg = resolveSupervisorConfig();
      await runWatchdog(buildWatchdogIO(cwd, stdout), supervisorCfg.supervisorStaleS, supervisorCfg.progressStaleS);
    } catch {
      // best-effort: recovery must never break monitoring.
    }
  }

  const { workers, events, fleet } = await collectMonitorInputs(cwd);
  const now = Math.floor(Date.now() / 1000);
  const dashboard = renderCompactDashboard(workers, events, now, fleet);
  stdout.write(`${dashboard}\n`);
  return 0;
}
