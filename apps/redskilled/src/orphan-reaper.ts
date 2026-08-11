import { spawnSync } from "node:child_process";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { killTreeAndWait } from "@reddb-io/shared/kill-tree.js";
import type { RedskilledWorkerView } from "./host-state.js";
import { parseProcStat } from "./memory-sampler.js";
import { REDSKILLED_UNOWNED_PROJECT_LABEL } from "./reattach.js";

/** One process from the daemon's process-table census. */
export interface RedskilledProcessCensusRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  readonly sid: number;
  /** Linux `/proc/<pid>/stat` field 22, in clock ticks since boot. */
  readonly starttime: string;
  readonly age_ms: number;
  readonly worker_id?: string;
  readonly born_at?: string;
  readonly cwd?: string;
  readonly under_workers_lane: boolean;
}

export interface SelectOrphanReaperCandidatesInput {
  readonly processes: readonly RedskilledProcessCensusRow[];
  /** Worker ids this daemon already holds in memory. */
  readonly held_worker_ids: ReadonlySet<string>;
  /** Worker ids with an unmatched birth on the durable event lane. */
  readonly live_birth_ids: ReadonlySet<string>;
}

/** Every host fact the shared process-census predicate classifies. */
export interface SelectRedskilledProcessCensusInput extends SelectOrphanReaperCandidatesInput {
  /** Active init-system Worker units observed independently of daemon memory. */
  readonly active_worker_units: readonly string[];
  /** Core/crash dump files observed under project Worker lanes. */
  readonly dump_files: readonly string[];
}

export type RedskilledOrphanReaperCandidate =
  | {
      readonly kind: "reap";
      readonly process: RedskilledProcessCensusRow;
      readonly detail: string;
    }
  | {
      readonly kind: "adopt";
      readonly process: RedskilledProcessCensusRow;
      readonly detail: string;
    }
  | {
      readonly kind: "suspect";
      readonly process: RedskilledProcessCensusRow;
      readonly detail: string;
    };

/** Detection-only host process census, safe to carry over the public protocol. */
export interface RedskilledProcessCensus {
  readonly version: 1;
  readonly active_worker_units: number;
  readonly daemon_held_workers: number;
  readonly stamped_orphans: number;
  readonly unstamped_suspects: number;
  readonly dump_files: number;
}

export interface SelectedRedskilledProcessCensus {
  readonly census: RedskilledProcessCensus;
  readonly candidates: readonly RedskilledOrphanReaperCandidate[];
}

/** A stamped orphan is given this long to reconnect before the host reaps it. */
export const REDSKILLED_STAMPED_ORPHAN_GRACE_MS = 10 * 60_000;

/** An unstamped process needs a longer window because it cannot prove its origin. */
export const REDSKILLED_UNSTAMPED_SUSPECT_GRACE_MS = 30 * 60_000;

export interface RedskilledProcessCensusOptions {
  readonly proc_root?: string;
  /** Host USER_HZ; injected only when the proc tree belongs to another kernel. */
  readonly clock_ticks_per_second?: number;
}

let cachedProcClockTicksPerSecond: number | null | undefined;

/** Read this kernel's USER_HZ once; an unreadable rate makes process ages unknowable. */
function hostProcClockTicksPerSecond(): number | null {
  if (cachedProcClockTicksPerSecond !== undefined) return cachedProcClockTicksPerSecond;
  const probe = spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticks = Number((probe.stdout ?? "").trim());
  cachedProcClockTicksPerSecond =
    probe.error == null && probe.status === 0 && Number.isFinite(ticks) && ticks > 0
      ? ticks
      : null;
  return cachedProcClockTicksPerSecond;
}

export interface ReapStampedOrphanIO {
  /** Re-read `/proc/<leader>/stat` immediately before signalling. */
  readonly read_starttime: (pid: number) => string | null | Promise<string | null>;
  /** Adopt and durably record the verified identity before teardown begins. */
  readonly after_verified?: () => void | Promise<void>;
  /** Graceful whole-group teardown with escalation and confirmation. */
  readonly kill_group: (pgid: number) => boolean | Promise<boolean>;
}

export interface ReapStampedOrphanOutcome {
  readonly reaped: boolean;
  readonly reason: "orphan-reaped" | "leader-starttime-changed" | "group-survived";
}

/** Verify the leader identity from the census, then tear down its whole group. */
export async function reapStampedOrphan(
  process: RedskilledProcessCensusRow,
  io: ReapStampedOrphanIO,
): Promise<ReapStampedOrphanOutcome> {
  const currentStarttime = await io.read_starttime(process.pid);
  if (currentStarttime !== process.starttime) {
    return { reaped: false, reason: "leader-starttime-changed" };
  }
  await io.after_verified?.();
  const reaped = (await io.kill_group(process.pgid)) === true;
  return reaped
    ? { reaped: true, reason: "orphan-reaped" }
    : { reaped: false, reason: "group-survived" };
}

/** The orphan census has an independent five-minute daemon cadence. */
export const DEFAULT_REDSKILLED_ORPHAN_REAPER_MS = 5 * 60_000;

export type RedskilledOrphanReaperMode = "reap" | "report" | "off";

/** Resolve the operator kill-switch; every unrecognised value keeps the safe default. */
export function redskilledOrphanReaperMode(
  env: NodeJS.ProcessEnv = process.env,
): RedskilledOrphanReaperMode {
  const stated = (env.REDSKILLED_ORPHAN_REAPER ?? "").trim().toLowerCase();
  if (stated === "off") return "off";
  if (stated === "report") return "report";
  return "reap";
}

/** Re-read one Linux process birth discriminator; `null` is never a match. */
export async function readRedskilledProcessStarttime(
  pid: number,
  procRoot = "/proc",
): Promise<string | null> {
  try {
    return parseProcStat(await readFile(join(procRoot, String(pid), "stat"), "utf8"))?.starttime ?? null;
  } catch {
    return null;
  }
}

/**
 * Take one process-table snapshot for the reaper.
 *
 * Stat is read for every process. Environment and cwd are deliberately deferred
 * until a row says it was reparented to pid 1: those are sensitive and more
 * expensive reads, and no other row can become an orphan candidate.
 */
export async function censusRedskilledProcesses(
  options: RedskilledProcessCensusOptions = {},
): Promise<RedskilledProcessCensusRow[]> {
  const root = options.proc_root ?? "/proc";
  try {
    const clockTicksPerSecond = options.clock_ticks_per_second ?? hostProcClockTicksPerSecond();
    if (clockTicksPerSecond == null || !Number.isFinite(clockTicksPerSecond) || clockTicksPerSecond <= 0) return [];
    const uptimeSeconds = Number((await readFile(join(root, "uptime"), "utf8")).trim().split(/\s+/)[0]);
    if (!Number.isFinite(uptimeSeconds) || uptimeSeconds < 0) return [];
    const entries = await readdir(root);
    const rows: RedskilledProcessCensusRow[] = [];
    for (const entry of entries) {
      if (!/^\d+$/.test(entry)) continue;
      let parsed: ReturnType<typeof parseProcStat>;
      try {
        parsed = parseProcStat(await readFile(join(root, entry, "stat"), "utf8"));
      } catch {
        continue;
      }
      if (parsed == null || parsed.ppid !== 1) continue;

      let environment = new Map<string, string>();
      let cwd: string | undefined;
      try {
        environment = parseProcessEnvironment(await readFile(join(root, entry, "environ"), "utf8"));
      } catch {
        // An unreadable stamp leaves the row unstamped; cwd can still identify a suspect.
      }
      try {
        cwd = await readlink(join(root, entry, "cwd"));
      } catch {
        // An unreadable cwd is not evidence that the process belongs to a Worker.
      }

      const workerId = stated(environment.get("RED_WORKER_ID"));
      const bornAt = stated(environment.get("RED_WORKER_BORN_AT"));
      rows.push({
        pid: parsed.pid,
        ppid: parsed.ppid,
        pgid: parsed.pgid,
        sid: parsed.sid,
        starttime: parsed.starttime,
        age_ms: Math.max(
          0,
          (uptimeSeconds - Number(parsed.starttime) / clockTicksPerSecond) * 1_000,
        ),
        ...(workerId == null ? {} : { worker_id: workerId }),
        ...(bornAt == null ? {} : { born_at: bornAt }),
        ...(cwd == null ? {} : { cwd }),
        under_workers_lane: cwd != null && isWorkersLanePath(cwd),
      });
    }
    return rows;
  } catch {
    return [];
  }
}

/** Decode the NUL-separated bytes Linux exposes for one process environment. */
function parseProcessEnvironment(raw: string): Map<string, string> {
  const environment = new Map<string, string>();
  for (const field of raw.split("\0")) {
    const equals = field.indexOf("=");
    if (equals <= 0) continue;
    environment.set(field.slice(0, equals), field.slice(equals + 1));
  }
  return environment;
}

function stated(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed == null || trimmed === "" ? undefined : trimmed;
}

/** True only for the canonical disposable Worker workspace lanes. */
function isWorkersLanePath(path: string): boolean {
  const parts = normalize(path).split(sep).filter(Boolean);
  for (let index = 0; index < parts.length - 2; index += 1) {
    if (parts[index] !== ".red" || parts[index + 1] !== "tmp") continue;
    return ["workers", "go-workers", "scout-workers"].includes(parts[index + 2] ?? "");
  }
  return false;
}

/** Classify one host snapshot for both the daemon reaper and doctor. PURE. */
export function selectRedskilledProcessCensus(
  input: SelectRedskilledProcessCensusInput,
): SelectedRedskilledProcessCensus {
  const candidates = selectOrphanReaperCandidatesOnly(input);
  return {
    census: {
      version: 1,
      active_worker_units: new Set(input.active_worker_units).size,
      daemon_held_workers: new Set(input.held_worker_ids).size,
      stamped_orphans: candidates.filter((candidate) => candidate.kind === "reap").length,
      unstamped_suspects: candidates.filter((candidate) => candidate.kind === "suspect").length,
      dump_files: new Set(input.dump_files).size,
    },
    candidates,
  };
}

/** Select only the process-table rows on which the daemon may act. PURE. */
function selectOrphanReaperCandidatesOnly(
  input: SelectOrphanReaperCandidatesInput,
): RedskilledOrphanReaperCandidate[] {
  const selected: RedskilledOrphanReaperCandidate[] = [];
  for (const process of input.processes) {
    if (!Number.isFinite(process.age_ms) || process.age_ms < 0) continue;
    const workerId = process.worker_id?.trim();
    if (workerId == null || workerId === "") {
      if (
        process.ppid === 1 &&
        process.under_workers_lane &&
        process.age_ms >= REDSKILLED_UNSTAMPED_SUSPECT_GRACE_MS
      ) {
        selected.push({
          kind: "suspect",
          process,
          detail:
            `unstamped process ${process.pid} was reparented under a workers lane and is at least 30 minutes old; ` +
            "it will never be signalled",
        });
      }
      continue;
    }
    if (process.pid !== process.pgid || input.held_worker_ids.has(workerId)) continue;
    if (input.live_birth_ids.has(workerId)) {
      selected.push({
        kind: "adopt",
        process,
        detail: `stamped Worker ${workerId} has a live birth but no daemon holder`,
      });
      continue;
    }
    if (process.age_ms < REDSKILLED_STAMPED_ORPHAN_GRACE_MS) continue;
    selected.push({
      kind: "reap",
      process,
      detail: `stamped Worker ${workerId} has no live birth and is at least 10 minutes old`,
    });
  }
  return selected;
}

/** Compatibility projection for callers that need only the action candidates. */
export function selectOrphanReaperCandidates(
  input: SelectOrphanReaperCandidatesInput,
): RedskilledOrphanReaperCandidate[] {
  return selectRedskilledProcessCensus({
    ...input,
    active_worker_units: [],
    dump_files: [],
  }).candidates.slice();
}

export interface RedskilledOrphanSweepOutcome {
  readonly adopted: number;
  readonly reaped: number;
  readonly suspects: number;
}

export interface RedskilledReapExecution {
  readonly version: 1;
  readonly mode: "report" | "reap";
  readonly census: RedskilledProcessCensus;
  readonly actions: RedskilledOrphanSweepOutcome;
}

export interface RedskilledOrphanReaperRuntimeOptions {
  readonly authorized: boolean;
  readonly interval_ms?: number;
  readonly mode?: RedskilledOrphanReaperMode;
  readonly census?: () => readonly RedskilledProcessCensusRow[] | Promise<readonly RedskilledProcessCensusRow[]>;
  readonly active_worker_units?: () => readonly string[] | Promise<readonly string[]>;
  readonly dump_files?: () => readonly string[] | Promise<readonly string[]>;
  readonly read_starttime?: (pid: number) => string | null | Promise<string | null>;
  readonly kill_group?: (pgid: number) => boolean | Promise<boolean>;
  readonly report?: (detail: string) => void;
  readonly clock: () => string;
  readonly held_worker_ids: () => Iterable<string>;
  readonly live_births: () => readonly RedskilledWorkerView[] | Promise<readonly RedskilledWorkerView[]>;
  /** Put an adopted Worker in the daemon set and optionally record its new birth. */
  readonly adopt: (worker: RedskilledWorkerView, recordBirth: boolean, detail: string) => void | Promise<void>;
  /** Forget an adopted Worker after its group is confirmed dead and record death. */
  readonly record_reaped: (worker: RedskilledWorkerView, detail: string) => void | Promise<void>;
}

export interface RedskilledOrphanReaperRuntime {
  readonly sweep: () => Promise<RedskilledOrphanSweepOutcome>;
  readonly census: () => Promise<RedskilledProcessCensus>;
  readonly reap: (reportOnly: boolean) => Promise<RedskilledReapExecution>;
  readonly arm: () => void;
  readonly stop: () => void;
}

const EMPTY_ORPHAN_SWEEP: RedskilledOrphanSweepOutcome = { adopted: 0, reaped: 0, suspects: 0 };

/** Own the daemon's orphan census, decisions, action ordering and interval. */
export function createRedskilledOrphanReaperRuntime(
  options: RedskilledOrphanReaperRuntimeOptions,
): RedskilledOrphanReaperRuntime {
  const intervalMs = options.interval_ms ?? DEFAULT_REDSKILLED_ORPHAN_REAPER_MS;
  const mode = options.mode ?? redskilledOrphanReaperMode();
  const census = options.census ?? censusRedskilledProcesses;
  const readStarttime = options.read_starttime ?? readRedskilledProcessStarttime;
  const killGroup = options.kill_group ?? killTreeAndWait;
  const report = options.report ?? ((detail: string) => process.stderr.write(`redskilled: ${detail}\n`));
  let timer: NodeJS.Timeout | undefined;
  let sweeping = false;

  async function inspect(): Promise<{
    readonly selected: SelectedRedskilledProcessCensus;
    readonly liveBirths: ReadonlyMap<string, RedskilledWorkerView>;
    readonly safeToAct: boolean;
  }> {
    let processes: readonly RedskilledProcessCensusRow[];
    try {
      processes = await census();
    } catch {
      processes = [];
    }

    let births: readonly RedskilledWorkerView[] = [];
    let safeToAct = true;
    if (processes.length > 0) {
      try {
        births = await options.live_births();
      } catch {
        safeToAct = false;
        report("orphan census withheld: the event lane could not prove which stamped Workers still have live births");
      }
    }
    const liveBirths = new Map(births.map((worker) => [worker.worker_id, worker]));
    const [activeWorkerUnits, dumpFiles] = await Promise.all([
      Promise.resolve(options.active_worker_units?.() ?? []).catch(() => []),
      Promise.resolve(options.dump_files?.() ?? []).catch(() => []),
    ]);
    return {
      selected: selectRedskilledProcessCensus({
        processes,
        active_worker_units: activeWorkerUnits,
        held_worker_ids: new Set(options.held_worker_ids()),
        live_birth_ids: new Set(liveBirths.keys()),
        dump_files: dumpFiles,
      }),
      liveBirths,
      safeToAct,
    };
  }

  async function processCensus(): Promise<RedskilledProcessCensus> {
    if (!options.authorized) {
      return {
        version: 1,
        active_worker_units: 0,
        daemon_held_workers: 0,
        stamped_orphans: 0,
        unstamped_suspects: 0,
        dump_files: 0,
      };
    }
    return (await inspect()).selected.census;
  }

  async function sweep(): Promise<RedskilledOrphanSweepOutcome> {
    if (!options.authorized || mode === "off" || sweeping) return { ...EMPTY_ORPHAN_SWEEP };
    sweeping = true;
    try {
      const { selected, liveBirths, safeToAct } = await inspect();
      if (!safeToAct) return { ...EMPTY_ORPHAN_SWEEP };
      const candidates = selected.candidates;
      const counts = { adopted: 0, reaped: 0, suspects: 0 };

      for (const candidate of candidates) {
        if (mode === "report") {
          if (candidate.kind === "suspect") counts.suspects += 1;
          report(`${candidate.detail}; report mode withheld adoption and signalling`);
          continue;
        }
        if (candidate.kind === "suspect") {
          counts.suspects += 1;
          report(candidate.detail);
          continue;
        }
        if (candidate.kind === "adopt") {
          await options.adopt(
            workerFromOrphanProcess(candidate.process, options.clock, liveBirths.get(candidate.process.worker_id!)),
            false,
            candidate.detail,
          );
          counts.adopted += 1;
          report(candidate.detail);
          continue;
        }
        const adopted = workerFromOrphanProcess(candidate.process, options.clock);
        let verified = false;
        const outcome = await reapStampedOrphan(candidate.process, {
          read_starttime: readStarttime,
          after_verified: async () => {
            verified = true;
            await options.adopt(adopted, true, `adopted stamped orphan before group teardown: ${candidate.detail}`);
            counts.adopted += 1;
          },
          kill_group: killGroup,
        });
        if (!outcome.reaped || !verified) {
          if (verified && outcome.reason === "group-survived") {
            await options.record_reaped(
              adopted,
              `group-survived: process group ${candidate.process.pgid} survived orphan teardown; ${candidate.detail}`,
            );
          }
          report(`${candidate.detail}; ${outcome.reason}`);
          continue;
        }
        await options.record_reaped(adopted, `orphan-reaped: ${candidate.detail}`);
        counts.reaped += 1;
      }
      return counts;
    } finally {
      sweeping = false;
    }
  }

  async function reap(reportOnly: boolean): Promise<RedskilledReapExecution> {
    const census = await processCensus();
    return {
      version: 1,
      mode: reportOnly ? "report" : "reap",
      census,
      actions: reportOnly
        ? { adopted: 0, reaped: 0, suspects: census.unstamped_suspects }
        : await sweep(),
    };
  }

  function arm(): void {
    if (timer != null || intervalMs <= 0 || mode === "off" || !options.authorized) return;
    timer = setInterval(() => void sweep().catch(() => undefined), intervalMs);
    timer.unref();
  }

  return {
    sweep,
    census: processCensus,
    reap,
    arm,
    stop: () => {
      if (timer != null) clearInterval(timer);
      timer = undefined;
    },
  };
}

function workerFromOrphanProcess(
  processRow: RedskilledProcessCensusRow,
  clock: () => string,
  birth?: RedskilledWorkerView,
): RedskilledWorkerView {
  const nowMs = Date.parse(clock());
  const inferredBirth = Number.isFinite(nowMs)
    ? new Date(Math.max(0, nowMs - processRow.age_ms)).toISOString()
    : clock();
  const { unit: _unit, ...birthWithoutUnit } = birth ?? {};
  return {
    ...birthWithoutUnit,
    worker_id: processRow.worker_id!,
    project_label: birth?.project_label ?? REDSKILLED_UNOWNED_PROJECT_LABEL,
    pid: processRow.pid,
    pgid: processRow.pgid,
    proc_start_time: processRow.starttime,
    started_at: birth?.started_at ?? processRow.born_at ?? inferredBirth,
    workspace_path: processRow.cwd ?? birth?.workspace_path ?? "",
    isolated: false,
    warnings: [
      ...(birth?.warnings ?? []),
      birth == null
        ? "adopted by the orphan reaper from the host process table: no daemon holder or live birth remained, so the owning project and budget are unknown"
        : "adopted by the orphan reaper from a live event-lane birth whose daemon holder was missing; the process-table identity now anchors it",
    ],
  };
}
