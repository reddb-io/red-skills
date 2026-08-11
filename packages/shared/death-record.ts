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
import {
  appendFileSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import { UNSCOPED_PROCESS, readWorkerScopeFacts, type WorkerScopeFacts } from "./worker-scope.js";
import {
  buildProcessPresence,
  clearProcessPresence,
  writeProcessPresence,
  type ProcessPresence,
} from "./death-presence.js";
import { DEATH_PRESENCE_DIR } from "./red-paths.js";
import {
  LANE_RETENTION_REGISTRY,
  laneSizeOverCeiling,
  replaceLaneAtomicallySync,
} from "./lane-retention.js";

export { DEATH_LANE_DIR, DEATH_LANE_FILE, deathLaneDirIn, deathLaneFile, deathLaneFileIn, deathsStateDir } from "./red-paths.js";
// The placement vocabulary travels with the record that carries it, so a reader
// of a death imports one module rather than learning that the scope facts live
// somewhere else.
export { UNSCOPED_PROCESS, readWorkerScopeFacts, type WorkerScopeFacts } from "./worker-scope.js";

/** The record shape's version; bumped only when a field's meaning changes. */
export const PROCESS_DEATH_RECORD_VERSION = 1;

/**
 * Deaths remain useful for fourteen days. Older host history no longer explains
 * the processes and anchors present today, so each size-triggered or boot
 * compaction advances the lane to this explicit age window.
 */
export const PROCESS_DEATH_LANE_RETENTION_MS =
  LANE_RETENTION_REGISTRY["process-deaths"].maxAgeMs;

/** The largest death-lane generation an exit handler asks a reader to decode. */
export const PROCESS_DEATH_LANE_MAX_BYTES =
  LANE_RETENTION_REGISTRY["process-deaths"].maxBytes;

/** A rewrite leaves half the generation free, amortizing the next full decode. */
const PROCESS_DEATH_LANE_COMPACTION_TARGET_RATIO =
  LANE_RETENTION_REGISTRY["process-deaths"].targetRatio;

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
export interface ProcessDeathRecord extends ProcessResourceSample, WorkerScopeFacts {
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
  // `scope`, `memory_ceiling` and `scope_degradation` arrive with
  // {@link WorkerScopeFacts}: WHERE the process was contained and under what
  // ceiling, so a host-pressure kill is attributable to the process that earned
  // it rather than to whatever the machine happened to shoot (#3029). A host
  // that could not place the process says so in `scope_degradation` — the
  // downgrade is on the record, never inferred from an absent scope.
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
  /** Where the host placed this process; {@link UNSCOPED_PROCESS} when nowhere. */
  readonly scope?: WorkerScopeFacts;
}

/** Assemble one record from facts plus a resource sample. PURE. */
export function buildProcessDeathRecord(
  facts: ProcessDeathFacts,
  sample: ProcessResourceSample,
): ProcessDeathRecord {
  const scope = facts.scope ?? UNSCOPED_PROCESS;
  return {
    ...scope,
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
  /** How many listeners an event has — how the recorder knows it is alone. */
  listenerCount?(event: string): number;
  /** Re-delivers a signal, so a default disposition can do what it would have. */
  kill?(pid: number, signal: string): unknown;
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
  /** One-stat append inspection; an absent lane is empty and clean. */
  inspect(path: string): { readonly size: number; readonly endsClean: boolean };
  append(path: string, text: string): void;
  /** Atomically replace a complete lane after age/size compaction. */
  replace(path: string, text: string): void;
  read(path: string): string;
}

/** The real filesystem, owner-only, best effort on every operation. */
export const nodeDeathLaneIo: DeathLaneIo = {
  mkdir(dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  },
  inspect(path) {
    let size: number;
    try {
      size = statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { size: 0, endsClean: true };
      throw error;
    }
    if (size === 0) return { size, endsClean: true };
    let descriptor: number | undefined;
    try {
      descriptor = openSync(path, "r");
      const tail = Buffer.allocUnsafe(1);
      readSync(descriptor, tail, 0, 1, size - 1);
      return { size, endsClean: tail[0] === 0x0a };
    } catch {
      return { size, endsClean: true };
    } finally {
      if (descriptor !== undefined) closeSync(descriptor);
    }
  },
  append(path, text) {
    appendFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  },
  replace(path, text) {
    replaceLaneAtomicallySync(path, text);
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
  const lineBytes = Buffer.byteLength(line);
  const inspection = io.inspect(lanePath);
  const separatorBytes = inspection.endsClean ? 0 : 1;
  const recordedAt = Date.parse(record.ts);
  const compactedAt = Number.isFinite(recordedAt) ? recordedAt : Date.now();
  let compacted = false;
  if (laneSizeOverCeiling(
    inspection.size,
    separatorBytes + lineBytes,
    LANE_RETENTION_REGISTRY["process-deaths"],
  )) {
    const targetBytes = Math.max(
      0,
      Math.floor(PROCESS_DEATH_LANE_MAX_BYTES * PROCESS_DEATH_LANE_COMPACTION_TARGET_RATIO) -
        lineBytes,
    );
    compactProcessDeathLaneToTarget(lanePath, compactedAt, io, targetBytes);
    compacted = true;
  }
  io.mkdir(dirname(lanePath));
  if (!compacted && !inspection.endsClean && inspection.size > 0) io.append(lanePath, "\n");
  io.append(lanePath, line);
  return record;
}

/**
 * Remove deaths outside the stated retention window, returning what remains.
 *
 * Unknown timestamps are preserved: retention may discard history proven old,
 * never a record whose age cannot be established. The replacement is one whole
 * TOONL segment, so a reader never observes a lane without its schema header.
 */
export function compactProcessDeathLane(
  lanePath: string,
  nowMs: number = Date.now(),
  io: DeathLaneIo = nodeDeathLaneIo,
): ProcessDeathRecord[] {
  return compactProcessDeathLaneToTarget(lanePath, nowMs, io);
}

function compactProcessDeathLaneToTarget(
  lanePath: string,
  nowMs: number,
  io: DeathLaneIo,
  forcedTargetBytes?: number,
): ProcessDeathRecord[] {
  let raw: string;
  let records: ProcessDeathRecord[];
  try {
    raw = io.read(lanePath);
    records = decodeProcessDeathRecords(raw);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const cutoff = nowMs - PROCESS_DEATH_LANE_RETENTION_MS;
  const ageRetained = records.filter((record) => {
    const timestamp = Date.parse(record.ts);
    return !Number.isFinite(timestamp) || timestamp >= cutoff;
  });
  const oversized = Buffer.byteLength(raw) > PROCESS_DEATH_LANE_MAX_BYTES;
  const targetBytes = forcedTargetBytes ??
    (oversized
      ? Math.floor(PROCESS_DEATH_LANE_MAX_BYTES * PROCESS_DEATH_LANE_COMPACTION_TARGET_RATIO)
      : undefined);
  const retained = targetBytes === undefined ? ageRetained : retainDeathRecordsWithin(ageRetained, targetBytes);
  if (forcedTargetBytes === undefined && !oversized && retained.length === records.length) return retained;

  io.replace(lanePath, encodeDeathLane(retained));
  return retained;
}

/** Preserve unknown timestamps, then keep the newest dated history that fits. */
function retainDeathRecordsWithin(
  records: readonly ProcessDeathRecord[],
  targetBytes: number,
): ProcessDeathRecord[] {
  const pinnedIndices = new Set<number>();
  const optionalIndices: number[] = [];
  records.forEach((record, index) => {
    if (Number.isFinite(Date.parse(record.ts))) optionalIndices.push(index);
    else pinnedIndices.add(index);
  });

  let low = 0;
  let high = optionalIndices.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const selected = new Set([...pinnedIndices, ...optionalIndices.slice(middle)]);
    const candidate = records.filter((_record, index) => selected.has(index));
    if (Buffer.byteLength(encodeDeathLane(candidate)) <= targetBytes) high = middle;
    else low = middle + 1;
  }

  const selected = new Set([...pinnedIndices, ...optionalIndices.slice(low)]);
  return records.filter((_record, index) => selected.has(index));
}

function encodeDeathLane(records: readonly ProcessDeathRecord[]): string {
  if (records.length === 0) return "";
  const encoder = encodeLines({ trailer: false });
  return records.map((record) => encoder.push(toRow(record))).join("");
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
    // Absent reads as `null` rather than as a decode failure: a lane written
    // before the placement facts joined the record is still a lane of readable
    // deaths, and a reader that rejected it would lose the older history to a
    // field that was never going to be there.
    scope: row.scope == null ? null : String(row.scope),
    memory_ceiling: row.memory_ceiling == null ? null : String(row.memory_ceiling),
    scope_degradation: row.scope_degradation == null ? null : String(row.scope_degradation),
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
  /** Which signals to trap; defaults to {@link TRAPPED_DEATH_SIGNALS}. */
  readonly signals?: readonly string[];
  readonly host?: DeathRecorderHost;
  readonly io?: DeathLaneIo;
  readonly clock?: () => string;
  /** Register as the process-wide recorder `markDeathPhase` speaks to. Default true. */
  readonly setActive?: boolean;
  /**
   * Where the host placed this process. Defaults to what the environment says.
   *
   * Read from the environment rather than passed by every caller, because the
   * process that has to state its scope is the one that never chose it: the host
   * decides the placement and hands it down at birth (`worker-scope.ts`), so a
   * call site that had to remember to forward it is a call site that will forget.
   */
  readonly scope?: WorkerScopeFacts;
  /**
   * Where the presence anchor goes; `null` leaves none.
   *
   * Defaults to the `live/` directory beside the lane, so every writer that
   * already installs a recorder becomes attributable at the next boot without
   * restating anything. Only a caller that knows its process is un-reapable —
   * a test, a one-shot in someone else's tree — passes `null`.
   */
  readonly presenceDir?: string | null;
  /** The `/proc`-shaped root the anchor reads its boot id and cgroup from. */
  readonly procRoot?: string;
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
 * **The handlers OBSERVE; they never act — and never PREVENT.** Attaching a
 * listener to a signal is itself an action in Node: it displaces the default
 * disposition, so a bare `on("SIGHUP", …)` would quietly make SIGHUP survivable
 * for a process that used to die of it. When the recorder finds it is the ONLY
 * listener for a signal, it therefore detaches and re-raises, letting the default
 * do exactly what it would have done. Where another handler already owns the
 * signal, the recorder stays out of the way and lets that handler decide.
 */
export function installDeathRecorder(options: InstallDeathRecorderOptions): DeathRecorder {
  const host = options.host ?? (process as unknown as DeathRecorderHost);
  const io = options.io ?? nodeDeathLaneIo;
  const clock = options.clock ?? (() => new Date().toISOString());
  const pid = host.pid;
  const scope = options.scope ?? readWorkerScopeFacts(process.env);
  let phase = options.phase ?? DEATH_PHASE_UNSTARTED;
  let written: ProcessDeathRecord | null = null;

  // The anchor for the death this process may NOT get to narrate (slice #3028):
  // a SIGKILL fires no handler here, so the only thing that will speak for it is
  // this file plus whatever the host remembers. Written before any work begins,
  // refreshed on every phase, removed the instant a real record lands.
  const presenceDir =
    options.presenceDir === undefined
      ? join(dirname(options.lanePath), DEATH_PRESENCE_DIR)
      : options.presenceDir;
  let anchor: ProcessPresence | null = null;
  const anchorNow = (): void => {
    if (presenceDir === null) return;
    anchor = buildProcessPresence(
      { kind: options.kind, id: options.id, last_phase: phase, pid },
      { procRoot: options.procRoot },
    );
    writeProcessPresence(presenceDir, anchor);
  };

  const record = (facts: Omit<ProcessDeathFacts, "ts" | "kind" | "id" | "pid" | "last_phase">): void => {
    if (written) return;
    try {
      written = appendProcessDeathRecord(
        options.lanePath,
        buildProcessDeathRecord(
          { ts: clock(), kind: options.kind, id: options.id, pid, last_phase: phase, scope, ...facts },
          sampleProcessResources(host),
        ),
        io,
      );
    } catch {
      // Best effort by contract: a lane that cannot be written must never turn a
      // death being reported into a second, louder death.
    }
    // The anchor goes even when the append failed: it stands for a death nobody
    // narrated, and this one was narrated — attributing it from evidence later
    // would invent a cause for an exit we watched happen.
    if (presenceDir !== null && anchor !== null) clearProcessPresence(presenceDir, anchor);
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

  const signals = options.signals ?? TRAPPED_DEATH_SIGNALS;
  const listeners: Array<[string, (...args: unknown[]) => void]> = [
    ...signals.map((signal) => {
      const listener = (): void => {
        handlers.signal(signal);
        // Alone on this signal means the default disposition was displaced by
        // this very listener. Hand it back rather than swallow the death.
        if (host.listenerCount?.(signal) !== 1 || !host.kill) return;
        host.off(signal, listener);
        try {
          host.kill(pid, signal);
        } catch {
          // A host that refuses the re-raise keeps the record; the death it was
          // about to have is not this module's to force a second way.
        }
      };
      return [signal, listener] as [string, (...args: unknown[]) => void];
    }),
    ["uncaughtException", (...args) => handlers.uncaughtException(args[0])],
    ["unhandledRejection", (...args) => handlers.unhandledRejection(args[0])],
    ["exit", (...args) => handlers.exit(typeof args[0] === "number" ? args[0] : null)],
  ];
  for (const [event, listener] of listeners) host.on(event, listener);

  const recorder: DeathRecorder = {
    lanePath: options.lanePath,
    phase(name) {
      phase = name;
      // A phase the anchor never learned is the phase a frozen host dies in, so
      // the refresh is the point: an attribution that can only ever say "startup"
      // answers when it died and not where.
      if (!written) anchorNow();
    },
    currentPhase: () => phase,
    written: () => written,
    uninstall() {
      for (const [event, listener] of listeners) host.off(event, listener);
      // A process that detached the handlers is no longer promising to narrate
      // its own death, so leaving its anchor would strand a permanent mystery.
      if (presenceDir !== null && anchor !== null) clearProcessPresence(presenceDir, anchor);
      if (activeRecorder === recorder) activeRecorder = null;
    },
    handlers,
  };
  if (options.setActive !== false) activeRecorder = recorder;
  anchorNow();
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
