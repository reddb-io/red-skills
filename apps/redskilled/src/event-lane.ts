/**
 * event-lane — the daemon's own append-only memory of the Workers it birthed.
 *
 * **One lane, host facts: Worker lifecycle and daemon decisions.** ADR 0130
 * gives the daemon exactly one thing no other authority holds — Worker-to-process
 * — and this lane is the durable form of it. The tracker already owns
 * issue-to-PR and git already owns branch-to-commits, so a per-Worker durable
 * record would be a third copy of facts two authorities already keep, and the
 * only thing a third copy reliably does is drift.
 *
 * **Append-only within one bounded generation.** Every event is a whole line
 * appended in one call. Once the generation reaches its byte ceiling, the
 * writer atomically replaces it with a compact generation containing every
 * live Worker's birth plus the newest history that fits. A reader holding the
 * previous inode can therefore name rotation instead of mistaking a new byte
 * offset for uninterrupted history.
 *
 * **A crash mid-append costs the tail, never the lane.** The writer's process can
 * die between the `write` and the newline, which leaves a half-encoded row on
 * disk. The reader therefore treats an unterminated final line as absent —
 * TOONL's own rule that a crash-truncated open tail is unverified rather than
 * corrupt — instead of failing the whole replay over the one event that was
 * still in flight.
 *
 * TOONL on disk via the TOON encoder (repo mandate). The shape is fixed and
 * total — every field present on every event, `null` where it does not apply —
 * so one segment header covers a whole writer's session and a reader never
 * special-cases an event kind's row.
 */
import { appendFile, mkdir, open, readFile, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeToonlLines } from "@reddb-io/toon";
import {
  buildDaemonDeathEvent,
  buildDaemonStartEvent,
  buildDaemonStopEvent,
  type RecordDaemonDeathInput,
  type RecordDaemonStartInput,
  type RecordDaemonStopInput,
} from "./daemon-events.js";
export {
  buildDaemonDeathEvent,
  buildDaemonStartEvent,
  buildDaemonStopEvent,
  REDSKILLED_DAEMON_EVENT_PREFIX,
  type RecordDaemonDeathInput,
  type RecordDaemonStartInput,
  type RecordDaemonStopInput,
} from "./daemon-events.js";
import { decodeLaneRows } from "./event-lane-decode.js";
import {
  readPositionedEventLane,
  type EventLanePosition,
  type PositionedEventRead,
} from "./event-lane-position.js";
import type { RedskilledWorkerView } from "./host-state.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";
type ToonlRecord = Record<string, string | number | boolean | null>;

/**
 * The stable vocabulary for records about a Worker (ADR 0138).
 *
 * Kept as data as well as a type so writers, readers, tests and query docs all
 * share one closed set. Adding a spelling is a contract change, never an ad-hoc
 * string at a call site.
 */
export type RedskilledWorkerEventKind =
  | "worker-birth"
  | "worker-activity"
  | "worker-metrics"
  | "worker-drift"
  | "worker-heal"
  | "worker-death"
  | "worker-budget-kill";

export const REDSKILLED_WORKER_EVENT_KINDS = [
  "worker-birth",
  "worker-activity",
  "worker-metrics",
  "worker-drift",
  "worker-heal",
  "worker-death",
  "worker-budget-kill",
] as const as readonly [
  "worker-birth",
  "worker-activity",
  "worker-metrics",
  "worker-drift",
  "worker-heal",
  "worker-death",
  "worker-budget-kill",
] & {
  includes(
    searchElement:
      | RedskilledWorkerEventKind
      | "demand-refusal"
      | "daemon-start"
      | "daemon-death"
      | "daemon-stop"
      | "daemon-takeover-failed",
  ): boolean;
};

/**
 * The host-event kinds external consumers may rely on (ADR 0140).
 *
 * Kinds absent from this declaration are internal telemetry. They may be added,
 * removed or reshaped without widening this public contract.
 */
export const REDSKILLED_PUBLIC_HOST_EVENT_KINDS = [
  "worker-birth",
  "worker-death",
  "worker-budget-kill",
] as const satisfies readonly RedskilledWorkerEventKind[];

export type RedskilledPublicHostEventKind = typeof REDSKILLED_PUBLIC_HOST_EVENT_KINDS[number];

/** The daemon-owned records that deliberately name no Worker. */
export const REDSKILLED_DAEMON_EVENT_KINDS = [
  "demand-refusal",
  "daemon-start",
  "daemon-death",
  "daemon-stop",
  "daemon-takeover-failed",
] as const;

export type RedskilledDaemonEventKind = typeof REDSKILLED_DAEMON_EVENT_KINDS[number];

/** Every kind the host event lane may contain. */
export type RedskilledEventKind = RedskilledWorkerEventKind | RedskilledDaemonEventKind;

/**
 * Compatibility discriminator retained for readers shipped before ADR 0138.
 *
 * `daemon-stop` and `demand-refusal` are not about a Worker. The first is here because
 * its absence is what a successor otherwise has to guess at: a lane that ends
 * mid-life reads identically whether the daemon was asked to leave or was killed,
 * and only one of those is a fault worth reporting.
 *
 * New queries turn on `kind`; `event` remains byte-for-byte beside it for one
 * release so existing replay and extension consumers do not lose their lane.
 */

/**
 * One host event, flat and total.
 *
 * The Worker's identity fields ride on the death and kill events too, not just
 * on birth: a reader that had to join a death back to its birth to learn the
 * project label would be unable to report anything from a lane whose head was
 * rotated away.
 */
export interface RedskilledHostEvent {
  readonly version: 1;
  readonly ts: string;
  /** Stable query discriminator. Every row has one; no Worker record is prose-only. */
  readonly kind: RedskilledEventKind;
  /** Legacy alias for {@link kind}. */
  readonly event: RedskilledEventKind;
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  /** Detached process-group leader, when the birth writer recorded it. */
  readonly pgid?: number;
  /** OS process start discriminator, absent on legacy lanes or read failure. */
  readonly proc_start_time?: string;
  readonly workspace_path: string;
  /** Granted fork point, null on legacy and non-trunk births. */
  readonly fork_sha?: string | null;
  /** The log path the client gave at spawn, so a restart can recover a heartbeat. */
  readonly log_path: string | null;
  readonly isolated: boolean;
  /** The transient unit name — the handle a restarted daemon re-attaches by. */
  readonly unit: string | null;
  readonly memory_high: string | null;
  readonly memory_max: string | null;
  readonly cpu_weight: number | null;
  /** The host verdict that permitted a birth. */
  readonly admission_verdict: string | null;
  /** Work phase and step on an activity transition. */
  readonly phase: string | null;
  readonly step: string | null;
  /** Cumulative counters and attribution on a durable metric observation. */
  readonly tokens?: number | null;
  readonly tools?: number | null;
  readonly runner?: string | null;
  readonly model?: string | null;
  /** Refreshed trunk head and its distance from the granted fork on a drift stamp. */
  readonly base_head_sha: string | null;
  readonly base_commits_ahead: number | null;
  /** Mechanical cure applied on a heal record. */
  readonly heal_kind: string | null;
  /** Why, for a death or a kill: an exit status, a signal, a budget verdict. */
  readonly detail: string | null;
  /**
   * Why the daemon stopped, for a `daemon-stop`; `null` on every Worker event.
   *
   * Carried STRUCTURALLY beside `detail` for the same reason `exit_code` is: a
   * successor deciding whether it is taking over from a handover or from a crash
   * turns on this one word, and a reader that recovered it by parsing the
   * sentence would break the day the sentence was reworded.
   */
  readonly reason: string | null;
  /**
   * The Worker's exit status, when the daemon observed one.
   *
   * Carried STRUCTURALLY beside `detail` rather than only inside it: a project's
   * policy turns on the code — a permanent host-configuration exit is parked
   * without retry, a clean drain is not a crash — and a policy that recovered
   * that number by parsing the daemon's sentence would break the day the
   * sentence was reworded. `null` when the Worker died on a signal, or when the
   * daemon learned of the death without witnessing the exit.
   */
  readonly exit_code: number | null;
  /** The signal that ended the Worker, when one did. */
  readonly signal: string | null;
}

/** A host-event record whose discriminator carries the public stability promise. */
export type RedskilledPublicHostEvent = RedskilledHostEvent & {
  readonly kind: RedskilledPublicHostEventKind;
  readonly event: RedskilledPublicHostEventKind;
};

/** The daemon's one structured log, inside its host-scoped home. */
export const REDSKILLED_EVENT_LANE_FILE = "redskilled.log.toonl";

/** The most history one daemon generation asks every successor to replay. */
export const DEFAULT_REDSKILLED_EVENT_LANE_MAX_BYTES = 4 * 1024 * 1024;

/** Keep half a generation free so a full lane amortizes its next rewrite. */
const REDSKILLED_EVENT_LANE_COMPACTION_TARGET_RATIO = 0.5;

export interface RecordEventInput {
  readonly event: RedskilledEventKind;
  readonly worker: RedskilledWorkerView;
  readonly ts: string;
  readonly detail?: string | null;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly reason?: string | null;
}

/** Typed Worker-event input; the only entry point for new ADR 0138 records. */
export interface RecordWorkerEventInput {
  readonly kind: RedskilledWorkerEventKind;
  readonly worker: RedskilledWorkerView;
  readonly ts: string;
  readonly detail?: string | null;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly admissionVerdict?: string | null;
  readonly phase?: string | null;
  readonly step?: string | null;
  readonly tokens?: number | null;
  readonly tools?: number | null;
  readonly runner?: string | null;
  readonly model?: string | null;
  readonly baseHeadSha?: string | null;
  readonly baseCommitsAhead?: number | null;
  readonly healKind?: string | null;
}

/** One positive-depth project the demand loop deliberately did not birth for. */
export interface RecordDemandRefusalInput {
  readonly ts: string;
  readonly projectLabel: string;
  readonly detail: string;
}

/** One successor that failed its boot handshake while the incumbent stayed live. */
export interface RecordDaemonTakeoverFailedInput {
  readonly ts: string;
  readonly pid: number;
  readonly socketPath: string;
  readonly detail: string;
}

/** Build one event from a Worker view. PURE. */
export function buildHostEvent(input: RecordEventInput | RecordWorkerEventInput): RedskilledHostEvent {
  const budget = input.worker.budget ?? {};
  const kind = "kind" in input ? input.kind : input.event;
  return {
    version: 1,
    ts: input.ts,
    kind,
    event: kind,
    worker_id: input.worker.worker_id,
    project_label: input.worker.project_label,
    pid: input.worker.pid,
    ...(input.worker.pgid == null ? {} : { pgid: input.worker.pgid }),
    ...(input.worker.proc_start_time == null
      ? {}
      : { proc_start_time: input.worker.proc_start_time }),
    workspace_path: input.worker.workspace_path,
    fork_sha: input.worker.fork_sha ?? null,
    log_path: input.worker.log_path ?? null,
    isolated: input.worker.isolated,
    unit: input.worker.unit ?? null,
    memory_high: budget.memory_high ?? null,
    memory_max: budget.memory_max ?? null,
    cpu_weight: budget.cpu_weight ?? null,
    admission_verdict: "admissionVerdict" in input ? input.admissionVerdict ?? null : null,
    phase: "phase" in input ? input.phase ?? null : null,
    step: "step" in input ? input.step ?? null : null,
    tokens: "tokens" in input ? input.tokens ?? null : null,
    tools: "tools" in input ? input.tools ?? null : null,
    runner: "runner" in input ? input.runner ?? null : null,
    model: "model" in input ? input.model ?? null : null,
    base_head_sha: "baseHeadSha" in input ? input.baseHeadSha ?? null : null,
    base_commits_ahead: "baseCommitsAhead" in input ? input.baseCommitsAhead ?? null : null,
    heal_kind: "healKind" in input ? input.healKind ?? null : null,
    detail: input.detail ?? null,
    exit_code: input.exitCode ?? null,
    signal: input.signal ?? null,
    reason: "reason" in input ? input.reason ?? null : null,
  };
}

/** Build a project demand refusal without inventing a Worker. PURE. */
export function buildDemandRefusalEvent(input: RecordDemandRefusalInput): RedskilledHostEvent {
  return {
    version: 1,
    ts: input.ts,
    kind: "demand-refusal",
    event: "demand-refusal",
    worker_id: `demand:${input.projectLabel}`,
    project_label: input.projectLabel,
    pid: 0,
    workspace_path: "",
    fork_sha: null,
    log_path: null,
    isolated: false,
    unit: null,
    memory_high: null,
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    tokens: null,
    tools: null,
    runner: null,
    model: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: input.detail,
    exit_code: null,
    signal: null,
    reason: null,
  };
}

/** Build a failed takeover without forging a daemon departure. PURE. */
export function buildDaemonTakeoverFailedEvent(
  input: RecordDaemonTakeoverFailedInput,
): RedskilledHostEvent {
  return {
    version: 1,
    ts: input.ts,
    kind: "daemon-takeover-failed",
    event: "daemon-takeover-failed",
    worker_id: `${REDSKILLED_DAEMON_EVENT_PREFIX}${input.pid}`,
    project_label: "",
    pid: input.pid,
    workspace_path: input.socketPath,
    fork_sha: null,
    log_path: null,
    isolated: false,
    unit: null,
    memory_high: null,
    memory_max: null,
    cpu_weight: null,
    admission_verdict: null,
    phase: null,
    step: null,
    tokens: null,
    tools: null,
    runner: null,
    model: null,
    base_head_sha: null,
    base_commits_ahead: null,
    heal_kind: null,
    detail: input.detail,
    exit_code: null,
    signal: null,
    reason: "successor-boot-failed",
  };
}

/**
 * An open lane writer.
 *
 * The emitter is held per writer rather than per call so a session's events
 * share one segment header. A fresh process starts a fresh emitter and therefore
 * re-declares the header, which is a segment rotation the reader already
 * follows — the alternative, reading the file's tail to recover the previous
 * writer's header, would make every append depend on bytes a crash may have cut.
 */
export interface RedskilledEventLane {
  readonly path: string;
  /** Append one event; resolves once the bytes are on the lane. */
  record(input: RecordEventInput): Promise<RedskilledHostEvent>;
  /** Append one record from the closed Worker-event vocabulary. */
  recordWorker(input: RecordWorkerEventInput): Promise<RedskilledHostEvent>;
  /** Append one demand decision that refused an otherwise birth-eligible project. */
  recordDemandRefusal(input: RecordDemandRefusalInput): Promise<RedskilledHostEvent>;
  /** Append the daemon's boot after durable intent and Worker reality agree. */
  recordDaemonStart(input: RecordDaemonStartInput): Promise<RedskilledHostEvent>;
  /** Append a successor's retroactive account of an unrecorded predecessor death. */
  recordDaemonDeath(input: RecordDaemonDeathInput): Promise<RedskilledHostEvent>;
  /** Append a failed takeover while the incumbent still owns the live session. */
  recordDaemonTakeoverFailed(input: RecordDaemonTakeoverFailedInput): Promise<RedskilledHostEvent>;
  /**
   * Append the daemon's own stop; resolves once the bytes are on the lane.
   *
   * Awaited rather than fired and forgotten, because it is the last thing the
   * daemon writes: an append still in flight when the process leaves is the very
   * silence this event exists to break.
   */
  recordDaemonStop(input: RecordDaemonStopInput): Promise<RedskilledHostEvent>;
  /** Every event on the lane, oldest first, tolerating a truncated tail. */
  read(): Promise<RedskilledHostEvent[]>;
  /** Resolves once every append handed over so far has reached the lane. */
  flush(): Promise<void>;
}

export interface RedskilledEventLaneOptions {
  /** Override the production ceiling; exposed so tests can rotate tiny lanes. */
  readonly maxBytes?: number;
}

export function createRedskilledEventLane(
  path: string,
  options: RedskilledEventLaneOptions = {},
): RedskilledEventLane {
  const maxBytes = options.maxBytes ?? DEFAULT_REDSKILLED_EVENT_LANE_MAX_BYTES;
  let emitter = encodeToonlLines({ trailer: false });
  // Appends are serialised through one chain: two concurrent `appendFile` calls
  // could interleave a header and a row, and a header the reader sees mid-row is
  // exactly the corruption this lane promises not to produce.
  let tail: Promise<unknown> = Promise.resolve();

  async function append(event: RedskilledHostEvent): Promise<RedskilledHostEvent> {
    const write = tail.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await dropIncompleteTail(path);
      const encoded = emitter.push(toRow(event));
      if (await appendFits(path, encoded, maxBytes)) {
        await appendFile(path, encoded, { encoding: "utf8", mode: 0o600 });
      } else {
        await rotateEventLane(path, maxBytes, event);
        // The compact generation has its own header. A new emitter makes the
        // next append a complete segment even when its schema changes later.
        emitter = encodeToonlLines({ trailer: false });
      }
    });
    tail = write.catch(() => undefined);
    await write;
    return event;
  }

  return {
    path,
    record: (input) => append(buildHostEvent(input)),
    recordWorker: (input) => append(buildHostEvent(input)),
    recordDemandRefusal: (input) => append(buildDemandRefusalEvent(input)),
    recordDaemonStart: (input) => append(buildDaemonStartEvent(input)),
    recordDaemonDeath: (input) => append(buildDaemonDeathEvent(input)),
    recordDaemonTakeoverFailed: (input) => append(buildDaemonTakeoverFailedEvent(input)),
    recordDaemonStop: (input) => append(buildDaemonStopEvent(input)),
    read: () => readRedskilledEvents(path),
    flush: async () => {
      await tail;
    },
  };
}

/** Whether one encoded append stays inside the hard generation ceiling. */
async function appendFits(path: string, encoded: string, maxBytes: number): Promise<boolean> {
  let currentBytes = 0;
  try {
    currentBytes = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return currentBytes + Buffer.byteLength(encoded) <= maxBytes;
}

/** Atomically replace a full generation, including the append that filled it. */
async function rotateEventLane(
  path: string,
  maxBytes: number,
  incoming: RedskilledHostEvent,
): Promise<void> {
  const events = [...await readRedskilledEvents(path), incoming];
  const requiredIndices = new Set([events.length - 1]);
  const targetBytes = Math.floor(maxBytes * REDSKILLED_EVENT_LANE_COMPACTION_TARGET_RATIO);
  let compact: RedskilledHostEvent[];
  try {
    compact = compactEventLane(events, targetBytes, requiredIndices);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("redskilled event-lane baseline exceeds")) throw error;
    compact = compactEventLane(events, maxBytes, requiredIndices);
  }
  const temporary = `${path}.rotate-${process.pid}`;
  try {
    await writeFile(temporary, encodeEventLane(compact), { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Retain the newest history that fits, pinning every birth needed at boot.
 *
 * A suffix alone can strand a live Worker when its birth sits just before the
 * cut. Those births are the compact generation's baseline. Every other daemon
 * boot projection already tolerates a bounded history and reports absence when
 * its rolling window no longer has a sample.
 */
export function compactEventLane(
  events: readonly RedskilledHostEvent[],
  maxBytes: number,
  requiredIndices: ReadonlySet<number> = new Set(),
): RedskilledHostEvent[] {
  const liveIds = new Set(rehydrateWorkers(events).map((worker) => worker.worker_id));
  const pinnedIndices = new Set(requiredIndices);
  for (let index = events.length - 1; index >= 0 && liveIds.size > 0; index -= 1) {
    const event = events[index]!;
    if (event.kind !== "worker-birth" || !liveIds.has(event.worker_id)) continue;
    pinnedIndices.add(index);
    liveIds.delete(event.worker_id);
  }

  const optionalIndices = events.map((_event, index) => index).filter((index) => !pinnedIndices.has(index));
  let low = 0;
  let high = optionalIndices.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = selectedEvents(events, pinnedIndices, optionalIndices.slice(middle));
    if (Buffer.byteLength(encodeEventLane(candidate)) <= maxBytes) high = middle;
    else low = middle + 1;
  }

  const compact = selectedEvents(events, pinnedIndices, optionalIndices.slice(low));
  if (Buffer.byteLength(encodeEventLane(compact)) > maxBytes) {
    throw new Error(`redskilled event-lane baseline exceeds its ${maxBytes}-byte ceiling`);
  }
  return compact;
}

function selectedEvents(
  events: readonly RedskilledHostEvent[],
  pinnedIndices: ReadonlySet<number>,
  optionalIndices: readonly number[],
): RedskilledHostEvent[] {
  const selected = new Set([...pinnedIndices, ...optionalIndices]);
  return events.filter((_event, index) => selected.has(index));
}

function encodeEventLane(events: readonly RedskilledHostEvent[]): string {
  if (events.length === 0) return "";
  const emitter = encodeToonlLines({ trailer: false });
  return events.map((event) => emitter.push(toRow(event))).join("");
}

/**
 * Cut a crash's half-written last line off the lane, before every append.
 *
 * Before EVERY append rather than once per writer: the check costs a stat and a
 * single byte, and "the file always ends on a line boundary" is a property worth
 * more than that — a writer that only checked at startup would fuse its rows
 * onto a tail that anything else truncated later.
 *
 * This is not a rewrite of the lane and it is not in tension with append-only:
 * the bytes it drops were never a record, only the beginning of one nobody
 * finished. Leaving them would be far worse than dropping them — the next append
 * would fuse onto the unterminated line and turn one lost event into a line no
 * reader can decode, which is a corruption that outlives the crash.
 */
async function dropIncompleteTail(path: string): Promise<void> {
  let size: number;
  try {
    size = (await stat(path)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (size === 0) return;

  // Read backwards a window at a time: a lane is small in practice, and reading
  // the whole file to inspect its last byte would make every daemon start pay
  // for the session's entire history.
  const window = 64 * 1024;
  const handle = await open(path, "r");
  try {
    const last = Buffer.alloc(1);
    await handle.read(last, 0, 1, size - 1);
    if (last[0] === 0x0a) return;
    for (let end = size; end > 0; end -= window) {
      const length = Math.min(window, end);
      const chunk = Buffer.alloc(length);
      await handle.read(chunk, 0, length, end - length);
      const newline = chunk.lastIndexOf(0x0a);
      if (newline >= 0) {
        await truncate(path, end - length + newline + 1);
        return;
      }
    }
    // Not one complete line in the whole file: the crash took everything.
    await truncate(path, 0);
  } finally {
    await handle.close();
  }
}

/** Every event on the lane at `path`; an absent lane is an empty history. */
export async function readRedskilledEvents(path: string): Promise<RedskilledHostEvent[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseEventLane(raw);
}

export type RedskilledEventLanePosition = EventLanePosition;
export type RedskilledPositionedEventRead = PositionedEventRead<RedskilledHostEvent>;

/** Read from one generation, reporting the current bounded lane after rotation. */
export async function readRedskilledEventsFrom(
  path: string,
  position?: RedskilledEventLanePosition | null,
): Promise<RedskilledPositionedEventRead> {
  return await readPositionedEventLane(path, position, parseEventLane);
}

export type RedskilledPublicEventFollow<TBaseline> =
  | {
      readonly status: "events";
      readonly events: readonly RedskilledPublicHostEvent[];
      readonly position: RedskilledEventLanePosition | null;
    }
  | {
      readonly status: "baseline";
      readonly reason: "initial" | "position-rotated";
      readonly baseline: TBaseline;
      readonly events: readonly [];
      readonly position: RedskilledEventLanePosition | null;
    };

/**
 * Follow only public host events, replacing a missing prefix with current state.
 *
 * The position is captured before `readBaseline` runs. An event racing the host
 * read is therefore either already reflected by that state or appears again on
 * the next follow; it is never silently skipped between the two authorities.
 */
export async function followRedskilledPublicEvents<TBaseline>(
  path: string,
  position: RedskilledEventLanePosition | null | undefined,
  readBaseline: () => Promise<TBaseline>,
): Promise<RedskilledPublicEventFollow<TBaseline>> {
  const read = await readRedskilledEventsFrom(path, position);
  if (position == null || read.status === "rebaseline-required") {
    return {
      status: "baseline",
      reason: position == null ? "initial" : "position-rotated",
      baseline: await readBaseline(),
      events: [],
      position: read.position,
    };
  }
  return {
    status: "events",
    events: read.events.filter(isPublicHostEvent),
    position: read.position,
  };
}

function isPublicHostEvent(event: RedskilledHostEvent): event is RedskilledPublicHostEvent {
  return (REDSKILLED_PUBLIC_HOST_EVENT_KINDS as readonly RedskilledEventKind[]).includes(event.kind);
}

/**
 * Decode a lane's text into events: the crash-truncated tail is dropped, and
 * historical rows no header can hold are skipped by `decodeLaneRows`. PURE.
 */
export function parseEventLane(raw: string): RedskilledHostEvent[] {
  const lines = raw.split("\n");
  // `split` leaves a trailing "" for a newline-terminated file; anything else in
  // that slot is the half-written line a crash left behind.
  lines.pop();
  if (lines.length === 0) return [];
  const { records, malformed } = decodeLaneRows(lines);
  if (malformed.length > 0) {
    console.warn(`redskilled event lane skipped ${malformed.length} malformed row(s) at line ${malformed.join(", ")}`);
  }
  return records.filter(isHostEventRecord).map(fromRow);
}

/**
 * Replay events into the Workers the daemon should still believe are alive.
 *
 * Last event per Worker wins: a birth admits it, a death or a budget kill
 * retires it. Ordering is the lane's own, which is the order the daemon observed
 * the facts in — a timestamp comparison would let a clock adjustment resurrect a
 * Worker the daemon watched die. PURE.
 */
export function rehydrateWorkers(events: readonly RedskilledHostEvent[]): RedskilledWorkerView[] {
  const alive = new Map<string, RedskilledWorkerView>();
  for (const event of events) {
    // A daemon's own stop retires nothing: the daemon left and every Worker it
    // held is still running, which is exactly what the successor replays to find.
    if ((REDSKILLED_DAEMON_EVENT_KINDS as readonly RedskilledEventKind[]).includes(event.kind)) continue;
    if (event.kind === "worker-birth") alive.set(event.worker_id, toWorkerView(event));
    else if (event.kind === "worker-death" || event.kind === "worker-budget-kill") alive.delete(event.worker_id);
  }
  return [...alive.values()];
}

/**
 * How the previous daemon left, read off the lane a successor replays. PURE.
 *
 * `null` means the lane's last daemon never said goodbye — a crash, a kill, or a
 * lane that has simply never seen a stop. That is the whole point of the answer:
 * the successor tells a handover from a death by whether the predecessor's own
 * stop is the last thing on the lane, not by guessing from the Workers it finds.
 */
export function lastRedskilledDaemonStop(
  events: readonly RedskilledHostEvent[],
): RedskilledHostEvent | null {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.kind === "daemon-stop") return event;
  }
  return null;
}

/** The Worker view an event describes. PURE. */
export function toWorkerView(event: RedskilledHostEvent): RedskilledWorkerView {
  const budget: RedskilledWorkerBudget = {
    ...(event.memory_high != null ? { memory_high: event.memory_high } : {}),
    ...(event.memory_max != null ? { memory_max: event.memory_max } : {}),
    ...(event.cpu_weight != null ? { cpu_weight: event.cpu_weight } : {}),
  };
  return {
    worker_id: event.worker_id,
    project_label: event.project_label,
    pid: event.pid,
    ...(event.pgid == null ? {} : { pgid: event.pgid }),
    ...(event.proc_start_time == null
      ? {}
      : { proc_start_time: event.proc_start_time }),
    started_at: event.ts,
    workspace_path: event.workspace_path,
    ...(event.fork_sha != null ? { fork_sha: event.fork_sha } : {}),
    ...(event.log_path != null ? { log_path: event.log_path } : {}),
    isolated: event.isolated,
    ...(event.unit != null ? { unit: event.unit } : {}),
    ...(Object.keys(budget).length > 0 ? { budget } : {}),
    warnings: [],
  };
}

function toRow(event: RedskilledHostEvent): ToonlRecord {
  return { ...event };
}

function isHostEventRecord(record: ToonlRecord): boolean {
  const kind = record.kind ?? record.event;
  return record.version === 1 &&
    typeof record.ts === "string" &&
    typeof record.worker_id === "string" &&
    ([...REDSKILLED_WORKER_EVENT_KINDS, ...REDSKILLED_DAEMON_EVENT_KINDS] as readonly unknown[]).includes(kind);
}

function fromRow(record: ToonlRecord): RedskilledHostEvent {
  const kind = (record.kind ?? record.event) as RedskilledEventKind;
  return {
    version: 1,
    ts: String(record.ts),
    kind,
    event: kind,
    worker_id: String(record.worker_id),
    project_label: text(record.project_label) ?? "",
    pid: Number(record.pid ?? 0),
    ...(record.pgid == null || record.pgid === "" ? {} : { pgid: Number(record.pgid) }),
    ...(text(record.proc_start_time) == null
      ? {}
      : { proc_start_time: text(record.proc_start_time)! }),
    workspace_path: text(record.workspace_path) ?? "",
    fork_sha: text(record.fork_sha),
    log_path: text(record.log_path),
    isolated: record.isolated === true || record.isolated === "true",
    unit: text(record.unit),
    memory_high: text(record.memory_high),
    memory_max: text(record.memory_max),
    cpu_weight: record.cpu_weight == null || record.cpu_weight === "" ? null : Number(record.cpu_weight),
    admission_verdict: text(record.admission_verdict),
    phase: text(record.phase),
    step: text(record.step),
    tokens: record.tokens == null || record.tokens === "" ? null : Number(record.tokens),
    tools: record.tools == null || record.tools === "" ? null : Number(record.tools),
    runner: text(record.runner),
    model: text(record.model),
    base_head_sha: text(record.base_head_sha),
    base_commits_ahead: record.base_commits_ahead == null || record.base_commits_ahead === ""
      ? null
      : Number(record.base_commits_ahead),
    heal_kind: text(record.heal_kind),
    detail: text(record.detail),
    // A lane written before the exit facts existed reads them as absent rather
    // than as `0` — an exit code of zero is a CLEAN drain, and inventing one for
    // an old row would tell a project a crashed Worker finished its work.
    exit_code: record.exit_code == null || record.exit_code === "" ? null : Number(record.exit_code),
    signal: text(record.signal),
    // A lane written before stops were recorded reads them as absent, never as a
    // crash: "this daemon did not say why it left" is the honest answer for a row
    // whose writer had no way to say anything.
    reason: text(record.reason),
  };
}

function text(value: ToonlRecord[string]): string | null {
  if (value == null || value === "") return null;
  return String(value);
}
