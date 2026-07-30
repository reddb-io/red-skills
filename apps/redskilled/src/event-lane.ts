/**
 * event-lane — the daemon's own append-only memory of the Workers it birthed.
 *
 * **One lane, three facts: birth, death, and a budget-driven kill.** ADR 0130
 * gives the daemon exactly one thing no other authority holds — Worker-to-process
 * — and this lane is the durable form of it. The tracker already owns
 * issue-to-PR and git already owns branch-to-commits, so a per-Worker durable
 * record would be a third copy of facts two authorities already keep, and the
 * only thing a third copy reliably does is drift.
 *
 * **Append-only, never rewritten.** A restarted daemon rehydrates by replaying
 * the lane, so a writer that rewrote a record would be editing the past out from
 * under a reader mid-replay. Every event is a whole line appended in one call.
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
import { appendFile, mkdir, open, readFile, stat, truncate } from "node:fs/promises";
import { dirname } from "node:path";
import { encodeLines, parseRecords, type ToonlRecord } from "@reddb-io/toon";
import type { RedskilledWorkerView } from "./host-state.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

/** The three facts the lane carries. Nothing else is a host event. */
export type RedskilledEventKind = "worker-birth" | "worker-death" | "worker-budget-kill";

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
  readonly event: RedskilledEventKind;
  readonly worker_id: string;
  readonly project_label: string;
  readonly pid: number;
  readonly workspace_path: string;
  /** The log path the client gave at spawn, so a restart can recover a heartbeat. */
  readonly log_path: string | null;
  readonly isolated: boolean;
  /** The transient unit name — the handle a restarted daemon re-attaches by. */
  readonly unit: string | null;
  readonly memory_high: string | null;
  readonly memory_max: string | null;
  readonly cpu_weight: number | null;
  /** Why, for a death or a kill: an exit status, a signal, a budget verdict. */
  readonly detail: string | null;
}

/** The lane file's name inside the session runtime directory. */
export const REDSKILLED_EVENT_LANE_FILE = "redskilled.events.toonl";

export interface RecordEventInput {
  readonly event: RedskilledEventKind;
  readonly worker: RedskilledWorkerView;
  readonly ts: string;
  readonly detail?: string | null;
}

/** Build one event from a Worker view. PURE. */
export function buildHostEvent(input: RecordEventInput): RedskilledHostEvent {
  const budget = input.worker.budget ?? {};
  return {
    version: 1,
    ts: input.ts,
    event: input.event,
    worker_id: input.worker.worker_id,
    project_label: input.worker.project_label,
    pid: input.worker.pid,
    workspace_path: input.worker.workspace_path,
    log_path: input.worker.log_path ?? null,
    isolated: input.worker.isolated,
    unit: input.worker.unit ?? null,
    memory_high: budget.memory_high ?? null,
    memory_max: budget.memory_max ?? null,
    cpu_weight: budget.cpu_weight ?? null,
    detail: input.detail ?? null,
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
  /** Every event on the lane, oldest first, tolerating a truncated tail. */
  read(): Promise<RedskilledHostEvent[]>;
  /** Resolves once every append handed over so far has reached the lane. */
  flush(): Promise<void>;
}

export function createRedskilledEventLane(path: string): RedskilledEventLane {
  const emitter = encodeLines({ trailer: false });
  // Appends are serialised through one chain: two concurrent `appendFile` calls
  // could interleave a header and a row, and a header the reader sees mid-row is
  // exactly the corruption this lane promises not to produce.
  let tail: Promise<unknown> = Promise.resolve();

  return {
    path,
    async record(input) {
      const event = buildHostEvent(input);
      const write = tail.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await dropIncompleteTail(path);
        await appendFile(path, emitter.push(toRow(event)), { encoding: "utf8", mode: 0o600 });
      });
      tail = write.catch(() => undefined);
      await write;
      return event;
    },
    read: () => readRedskilledEvents(path),
    flush: async () => {
      await tail;
    },
  };
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

/**
 * Decode a lane's text into events, dropping a crash-truncated tail. PURE.
 *
 * Only a line the writer never terminated is dropped, and only from the end: a
 * reader that skipped every line it could not decode would silently swallow a
 * genuine format bug in the middle of the lane as if it were a crash.
 */
export function parseEventLane(raw: string): RedskilledHostEvent[] {
  const lines = raw.split("\n");
  // `split` leaves a trailing "" for a newline-terminated file; anything else in
  // that slot is the half-written line a crash left behind.
  lines.pop();
  if (lines.length === 0) return [];
  const records = parseRecords(`${lines.join("\n")}\n`);
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
    if (event.event === "worker-birth") alive.set(event.worker_id, toWorkerView(event));
    else alive.delete(event.worker_id);
  }
  return [...alive.values()];
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
    started_at: event.ts,
    workspace_path: event.workspace_path,
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
  return record.version === 1 &&
    typeof record.ts === "string" &&
    typeof record.worker_id === "string" &&
    (record.event === "worker-birth" || record.event === "worker-death" || record.event === "worker-budget-kill");
}

function fromRow(record: ToonlRecord): RedskilledHostEvent {
  return {
    version: 1,
    ts: String(record.ts),
    event: record.event as RedskilledEventKind,
    worker_id: String(record.worker_id),
    project_label: text(record.project_label) ?? "",
    pid: Number(record.pid ?? 0),
    workspace_path: text(record.workspace_path) ?? "",
    log_path: text(record.log_path),
    isolated: record.isolated === true || record.isolated === "true",
    unit: text(record.unit),
    memory_high: text(record.memory_high),
    memory_max: text(record.memory_max),
    cpu_weight: record.cpu_weight == null || record.cpu_weight === "" ? null : Number(record.cpu_weight),
    detail: text(record.detail),
  };
}

function text(value: ToonlRecord[string]): string | null {
  if (value == null || value === "") return null;
  return String(value);
}
