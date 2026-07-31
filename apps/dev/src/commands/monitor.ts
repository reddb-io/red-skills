import {
  renderCompactDashboard,
  renderCompactDashboardToon,
  type CompactWorker,
  type MonitorRemote,
} from "../core/monitor.js";
import { renderStatuslineLegend } from "../core/statusline-legend.js";
import { collectMonitorInputs, afkPaths, resolveRepoContext, resolveStatuslineCacheTtl } from "../runtime/wire.js";
import { createFileBootBreakerStore, isBreakerOpen } from "../core/supervisor/boot-breaker.js";
import { createEnginePaths } from "@reddb-io/red-castle/engine";
import { join } from "node:path";
import { loadConfig, getConfig } from "../core/config.js";
import {
  runCompanionPass,
  summarizeCompanionPass,
  resolveCompanionThresholds,
  resolveDriftCap,
} from "../runtime/companion-io.js";
import {
  mirrorPlan,
  codexSinkPlan,
  taskMirrorCapability,
  type MirrorCall,
  type MirrorFallbackNotice,
  type TaskMirrorHost,
  type TrackedTask,
  type WorkerRecord,
} from "../core/mirror.js";

/**
 * Map the dashboard's live worker inputs onto the desired WorkerRecord set the
 * mirror reconciler consumes. This is the same normalization `readWorkers`
 * performs, applied to the compact dashboard's CompactWorker shape so the mirror
 * sees exactly the same live/dead/activity the dashboard renders: a worker between
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
    const processLive = w.livenessVerdict
      ? w.livenessVerdict.status !== "stalled"
      : w.liveness
        ? w.liveness !== "dead"
        : (w.pidLive ?? w.live);
    out.push({
      worker_id: w.state.worker_id,
      issue,
      title: w.state.current.title,
      slug: w.state.current.slug || w.state.current.title,
      activity: w.state.current.activity,
      phase,
      started_at: w.state.current.started_at || w.state.started_at,
      // Terminal completion requires the pid to be gone. `w.live` is the
      // pid+freshness badge; when it is false but `pidLive` is true the worker is
      // merely `[quiet]` (e.g. long validation/merge wait) and must stay
      // in-progress on the native task surface.
      status: processLive ? "running" : phase === "blocked" ? "blocked" : "gone",
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
    const rec = parsed as { key?: unknown; activity?: unknown; stage?: unknown; phase?: unknown };
    if (typeof rec.key !== "string") continue;
    out.push({
      key: rec.key,
      activity:
        typeof rec.activity === "string" ? rec.activity : typeof rec.stage === "string" ? rec.stage : "",
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
  let notice: string | undefined;
  switch (taskMirrorCapability(host).surface) {
    case "native-task":
      calls = mirrorPlan(desired, tracked);
      break;
    case "monitor-agent": {
      // Codex has no native task API. codexSinkPlan always returns an empty call
      // plan plus a one-line fallback notice so the operator can see that task
      // mirroring is intentionally falling back to the dashboard, not silently
      // doing nothing. The notice is surfaced as a structured JSONL line — it
      // carries `signal`, never `call`, so it is not a task call descriptor.
      const sink = codexSinkPlan(desired, tracked);
      calls = sink.plan;
      notice = sink.notice;
      break;
    }
    case "headless":
      // OpenCode is a headless Worker with no in-session surface — no native
      // calls are ever emitted, so the plan is always empty.
      calls = [];
      break;
  }
  const callsOut =
    calls.length === 0 ? "" : `${calls.map((c) => JSON.stringify(c)).join("\n")}\n`;
  if (notice === undefined) return callsOut;
  const noticeRecord: MirrorFallbackNotice = { signal: "fallback-notice", message: notice };
  return `${callsOut}${JSON.stringify(noticeRecord)}\n`;
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
 * Renders no dashboard; empty plan → no output. For Codex (monitor-agent surface)
 * a `{ signal: "fallback-notice" }` line is always written so the operator knows
 * that native task mirroring is unavailable — never a silent no-op.
 */
export async function monitorCommand(
  args: string[],
  cwd = process.cwd(),
  stdout: NodeJS.WritableStream = process.stdout,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<number> {
  if (args.includes("--legend")) {
    stdout.write(`${renderStatuslineLegend()}\n`);
    return 0;
  }

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

  // The recovery watchdog is GONE with the process it watched (ADR 0130
  // Amendment 4, #2909). It existed to tear down a wedged per-project process
  // and relaunch it; a project now contributes a registration, and the daemon
  // that holds it owns process death — so `--watchdog` / `RED_AFK_WATCHDOG=1`
  // have nothing left to arm and are accepted-and-ignored rather than routed to
  // a launcher that no longer exists.

  const { workers, events, fleet, remoteQueue, remoteHuman, remoteQuarantine, remoteCacheAgeS } = await collectMonitorInputs(cwd);
  const now = Math.floor(Date.now() / 1000);
  // Stale-marker threshold: same resolved TTL the statusline writer uses (env >
  // afk.statusline_cache_ttl config > 180, #1217), so the monitor flags the cache
  // stale on exactly the boundary the writer refreshes it.
  const monitorCfg = loadConfig(afkPaths(cwd).configPath, { warn: () => undefined });
  const cacheTtlS = resolveStatuslineCacheTtl(process.env, (key) => getConfig(monitorCfg, key));
  const remote: MonitorRemote | undefined =
    remoteQueue !== undefined && remoteHuman !== undefined && remoteCacheAgeS !== undefined
      ? {
          queue: remoteQueue,
          human: remoteHuman,
          quarantine: remoteQuarantine ?? 0,
          cacheAgeS: remoteCacheAgeS,
          stale: remoteCacheAgeS >= cacheTtlS,
        }
      : undefined;
  // TOON is the default agent-facing wire format (PRD #928 / ADR 0081); `--plain`
  // restores the legacy compact text dashboard for a human TTY glance.
  // Crashloop breaker alert (#2527): an OPEN breaker is the loudest fleet fact
  // there is — render it above the dashboard so no operator can miss it.
  try {
    const breaker = await createFileBootBreakerStore(createEnginePaths(join(cwd, ".red"))).read();
    if (isBreakerOpen(breaker)) {
      stdout.write(
        `⛔ boot breaker OPEN: ${breaker!.count} identical boot deaths — ` +
          `signature=${breaker!.signature}; respawn suppressed, healer invoked. ` +
          `Fix the implicated state, then relaunch the fleet.\n`,
      );
    }
  } catch {
    // best-effort: breaker visibility must never break monitoring.
  }
  const dashboard = args.includes("--plain")
    ? renderCompactDashboard(workers, events, now, fleet, remote)
    : renderCompactDashboardToon(workers, events, now, fleet, remote);
  stdout.write(`${dashboard}\n`);

  // Companion (active) mode (#921, PRD #907). STRICTLY opt-in: without
  // `--companion` / `--active` the monitor is byte-for-byte the read-only
  // dashboard above (it has already returned all its output) and performs no gh
  // writes. With the flag, run ONE bounded drift-detection pass over the live
  // fleet — re-enqueueing a drifting worker's issue with a bounded correction
  // (write-only, idempotent), or escalating to ready-for-human at the cap. It
  // never kills a process; termination/respawn is the reaper + fleet's job.
  // `--dry-run` computes + prints the plan without any gh write.
  if (args.includes("--companion") || args.includes("--active")) {
    try {
      const paths = afkPaths(cwd);
      const repoCtx = await resolveRepoContext(cwd);
      const cfg = loadConfig(paths.configPath, { warn: () => undefined });
      const outcomes = await runCompanionPass({
        workersRoot: paths.workersRoot,
        ctx: { repo: repoCtx.repo, cwd: repoCtx.root },
        thresholds: resolveCompanionThresholds(cfg),
        cap: resolveDriftCap(process.env),
        dryRun: args.includes("--dry-run"),
      });
      const summary = summarizeCompanionPass(outcomes, args.includes("--dry-run"));
      if (summary !== "") stdout.write(`${summary}\n`);
    } catch {
      // Best-effort: a companion failure must never break the dashboard render.
    }
  }
  return 0;
}
