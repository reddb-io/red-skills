/**
 * death-record — the record a process writes on its own way out.
 *
 * **Nothing that CAN say goodbye is allowed to leave silently.** The 2026-08-01
 * autopsy found that the remaining failures were not lost work but lost REASONS:
 * a dispatch killed twice with nothing on disk naming the signal, a machine
 * freeze that erased the memory of itself. A death nobody recorded is a mystery
 * forever, and repeated mystery is what fragility feels like.
 *
 * **The dying process is the writer, so no watcher is required.** A record that
 * depended on a parent being alive to observe the exit would be absent in exactly
 * the case that matters most — the one where the parent died too. Every trap-able
 * exit therefore writes its own record synchronously, before the process leaves.
 *
 * **One shape, every writer.** A launcher, a worker and the host daemon append the
 * same flat, total record to a lane with the same name (see `red-paths.ts`), so a
 * reader joins deaths across all three without knowing which wrote which.
 *
 * **Un-trap-able deaths are NOT this module's job.** SIGKILL fires no handler and
 * no `exit` event, so a SIGKILLed process leaves no record here — its absence is
 * the signal a later reaper attributes from kernel and journal evidence. What
 * this module guarantees is narrower and total: a process that CAN say goodbye
 * always does.
 *
 * TOONL on disk through the TOON encoder (repo mandate), written with the
 * SYNCHRONOUS file API because an `exit` handler cannot await — a promise still
 * in flight when the process leaves is the very silence the record exists to
 * break.
 */
import { appendFileSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";

export { DEATH_LANE_DIR, DEATH_LANE_FILE, deathLaneDirIn, deathLaneFile, deathLaneFileIn, deathsStateDir } from "./red-paths.js";

/** The record shape's version; bumped only when a field's meaning changes. */
export const PROCESS_DEATH_RECORD_VERSION = 1;

/**
 * Which of the engine's three process classes died.
 *
 * Exactly the three the black box covers: the thing that ASKS for work to run,
 * the thing that RUNS it, and the host process that births workers. A fourth
 * kind means a fourth class of process exists, which is a decision, not a label.
 */
export type ProcessDeathKind = "launcher" | "worker" | "daemon";

/**
 * HOW the process left, which is the fact a reader sorts on first.
 *
 * `exit` is a process that reached an exit code under its own power — clean or
 * failed, but its own. Everything else was ended by something: a signal from
 * outside, or an error from inside that nothing caught.
 */
export type ProcessExitPath = "exit" | "signal" | "uncaught-exception" | "unhandled-rejection";

const EXIT_PATHS = new Set<string>(["exit", "signal", "uncaught-exception", "unhandled-rejection"]);

/** True when `value` names an exit path this version understands. */
export function isProcessExitPath(value: unknown): value is ProcessExitPath {
  return typeof value === "string" && EXIT_PATHS.has(value);
}

/**
 * What the process was USING when it died — Node's `rusage`, carried whole.
 *
 * `max_rss_kb` and `involuntary_ctx_switches` earn their place on a record about
 * death specifically: a process approaching the memory ceiling and a process
 * being preempted off the CPU are the two shapes that precede a host-pressure
 * kill, and both are invisible in an exit code.
 */
export interface ProcessResourceSample {
  readonly uptime_s: number;
  readonly rss_kb: number;
  readonly max_rss_kb: number;
  readonly user_cpu_us: number;
  readonly system_cpu_us: number;
  readonly minor_page_faults: number;
  readonly major_page_faults: number;
  readonly voluntary_ctx_switches: number;
  readonly involuntary_ctx_switches: number;
}

/**
 * One death, flat and TOTAL — every field present on every record, `null` where
 * it genuinely does not apply.
 *
 * Total rather than sparse so one segment header covers a whole lane and a reader
 * never special-cases a kind. `signal` and `exit_code` are carried STRUCTURALLY
 * rather than folded into `detail`: the questions a reader asks turn on those two
 * values, and a reader that recovered them by parsing a sentence would break the
 * day the sentence was reworded.
 */
export interface ProcessDeathRecord extends ProcessResourceSample {
  readonly version: number;
  readonly ts: string;
  readonly kind: ProcessDeathKind;
  /** The logical identity a surface already knows this process by. */
  readonly id: string;
  readonly pid: number;
  readonly exit_path: ProcessExitPath;
  /** The signal that ended it, when one did; `null` on every other path. */
  readonly signal: string | null;
  /** The status it reached, when it reached one; `null` when a signal ended it. */
  readonly exit_code: number | null;
  /** The last phase the process ANNOUNCED — where it was, not where it started. */
  readonly last_phase: string;
  /** Free text for the path that has more to say (an error message, a stack). */
  readonly detail: string | null;
}

/** The phase a recorder reports until the process announces its first one. */
export const DEATH_PHASE_UNSTARTED = "startup";

/** Everything `buildProcessDeathRecord` needs that the sample does not carry. */
export interface ProcessDeathFacts {
  readonly ts: string;
  readonly kind: ProcessDeathKind;
  readonly id: string;
  readonly pid: number;
  readonly exit_path: ProcessExitPath;
  readonly last_phase: string;
  readonly signal?: string | null;
  readonly exit_code?: number | null;
  readonly detail?: string | null;
}

/** Assemble one record from facts plus a resource sample. PURE. */
export function buildProcessDeathRecord(
  facts: ProcessDeathFacts,
  sample: ProcessResourceSample,
): ProcessDeathRecord {
  return {
    version: PROCESS_DEATH_RECORD_VERSION,
    ts: facts.ts,
    kind: facts.kind,
    id: facts.id,
    pid: facts.pid,
    exit_path: facts.exit_path,
    signal: facts.signal ?? null,
    exit_code: facts.exit_code ?? null,
    last_phase: facts.last_phase,
    detail: facts.detail ?? null,
    ...sample,
  };
}

/**
 * The process facts a recorder samples. `process` satisfies it; a test poses it.
 *
 * Every listener is typed `(...args: unknown[]) => void` so one interface accepts
 * both Node's overloaded `process.on` and a hand-written fake — the alternative,
 * `Pick<NodeJS.Process, …>`, would force a test to implement Node's whole
 * signature just to deliver one signal.
 */
export interface DeathRecorderHost {
  readonly pid: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
  uptime(): number;
  memoryUsage(): { rss: number };
  resourceUsage(): {
    userCPUTime: number;
    systemCPUTime: number;
    maxRSS: number;
    minorPageFault: number;
    majorPageFault: number;
    voluntaryContextSwitches: number;
    involuntaryContextSwitches: number;
  };
}

/** Sample the host's current resource usage. */
export function sampleProcessResources(host: DeathRecorderHost): ProcessResourceSample {
  const usage = host.resourceUsage();
  return {
    uptime_s: Math.round(host.uptime()),
    rss_kb: Math.round(host.memoryUsage().rss / 1024),
    max_rss_kb: usage.maxRSS,
    user_cpu_us: usage.userCPUTime,
    system_cpu_us: usage.systemCPUTime,
    minor_page_faults: usage.minorPageFault,
    major_page_faults: usage.majorPageFault,
    voluntary_ctx_switches: usage.voluntaryContextSwitches,
    involuntary_ctx_switches: usage.involuntaryContextSwitches,
  };
}

/** The synchronous file operations the lane needs; injected so a test can pose them. */
export interface DeathLaneIo {
  mkdir(dir: string): void;
  /** True when the lane is absent or already ends on a line boundary. */
  endsClean(path: string): boolean;
  append(path: string, text: string): void;
  read(path: string): string;
}

/** The real filesystem, owner-only, best effort on every operation. */
export const nodeDeathLaneIo: DeathLaneIo = {
  mkdir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  },
  endsClean(path) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch {
      return true;
    }
    if (size === 0) return true;
    // Reading the tail byte alone would need an open/read/close dance in a path
    // that must not throw; the lane is small and this runs once per process life.
    try {
      return readFileSync(path, "utf8").endsWith("\n");
    } catch {
      return true;
    }
  },
  append(path, text) {
    appendFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  },
  read(path) {
    return readFileSync(path, "utf8");
  },
};

function toRow(record: ProcessDeathRecord): ToonlRecord {
  const row: ToonlRecord = {};
  for (const [key, value] of Object.entries(record)) {
    row[key] = value as ToonlRecord[string];
  }
  return row;
}

/**
 * Append one record to the lane, synchronously. Returns the record written.
 *
 * A crash can cut a previous writer's line mid-encode, so an unterminated tail is
 * closed with a newline before appending rather than fused onto: leaving it would
 * turn one lost record into a line no reader can decode, which is a corruption
 * that outlives the crash.
 */
export function appendProcessDeathRecord(
  lanePath: string,
  record: ProcessDeathRecord,
  io: DeathLaneIo = nodeDeathLaneIo,
): ProcessDeathRecord {
  const line = encodeLines({ trailer: false }).push(toRow(record));
  io.mkdir(dirname(lanePath));
  if (!io.endsClean(lanePath)) io.append(lanePath, "\n");
  io.append(lanePath, line);
  return record;
}

/**
 * Decode a lane's text into records. PURE.
 *
 * A line the writer never terminated is dropped, and only from the END: a reader
 * that skipped every line it could not decode would swallow a genuine format bug
 * in the middle of the lane as if it were a crash.
 */
export function decodeProcessDeathRecords(raw: string): ProcessDeathRecord[] {
  const complete = raw.endsWith("\n") ? raw : raw.slice(0, raw.lastIndexOf("\n") + 1);
  if (complete === "") return [];
  return parseRecords(complete).map(toDeathRecord);
}

function toDeathRecord(row: ToonlRecord): ProcessDeathRecord {
  const exitPath = row.exit_path;
  if (!isProcessExitPath(exitPath)) {
    throw new Error(`death record has unknown exit_path ${JSON.stringify(exitPath)}`);
  }
  const kind = row.kind;
  if (kind !== "launcher" && kind !== "worker" && kind !== "daemon") {
    throw new Error(`death record has unknown kind ${JSON.stringify(kind)}`);
  }
  return {
    version: num(row.version),
    ts: String(row.ts),
    kind,
    id: String(row.id),
    pid: num(row.pid),
    exit_path: exitPath,
    signal: row.signal == null ? null : String(row.signal),
    exit_code: row.exit_code == null ? null : num(row.exit_code),
    last_phase: String(row.last_phase),
    detail: row.detail == null ? null : String(row.detail),
    uptime_s: num(row.uptime_s),
    rss_kb: num(row.rss_kb),
    max_rss_kb: num(row.max_rss_kb),
    user_cpu_us: num(row.user_cpu_us),
    system_cpu_us: num(row.system_cpu_us),
    minor_page_faults: num(row.minor_page_faults),
    major_page_faults: num(row.major_page_faults),
    voluntary_ctx_switches: num(row.voluntary_ctx_switches),
    involuntary_ctx_switches: num(row.involuntary_ctx_switches),
  };
}

function num(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}

/** Every record on the lane at `lanePath`; an absent lane is an empty history. */
export function readProcessDeathLane(
  lanePath: string,
  io: DeathLaneIo = nodeDeathLaneIo,
): ProcessDeathRecord[] {
  let raw: string;
  try {
    raw = io.read(lanePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return decodeProcessDeathRecords(raw);
}

/** The signals a process can trap; a SIGKILL is by definition not among them. */
export const TRAPPED_DEATH_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP", "SIGQUIT"] as const;

export interface InstallDeathRecorderOptions {
  /** Where the record lands — build it with `deathLaneFile`/`deathLaneFileIn`. */
  readonly lanePath: string;
  readonly kind: ProcessDeathKind;
  readonly id: string;
  /** The phase the process starts in; defaults to {@link DEATH_PHASE_UNSTARTED}. */
  readonly phase?: string;
  readonly host?: DeathRecorderHost;
  readonly io?: DeathLaneIo;
  readonly clock?: () => string;
  /** Register as the process-wide recorder `markDeathPhase` speaks to. Default true. */
  readonly setActive?: boolean;
}

export interface DeathRecorder {
  readonly lanePath: string;
  /** Announce where the process is now; the record carries the last one set. */
  phase(name: string): void;
  /** The phase most recently announced. */
  currentPhase(): string;
  /** The record this process wrote, or `null` while it is still alive. */
  written(): ProcessDeathRecord | null;
  /** Detach every handler. Idempotent; a recorder that already wrote keeps its record. */
  uninstall(): void;
  /**
   * The exit paths, exposed so a test delivers one directly. Production NEVER
   * calls these — the handlers registered on the host are the only trigger.
   */
  readonly handlers: {
    signal(signal: string): void;
    exit(code: number | null): void;
    uncaughtException(error: unknown): void;
    unhandledRejection(reason: unknown): void;
  };
}

let activeRecorder: DeathRecorder | null = null;

/** The process-wide recorder, or `null` when none is installed. */
export function activeDeathRecorder(): DeathRecorder | null {
  return activeRecorder;
}

/**
 * Announce the current phase to whatever recorder this process installed.
 *
 * A no-op when nothing is installed, so a caller deep in the engine can announce
 * unconditionally: a phase marker that had to check first would be dropped from
 * the call sites that forgot, which are the ones a mystery death runs through.
 */
export function markDeathPhase(phase: string): void {
  activeRecorder?.phase(phase);
}

/**
 * Install the death handlers on `host`, returning the recorder.
 *
 * **Exactly one record per process life.** A signal handler writes, and then the
 * process usually goes on to exit — so the `exit` handler must not write a second
 * record contradicting the first. The specific paths (signal, uncaught) therefore
 * latch, and `exit` writes only when nothing has yet.
 *
 * **The handlers OBSERVE; they never act.** None of them exits the process, and
 * none of them swallows anything: a recorder that changed the death would be
 * masking the bug it exists to explain.
 */
export function installDeathRecorder(options: InstallDeathRecorderOptions): DeathRecorder {
  const host = options.host ?? (process as unknown as DeathRecorderHost);
  const io = options.io ?? nodeDeathLaneIo;
  const clock = options.clock ?? (() => new Date().toISOString());
  const pid = host.pid;
  let phase = options.phase ?? DEATH_PHASE_UNSTARTED;
  let written: ProcessDeathRecord | null = null;

  const record = (facts: Omit<ProcessDeathFacts, "ts" | "kind" | "id" | "pid" | "last_phase">): void => {
    if (written) return;
    try {
      written = appendProcessDeathRecord(
        options.lanePath,
        buildProcessDeathRecord(
          { ts: clock(), kind: options.kind, id: options.id, pid, last_phase: phase, ...facts },
          sampleProcessResources(host),
        ),
        io,
      );
    } catch {
      // Best effort by contract: a lane that cannot be written must never turn a
      // death being reported into a second, louder death.
    }
  };

  const handlers: DeathRecorder["handlers"] = {
    signal(signal) {
      record({ exit_path: "signal", signal });
    },
    exit(code) {
      record({ exit_path: "exit", exit_code: code });
    },
    uncaughtException(error) {
      record({ exit_path: "uncaught-exception", detail: describe(error) });
    },
    unhandledRejection(reason) {
      record({ exit_path: "unhandled-rejection", detail: describe(reason) });
    },
  };

  const listeners: Array<[string, (...args: unknown[]) => void]> = [
    ...TRAPPED_DEATH_SIGNALS.map(
      (signal) => [signal, () => handlers.signal(signal)] as [string, (...args: unknown[]) => void],
    ),
    ["uncaughtException", (...args) => handlers.uncaughtException(args[0])],
    ["unhandledRejection", (...args) => handlers.unhandledRejection(args[0])],
    ["exit", (...args) => handlers.exit(typeof args[0] === "number" ? args[0] : null)],
  ];
  for (const [event, listener] of listeners) host.on(event, listener);

  const recorder: DeathRecorder = {
    lanePath: options.lanePath,
    phase(name) {
      phase = name;
    },
    currentPhase: () => phase,
    written: () => written,
    uninstall() {
      for (const [event, listener] of listeners) host.off(event, listener);
      if (activeRecorder === recorder) activeRecorder = null;
    },
    handlers,
  };
  if (options.setActive !== false) activeRecorder = recorder;
  return recorder;
}

function describe(value: unknown): string {
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try {
    return String(value);
  } catch {
    return "(undescribable)";
  }
}
