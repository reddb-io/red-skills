/**
 * Cross-host fleet aggregation over the singleton event lane.
 *
 * Each host's supervisor/resident appends `fleet.supervisor.heartbeat` events to
 * the shared singleton-events.toonl lane. This module reads those events, groups
 * them by machine_id_hash, and emits one HostFleetView per host ordered by
 * recency. Hosts whose latest event predates the silence threshold surface as
 * `silent: true`.
 *
 * Single-host mode is the degenerate case: one event → one host entry with
 * last_event_age_s = 0 and silent = false when the event is fresh.
 */

export const FLEET_HEARTBEAT_KIND = "fleet.supervisor.heartbeat";

/** Seconds without a heartbeat before a host is marked silent. */
export const SILENT_HOST_THRESHOLD_S = 300;

export interface HostFleetWorker {
  id: string;
  issue: string;
  activity: string;
}

export interface HostFleetSlots {
  busy: number;
  free: number;
  total: number;
  parked: number;
}

/** One host's fleet state as aggregated from its latest heartbeat event. */
export interface HostFleetView {
  machine_id_hash: string;
  fleet_name: string;
  runner: string;
  target: number;
  bundle_version: string;
  slots: HostFleetSlots;
  workers: HostFleetWorker[];
  ready_for_agent: number;
  last_event_at: string;
  /** Seconds since last_event_at, rounded down. */
  last_event_age_s: number;
  /** True when last_event_age_s > silentThresholdS. */
  silent: boolean;
}

/** Aggregated cross-host view. */
export interface FederatedFleetViewOutput {
  hosts: HostFleetView[];
  total_busy: number;
  total_free: number;
  total_workers: number;
}

interface RawEvent {
  readonly at: string;
  readonly kind: string;
  readonly payload?: Record<string, unknown>;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toSlots(value: unknown): HostFleetSlots {
  const s =
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    busy: toNumber(s["busy"]),
    free: toNumber(s["free"]),
    total: toNumber(s["total"]),
    parked: toNumber(s["parked"]),
  };
}

function toWorkers(value: unknown): HostFleetWorker[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((w) => w !== null && typeof w === "object")
    .map((w: Record<string, unknown>) => ({
      id: typeof w["id"] === "string" ? w["id"] : "",
      issue:
        typeof w["issue"] === "string"
          ? w["issue"]
          : String(w["issue"] ?? ""),
      activity: typeof w["activity"] === "string" ? w["activity"] : "",
    }));
}

export interface FederatedFleetViewOptions {
  nowMs?: number;
  silentThresholdS?: number;
}

/**
 * Aggregate fleet heartbeat events into a cross-host organism view.
 *
 * Events are filtered to `fleet.supervisor.heartbeat`, grouped by
 * `payload.machine_id_hash`, and the newest per-host record wins.
 * Hosts are ordered by last_event_at descending (most recent first).
 */
export function aggregateFederatedFleetView(
  events: readonly RawEvent[],
  options: FederatedFleetViewOptions = {},
): FederatedFleetViewOutput {
  const nowMs = options.nowMs ?? Date.now();
  const silentThresholdS = options.silentThresholdS ?? SILENT_HOST_THRESHOLD_S;

  const latestByHost = new Map<
    string,
    { at: string; payload: Record<string, unknown> }
  >();

  for (const event of events) {
    if (event.kind !== FLEET_HEARTBEAT_KIND || !event.payload) continue;
    const hash =
      typeof event.payload["machine_id_hash"] === "string"
        ? event.payload["machine_id_hash"]
        : null;
    if (!hash) continue;
    const existing = latestByHost.get(hash);
    if (!existing || event.at > existing.at) {
      latestByHost.set(hash, { at: event.at, payload: event.payload });
    }
  }

  const hosts: HostFleetView[] = Array.from(latestByHost.values())
    .sort((a, b) => b.at.localeCompare(a.at))
    .map(({ at, payload }) => {
      const last_event_age_s = Math.max(
        0,
        Math.floor((nowMs - Date.parse(at)) / 1000),
      );
      return {
        machine_id_hash: payload["machine_id_hash"] as string,
        fleet_name:
          typeof payload["fleet_name"] === "string"
            ? payload["fleet_name"]
            : "default",
        runner:
          typeof payload["runner"] === "string" ? payload["runner"] : "",
        target: toNumber(payload["target"]),
        bundle_version:
          typeof payload["bundle_version"] === "string"
            ? payload["bundle_version"]
            : "",
        slots: toSlots(payload["slots"]),
        workers: toWorkers(payload["workers"]),
        ready_for_agent: toNumber(payload["ready_for_agent"]),
        last_event_at: at,
        last_event_age_s,
        silent: last_event_age_s > silentThresholdS,
      };
    });

  const total_busy = hosts.reduce((sum, h) => sum + h.slots.busy, 0);
  const total_free = hosts.reduce((sum, h) => sum + h.slots.free, 0);
  const total_workers = hosts.reduce((sum, h) => sum + h.workers.length, 0);

  return { hosts, total_busy, total_free, total_workers };
}
