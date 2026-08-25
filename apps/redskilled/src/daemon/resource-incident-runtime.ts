import { dirname, join } from "node:path";
import type { RedskilledResourceIncidentState } from "../host-state.js";
import {
  ResourceIncidentTracker,
  createResourceIncidentStore,
  sampleCurrentDaemonResources,
  type DaemonResourceSampler,
  type RedskilledResourceSample,
  type ResourceIncidentStore,
  type ResourceIncidentSummary,
} from "../resource-incidents.js";

export interface ResourceIncidentRuntime {
  ingest(workerSamples: readonly RedskilledResourceSample[], sampledAt: string): Promise<void>;
  state(): RedskilledResourceIncidentState;
  hasActiveIncident(): boolean;
  /** Drop every belief about one dead target; part of `forgetWorker`. */
  forget(targetId: string): void;
}

export const DISABLED_RESOURCE_INCIDENT_RUNTIME: ResourceIncidentRuntime = {
  ingest: async () => undefined,
  forget: () => undefined,
  state: () => ({ source: "cgroup-v2-preferred", active: 0, retained: 0, latest: [] }),
  hasActiveIncident: () => false,
};

/**
 * The incident runtime this daemon gets, decided from its sampling cadence.
 *
 * A daemon that does not sample cannot observe an incident, so it holds the
 * disabled runtime rather than a live one that never ticks. Assembled HERE
 * rather than at the call site because the lifecycle module is the one place
 * that must not grow: the store path is derived from the event lane, and that
 * derivation belongs beside the store it names.
 */
export async function resolveResourceIncidentRuntime(
  eventLanePath: string,
  pid: number,
  sampleMs: number,
  overrides: {
    resourceIncidentStore?: ResourceIncidentStore;
    resourceIncidentTracker?: ResourceIncidentTracker;
    daemonResourceSampler?: DaemonResourceSampler;
  },
): Promise<ResourceIncidentRuntime> {
  if (sampleMs <= 0) return DISABLED_RESOURCE_INCIDENT_RUNTIME;
  return await createResourceIncidentRuntime({
    root: join(dirname(eventLanePath), "state", "incidents"),
    pid,
    normalCadenceMs: sampleMs,
    store: overrides.resourceIncidentStore,
    tracker: overrides.resourceIncidentTracker,
    daemonSampler: overrides.daemonResourceSampler,
  });
}

export async function createResourceIncidentRuntime(options: {
  root: string;
  pid: number;
  normalCadenceMs: number;
  store?: ResourceIncidentStore;
  tracker?: ResourceIncidentTracker;
  daemonSampler?: DaemonResourceSampler;
}): Promise<ResourceIncidentRuntime> {
  const tracker = options.tracker ?? new ResourceIncidentTracker({ normalCadenceMs: options.normalCadenceMs });
  const store = options.store ?? createResourceIncidentStore({ root: options.root });
  const daemonSampler = options.daemonSampler ?? sampleCurrentDaemonResources;
  let summaries: ResourceIncidentSummary[] = await store.list().catch(() => []);
  const persistedAt = new Map<string, number>();

  async function ingestOne(sample: RedskilledResourceSample): Promise<void> {
    const result = tracker.ingest(sample);
    if (result.kind === "buffered") return;
    const now = Date.parse(sample.sampled_at);
    const previous = persistedAt.get(result.incident.incident_id) ?? 0;
    if (result.kind !== "opened" && result.kind !== "finalized" && now - previous < 15_000) return;
    await store.save(result.incident).catch(() => undefined);
    persistedAt.set(result.incident.incident_id, now);
    summaries = await store.list().catch(() => summaries);
    if (result.kind === "finalized") persistedAt.delete(result.incident.incident_id);
  }

  return {
    async ingest(workerSamples, sampledAt) {
      const samples = [...workerSamples];
      try {
        samples.push(daemonSampler(sampledAt));
      } catch {
        samples.push(unavailableDaemonSample(sampledAt, options.pid));
      }
      for (const sample of samples) await ingestOne(sample);
    },
    state: () => ({
      source: "cgroup-v2-preferred",
      active: tracker.activeIncidentCount(),
      retained: summaries.length,
      latest: summaries.slice(0, 5),
    }),
    hasActiveIncident: () => tracker.hasActiveIncident(),
    // The eviction forgetWorker calls: the tracker drops the target's state
    // (ring, consecutive counters, an open incident's sample buffer), and any
    // persistedAt entry for a never-finalized incident goes with it.
    forget: (targetId) => {
      tracker.forget(targetId);
      for (const incidentId of persistedAt.keys()) {
        if (incidentId.startsWith(`${targetId}-`)) persistedAt.delete(incidentId);
      }
    },
  };
}

function unavailableDaemonSample(sampledAt: string, pid: number): RedskilledResourceSample {
  return {
    schema: "red.redskilled.resource_sample.v1",
    sampled_at: sampledAt,
    target: { kind: "daemon", id: `daemon:${pid}` },
    source: "unavailable",
    memory: { current_bytes: 0, peak_bytes: 0, max_bytes: null },
    cpu: { usage_usec: 0, user_usec: 0, system_usec: 0, nr_periods: 0, nr_throttled: 0, throttled_usec: 0 },
    pressure: {},
    pids: { current: 0, peak: 0, max: null },
  };
}
