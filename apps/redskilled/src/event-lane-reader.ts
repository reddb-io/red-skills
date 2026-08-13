/**
 * event-lane-reader — read, replay, and follow the daemon's bounded event lane.
 *
 * The writer owns append and rotation. This module owns the other half of the
 * contract: decoding a generation, rebuilding live Worker state, and refusing
 * a public follower whose host topology cannot observe WSL-side file changes.
 */
import { readFile } from "node:fs/promises";
import { decodeHostEventRow, decodeLaneRows } from "./event-lane-decode.js";
import {
  readPositionedEventLane,
  type EventLanePosition,
  type PositionedEventRead,
} from "./event-lane-position.js";
import {
  REDSKILLED_DAEMON_EVENT_KINDS,
  REDSKILLED_PUBLIC_HOST_EVENT_KINDS,
  REDSKILLED_WORKER_EVENT_KINDS,
  type RedskilledEventKind,
  type RedskilledHostEvent,
  type RedskilledPublicHostEvent,
} from "./event-lane.js";
import type { RedskilledWorkerView } from "./host-state.js";
import {
  detectRedskilledHostTopology,
  evaluateRedskilledHostEventTopology,
  readRedskilledHostTopology,
  type RedskilledHostEventTopology,
  type RedskilledHostTopology,
} from "./host-topology.js";
import type { RedskilledWorkerBudget } from "./worker-placement.js";

type ToonlRecord = Record<string, string | number | boolean | null>;

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
    }
  | {
      readonly status: "refused";
      readonly reason: "unsupported-topology";
      readonly topology: Exclude<RedskilledHostEventTopology, "same-side">;
      readonly detail: string;
      readonly events: readonly [];
      readonly position: null;
    };

export interface RedskilledPublicEventFollowOptions {
  /** Test seam; production detects the consumer from its own kernel. */
  readonly consumerTopology?: RedskilledHostTopology;
}

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
  options: RedskilledPublicEventFollowOptions = {},
): Promise<RedskilledPublicEventFollow<TBaseline>> {
  const read = await readRedskilledEventsFrom(path, position);
  if (position == null || read.status === "rebaseline-required") {
    const baseline = await readBaseline();
    const daemonTopology = readRedskilledHostTopology(baseline);
    if (daemonTopology != null) {
      const verdict = evaluateRedskilledHostEventTopology(
        daemonTopology,
        options.consumerTopology ?? detectRedskilledHostTopology(),
      );
      if (!verdict.observable && verdict.topology !== "same-side") {
        return {
          status: "refused",
          reason: "unsupported-topology",
          topology: verdict.topology,
          detail: verdict.detail,
          events: [],
          position: null,
        };
      }
    }
    return {
      status: "baseline",
      reason: position == null ? "initial" : "position-rotated",
      baseline,
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
  return records.filter(isHostEventRecord).map(decodeHostEventRow);
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

function isHostEventRecord(record: ToonlRecord): boolean {
  const kind = record.kind ?? record.event;
  return record.version === 1 &&
    typeof record.ts === "string" &&
    typeof record.worker_id === "string" &&
    ([...REDSKILLED_WORKER_EVENT_KINDS, ...REDSKILLED_DAEMON_EVENT_KINDS] as readonly unknown[]).includes(kind);
}
