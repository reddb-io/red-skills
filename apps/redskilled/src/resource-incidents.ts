import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decode, encode, encodeToonlLines, parseRecords, type JsonValue } from "@reddb-io/toon";

export const RESOURCE_SAMPLE_SCHEMA = "red.redskilled.resource_sample.v1" as const;
export const RESOURCE_INCIDENT_SCHEMA = "red.redskilled.resource_incident.v1" as const;

export type ResourceTarget = {
  kind: "worker" | "daemon" | "castle-resident";
  id: string;
  project_label?: string;
};

export type PressureReading = {
  avg10: number;
  avg60: number;
  avg300: number;
  total_usec: number;
};

export type RedskilledResourceSample = {
  schema: typeof RESOURCE_SAMPLE_SCHEMA;
  sampled_at: string;
  target: ResourceTarget;
  source: "cgroup-v2" | "process-tree" | "unavailable";
  memory: {
    current_bytes: number;
    peak_bytes: number;
    max_bytes: number | null;
    swap_current_bytes?: number;
    swap_peak_bytes?: number;
    swap_max_bytes?: number | null;
    events?: Record<string, number>;
    events_local?: Record<string, number>;
  };
  cpu: {
    usage_usec: number;
    user_usec: number;
    system_usec: number;
    nr_periods: number;
    nr_throttled: number;
    throttled_usec: number;
  };
  pressure: Partial<Record<"cpu" | "memory" | "io", Partial<Record<"some" | "full", PressureReading>>>>;
  pids: {
    current: number;
    peak: number;
    max: number | null;
    events?: Record<string, number>;
  };
  processes?: number;
};

export type ResourceIncidentTrigger =
  | "memory-ratio"
  | "pids-ratio"
  | "memory-events-max"
  | "memory-events-oom"
  | "memory-events-oom-kill"
  | "pids-events-max"
  | "memory-pressure"
  | "cpu-pressure"
  | "cpu-throttling";

export type RedskilledResourceIncident = {
  schema: typeof RESOURCE_INCIDENT_SCHEMA;
  incident_id: string;
  target: ResourceTarget;
  opened_at: string;
  closed_at?: string;
  state: "active" | "recovering" | "completed";
  triggers: ResourceIncidentTrigger[] | string[];
  samples: RedskilledResourceSample[];
};

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return undefined;
  }
}

function finite(raw: string | undefined, fallback = 0): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function finiteOrMax(raw: string | undefined): number | null {
  if (raw === undefined || raw === "max") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function parseKeyValues(raw: string | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of raw?.split(/\n+/) ?? []) {
    const [key, value] = line.trim().split(/\s+/, 2);
    if (key === undefined || value === undefined) continue;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) result[key] = parsed;
  }
  return result;
}

function parsePressure(raw: string | undefined): Partial<Record<"some" | "full", PressureReading>> | undefined {
  if (raw === undefined) return undefined;
  const result: Partial<Record<"some" | "full", PressureReading>> = {};
  for (const line of raw.split(/\n+/)) {
    const [kind, ...pairs] = line.trim().split(/\s+/);
    if (kind !== "some" && kind !== "full") continue;
    const values = Object.fromEntries(pairs.map((pair) => pair.split("=", 2)));
    result[kind] = {
      avg10: finite(values.avg10),
      avg60: finite(values.avg60),
      avg300: finite(values.avg300),
      total_usec: finite(values.total),
    };
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

/** Read only numeric cgroup-v2 resource counters. No process command line or environment is inspected. */
export function readCgroupResourceSample(
  cgroupDir: string,
  options: { sampledAt?: string; target: ResourceTarget },
): RedskilledResourceSample {
  const cpu = parseKeyValues(readOptional(join(cgroupDir, "cpu.stat")));
  const memoryEvents = parseKeyValues(readOptional(join(cgroupDir, "memory.events")));
  const memoryEventsLocal = parseKeyValues(readOptional(join(cgroupDir, "memory.events.local")));
  const pidsEvents = parseKeyValues(readOptional(join(cgroupDir, "pids.events")));
  const pressure: RedskilledResourceSample["pressure"] = {};
  for (const kind of ["cpu", "memory", "io"] as const) {
    const reading = parsePressure(readOptional(join(cgroupDir, `${kind}.pressure`)));
    if (reading !== undefined) pressure[kind] = reading;
  }

  return {
    schema: RESOURCE_SAMPLE_SCHEMA,
    sampled_at: options.sampledAt ?? new Date().toISOString(),
    target: options.target,
    source: "cgroup-v2",
    memory: {
      current_bytes: finite(readOptional(join(cgroupDir, "memory.current"))),
      peak_bytes: finite(readOptional(join(cgroupDir, "memory.peak"))),
      max_bytes: finiteOrMax(readOptional(join(cgroupDir, "memory.max"))),
      swap_current_bytes: finite(readOptional(join(cgroupDir, "memory.swap.current"))),
      swap_peak_bytes: finite(readOptional(join(cgroupDir, "memory.swap.peak"))),
      swap_max_bytes: finiteOrMax(readOptional(join(cgroupDir, "memory.swap.max"))),
      events: memoryEvents,
      events_local: memoryEventsLocal,
    },
    cpu: {
      usage_usec: cpu.usage_usec ?? 0,
      user_usec: cpu.user_usec ?? 0,
      system_usec: cpu.system_usec ?? 0,
      nr_periods: cpu.nr_periods ?? 0,
      nr_throttled: cpu.nr_throttled ?? 0,
      throttled_usec: cpu.throttled_usec ?? 0,
    },
    pressure,
    pids: {
      current: finite(readOptional(join(cgroupDir, "pids.current"))),
      peak: finite(readOptional(join(cgroupDir, "pids.peak"))),
      max: finiteOrMax(readOptional(join(cgroupDir, "pids.max"))),
      events: pidsEvents,
    },
  };
}

export type DaemonResourceSampler = (sampledAt: string) => RedskilledResourceSample;

export type ResourceWindowEvidence = {
  source: RedskilledResourceSample["source"];
  sampled_before: string;
  sampled_after: string;
  memory_current_before_bytes: number;
  memory_current_after_bytes: number;
  memory_peak_bytes: number;
  memory_max_bytes: number | null;
  cpu_usage_delta_usec: number;
  cpu_throttled_delta_usec: number;
  pids_peak: number;
  memory_events_delta: Record<string, number>;
  pids_events_delta: Record<string, number>;
};

/**
 * Sample this daemon without walking the host. Linux prefers its cgroup-v2
 * boundary; other hosts state the weaker process source explicitly.
 */
export function sampleCurrentDaemonResources(
  sampledAt = new Date().toISOString(),
  options: { platform?: NodeJS.Platform; cgroupRoot?: string; selfCgroupPath?: string; pid?: number } = {},
): RedskilledResourceSample {
  const target: ResourceTarget = { kind: "daemon", id: `daemon:${options.pid ?? process.pid}` };
  return sampleCurrentProcessResources(target, sampledAt, options);
}

export function sampleCurrentProcessResources(
  target: ResourceTarget,
  sampledAt = new Date().toISOString(),
  options: { platform?: NodeJS.Platform; cgroupRoot?: string; selfCgroupPath?: string } = {},
): RedskilledResourceSample {
  const platform = options.platform ?? process.platform;
  if (platform === "linux") {
    const selfPath = options.selfCgroupPath ?? readSelfCgroupPath();
    if (selfPath !== undefined) {
      const dir = join(options.cgroupRoot ?? "/sys/fs/cgroup", selfPath);
      if (readOptional(join(dir, "memory.current")) !== undefined) {
        return readCgroupResourceSample(dir, { sampledAt, target });
      }
    }
  }
  const usage = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    schema: RESOURCE_SAMPLE_SCHEMA,
    sampled_at: sampledAt,
    target,
    source: "process-tree",
    memory: { current_bytes: usage.rss, peak_bytes: usage.rss, max_bytes: null },
    cpu: {
      usage_usec: cpu.user + cpu.system,
      user_usec: cpu.user,
      system_usec: cpu.system,
      nr_periods: 0,
      nr_throttled: 0,
      throttled_usec: 0,
    },
    pressure: {},
    pids: { current: 1, peak: 1, max: null },
    processes: 1,
  };
}

function counterDelta(after: Record<string, number> | undefined, before: Record<string, number> | undefined): Record<string, number> {
  const result: Record<string, number> = {};
  for (const key of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
    const delta = Math.max(0, (after?.[key] ?? 0) - (before?.[key] ?? 0));
    if (delta > 0) result[key] = delta;
  }
  return result;
}

export function summarizeResourceWindow(
  before: RedskilledResourceSample,
  after: RedskilledResourceSample,
): ResourceWindowEvidence {
  return {
    source: after.source,
    sampled_before: before.sampled_at,
    sampled_after: after.sampled_at,
    memory_current_before_bytes: before.memory.current_bytes,
    memory_current_after_bytes: after.memory.current_bytes,
    memory_peak_bytes: Math.max(before.memory.peak_bytes, after.memory.peak_bytes),
    memory_max_bytes: after.memory.max_bytes,
    cpu_usage_delta_usec: Math.max(0, after.cpu.usage_usec - before.cpu.usage_usec),
    cpu_throttled_delta_usec: Math.max(0, after.cpu.throttled_usec - before.cpu.throttled_usec),
    pids_peak: Math.max(before.pids.peak, after.pids.peak),
    memory_events_delta: counterDelta(after.memory.events, before.memory.events),
    pids_events_delta: counterDelta(after.pids.events, before.pids.events),
  };
}

function readSelfCgroupPath(): string | undefined {
  const raw = readOptional("/proc/self/cgroup");
  for (const line of raw?.split("\n") ?? []) {
    if (line.startsWith("0::")) return line.slice(3).trim();
  }
  return undefined;
}

type TargetState = {
  ring: RedskilledResourceSample[];
  consecutive: Map<ResourceIncidentTrigger, number>;
  active?: RedskilledResourceIncident;
  recoveryStartedAt?: number;
  postUntil?: number;
  previous?: RedskilledResourceSample;
};

export type IncidentIngestResult =
  | { kind: "buffered" }
  | { kind: "opened"; incident: RedskilledResourceIncident }
  | { kind: "active"; incident: RedskilledResourceIncident }
  | { kind: "recovering"; incident: RedskilledResourceIncident }
  | { kind: "finalized"; incident: RedskilledResourceIncident };

export type ResourceIncidentTrackerOptions = {
  preIncidentMs?: number;
  normalCadenceMs?: number;
  incidentCadenceMs?: number;
  recoveryMs?: number;
  postIncidentMs?: number;
  maxSamplesPerIncident?: number;
  idFactory?: (sample: RedskilledResourceSample) => string;
};

const counterIncreased = (current: Record<string, number> | undefined, previous: Record<string, number> | undefined, key: string): boolean =>
  (current?.[key] ?? 0) > (previous?.[key] ?? 0);

function pressureAvg10(sample: RedskilledResourceSample, resource: "cpu" | "memory", kind: "some" | "full"): number {
  return sample.pressure[resource]?.[kind]?.avg10 ?? 0;
}

function sampleTriggers(sample: RedskilledResourceSample, previous?: RedskilledResourceSample): Set<ResourceIncidentTrigger> {
  const found = new Set<ResourceIncidentTrigger>();
  if (sample.memory.max_bytes !== null && sample.memory.max_bytes > 0 && sample.memory.current_bytes / sample.memory.max_bytes >= 0.8) {
    found.add("memory-ratio");
  }
  if (sample.pids.max !== null && sample.pids.max > 0 && sample.pids.current / sample.pids.max >= 0.8) {
    found.add("pids-ratio");
  }
  if (counterIncreased(sample.memory.events, previous?.memory.events, "max")) found.add("memory-events-max");
  if (counterIncreased(sample.memory.events, previous?.memory.events, "oom")) found.add("memory-events-oom");
  if (counterIncreased(sample.memory.events, previous?.memory.events, "oom_kill")) found.add("memory-events-oom-kill");
  if (counterIncreased(sample.pids.events, previous?.pids.events, "max")) found.add("pids-events-max");
  if (pressureAvg10(sample, "memory", "full") >= 1) found.add("memory-pressure");
  if (pressureAvg10(sample, "cpu", "some") >= 25) found.add("cpu-pressure");
  if (sample.cpu.nr_periods > 0 && sample.cpu.nr_throttled / sample.cpu.nr_periods >= 0.2) found.add("cpu-throttling");
  return found;
}

const IMMEDIATE_TRIGGERS = new Set<ResourceIncidentTrigger>([
  "memory-events-max",
  "memory-events-oom",
  "memory-events-oom-kill",
  "pids-events-max",
]);

function belowRecoveryThreshold(sample: RedskilledResourceSample): boolean {
  const memoryOkay = sample.memory.max_bytes === null || sample.memory.max_bytes <= 0 || sample.memory.current_bytes / sample.memory.max_bytes <= 0.7;
  const pidsOkay = sample.pids.max === null || sample.pids.max <= 0 || sample.pids.current / sample.pids.max <= 0.7;
  const pressureOkay = pressureAvg10(sample, "memory", "full") < 0.5 && pressureAvg10(sample, "cpu", "some") < 15;
  const throttlingOkay = sample.cpu.nr_periods <= 0 || sample.cpu.nr_throttled / sample.cpu.nr_periods < 0.1;
  return memoryOkay && pidsOkay && pressureOkay && throttlingOkay;
}

/** Bounded in-memory state machine: 10 minute pre-ring, hysteresis, recovery and post tail. */
export class ResourceIncidentTracker {
  private readonly states = new Map<string, TargetState>();
  private readonly options: Required<ResourceIncidentTrackerOptions>;

  constructor(options: ResourceIncidentTrackerOptions = {}) {
    this.options = {
      preIncidentMs: options.preIncidentMs ?? 10 * 60_000,
      normalCadenceMs: options.normalCadenceMs ?? 15_000,
      incidentCadenceMs: options.incidentCadenceMs ?? 2_000,
      recoveryMs: options.recoveryMs ?? 2 * 60_000,
      postIncidentMs: options.postIncidentMs ?? 2 * 60_000,
      maxSamplesPerIncident: options.maxSamplesPerIncident ?? 4_096,
      idFactory: options.idFactory ?? ((sample) => `${sample.target.id}-${sample.sampled_at.replace(/[^0-9]/g, "")}`),
    };
  }

  ingest(sample: RedskilledResourceSample): IncidentIngestResult {
    const state: TargetState = this.states.get(sample.target.id) ?? {
      ring: [],
      consecutive: new Map<ResourceIncidentTrigger, number>(),
    };
    this.states.set(sample.target.id, state);
    const now = Date.parse(sample.sampled_at);
    const triggers = sampleTriggers(sample, state.previous);
    state.previous = sample;

    if (state.active === undefined) {
      state.ring.push(sample);
      // Keep one cadence of boundary slack: an incident requiring two samples
      // must not lose the first sample of its advertised pre-incident window.
      state.ring = state.ring.filter((row) => Date.parse(row.sampled_at) >= now - this.options.preIncidentMs - this.options.normalCadenceMs);
      for (const trigger of triggers) state.consecutive.set(trigger, (state.consecutive.get(trigger) ?? 0) + 1);
      for (const trigger of state.consecutive.keys()) if (!triggers.has(trigger)) state.consecutive.delete(trigger);
      const qualified = [...triggers].filter((trigger) => IMMEDIATE_TRIGGERS.has(trigger) || (state.consecutive.get(trigger) ?? 0) >= 2);
      if (qualified.length === 0) return { kind: "buffered" };
      state.active = {
        schema: RESOURCE_INCIDENT_SCHEMA,
        incident_id: this.options.idFactory(sample),
        target: sample.target,
        opened_at: sample.sampled_at,
        state: "active",
        triggers: qualified,
        samples: state.ring.slice(-this.options.maxSamplesPerIncident),
      };
      state.ring = [];
      state.consecutive.clear();
      return { kind: "opened", incident: state.active };
    }

    state.active.samples.push(sample);
    if (state.active.samples.length > this.options.maxSamplesPerIncident) state.active.samples.shift();
    for (const trigger of triggers) if (!state.active.triggers.includes(trigger)) state.active.triggers.push(trigger);

    if (!belowRecoveryThreshold(sample)) {
      state.recoveryStartedAt = undefined;
      state.postUntil = undefined;
      state.active.state = "active";
      return { kind: "active", incident: state.active };
    }
    state.recoveryStartedAt ??= now;
    if (state.postUntil === undefined && now - state.recoveryStartedAt >= this.options.recoveryMs) {
      state.postUntil = now + this.options.postIncidentMs;
      state.active.state = "recovering";
      return { kind: "recovering", incident: state.active };
    }
    if (state.postUntil !== undefined && now >= state.postUntil) {
      const completed: RedskilledResourceIncident = { ...state.active, closed_at: sample.sampled_at, state: "completed" };
      state.active = undefined;
      state.recoveryStartedAt = undefined;
      state.postUntil = undefined;
      state.ring = [sample];
      return { kind: "finalized", incident: completed };
    }
    state.active.state = "recovering";
    return { kind: "recovering", incident: state.active };
  }

  recommendedCadenceMs(targetId: string): number {
    return this.states.get(targetId)?.active === undefined ? this.options.normalCadenceMs : this.options.incidentCadenceMs;
  }

  activeIncidentCount(): number {
    return [...this.states.values()].filter((state) => state.active !== undefined).length;
  }

  hasActiveIncident(): boolean {
    return this.activeIncidentCount() > 0;
  }
}

export type ResourceIncidentSummary = Omit<RedskilledResourceIncident, "samples"> & { sample_count: number };

export type ResourceIncidentStoreOptions = {
  root: string;
  maxAgeMs?: number;
  maxIncidents?: number;
  maxHostBytes?: number;
  maxIncidentBytes?: number;
};

export interface ResourceIncidentStore {
  save(incident: RedskilledResourceIncident): Promise<ResourceIncidentSummary>;
  list(filter?: { workerId?: string; sinceMs?: number }): Promise<ResourceIncidentSummary[]>;
  read(incidentId: string): Promise<RedskilledResourceIncident | undefined>;
  enforceRetention(now?: number): Promise<void>;
}

const FORBIDDEN_FIELDS = new Set(["argv", "raw_argv", "env", "environment", "prompt", "stdin", "stdout", "stderr", "command"]);
const SAFE_INCIDENT_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function assertNoForbiddenFields(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value !== "object") return;
  if (seen.has(value)) return;
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key.toLowerCase())) throw new Error(`forbidden diagnostic field: ${key}`);
    assertNoForbiddenFields(child, seen);
  }
}

function toJsonValue(value: unknown): JsonValue {
  return value as JsonValue;
}

type ToonlSampleRow = Record<string, string | number | boolean | null>;

function toSampleRow(sample: RedskilledResourceSample): ToonlSampleRow {
  const row: ToonlSampleRow = {
    schema: sample.schema,
    sampled_at: sample.sampled_at,
    target_kind: sample.target.kind,
    target_id: sample.target.id,
    target_project_label: sample.target.project_label ?? null,
    source: sample.source,
    memory_current_bytes: sample.memory.current_bytes,
    memory_peak_bytes: sample.memory.peak_bytes,
    memory_max_bytes: sample.memory.max_bytes,
    memory_swap_current_bytes: sample.memory.swap_current_bytes ?? 0,
    memory_swap_peak_bytes: sample.memory.swap_peak_bytes ?? 0,
    memory_swap_max_bytes: sample.memory.swap_max_bytes ?? null,
    cpu_usage_usec: sample.cpu.usage_usec,
    cpu_user_usec: sample.cpu.user_usec,
    cpu_system_usec: sample.cpu.system_usec,
    cpu_nr_periods: sample.cpu.nr_periods,
    cpu_nr_throttled: sample.cpu.nr_throttled,
    cpu_throttled_usec: sample.cpu.throttled_usec,
    pids_current: sample.pids.current,
    pids_peak: sample.pids.peak,
    pids_max: sample.pids.max,
    processes: sample.processes ?? null,
  };
  for (const [key, value] of Object.entries(sample.memory.events ?? {})) row[`memory_event_${key}`] = value;
  for (const [key, value] of Object.entries(sample.memory.events_local ?? {})) row[`memory_event_local_${key}`] = value;
  for (const [key, value] of Object.entries(sample.pids.events ?? {})) row[`pids_event_${key}`] = value;
  for (const resource of ["cpu", "memory", "io"] as const) {
    for (const kind of ["some", "full"] as const) {
      const pressure = sample.pressure[resource]?.[kind];
      if (pressure === undefined) continue;
      row[`${resource}_${kind}_avg10`] = pressure.avg10;
      row[`${resource}_${kind}_avg60`] = pressure.avg60;
      row[`${resource}_${kind}_avg300`] = pressure.avg300;
      row[`${resource}_${kind}_total_usec`] = pressure.total_usec;
    }
  }
  return row;
}

function fromSampleRow(row: ToonlSampleRow): RedskilledResourceSample {
  const numeric = (key: string): number => typeof row[key] === "number" ? row[key] : 0;
  const nullableNumeric = (key: string): number | null => typeof row[key] === "number" ? row[key] : null;
  const keyed = (prefix: string, excludePrefix?: string): Record<string, number> => Object.fromEntries(
    Object.entries(row)
      .filter(([key, value]) => key.startsWith(prefix) && !key.startsWith(excludePrefix ?? "\0") && typeof value === "number")
      .map(([key, value]) => [key.slice(prefix.length), value as number]),
  );
  const pressure: RedskilledResourceSample["pressure"] = {};
  for (const resource of ["cpu", "memory", "io"] as const) {
    const resourceReading: Partial<Record<"some" | "full", PressureReading>> = {};
    for (const kind of ["some", "full"] as const) {
      if (typeof row[`${resource}_${kind}_avg10`] !== "number") continue;
      resourceReading[kind] = {
        avg10: numeric(`${resource}_${kind}_avg10`),
        avg60: numeric(`${resource}_${kind}_avg60`),
        avg300: numeric(`${resource}_${kind}_avg300`),
        total_usec: numeric(`${resource}_${kind}_total_usec`),
      };
    }
    if (Object.keys(resourceReading).length > 0) pressure[resource] = resourceReading;
  }
  const target: ResourceTarget = {
    kind: row.target_kind as ResourceTarget["kind"],
    id: String(row.target_id),
    ...(typeof row.target_project_label === "string" ? { project_label: row.target_project_label } : {}),
  };
  const processes = row.processes;
  return {
    schema: RESOURCE_SAMPLE_SCHEMA,
    sampled_at: String(row.sampled_at),
    target,
    source: row.source as RedskilledResourceSample["source"],
    memory: {
      current_bytes: numeric("memory_current_bytes"),
      peak_bytes: numeric("memory_peak_bytes"),
      max_bytes: nullableNumeric("memory_max_bytes"),
      swap_current_bytes: numeric("memory_swap_current_bytes"),
      swap_peak_bytes: numeric("memory_swap_peak_bytes"),
      swap_max_bytes: nullableNumeric("memory_swap_max_bytes"),
      events: keyed("memory_event_", "memory_event_local_"),
      events_local: keyed("memory_event_local_"),
    },
    cpu: {
      usage_usec: numeric("cpu_usage_usec"),
      user_usec: numeric("cpu_user_usec"),
      system_usec: numeric("cpu_system_usec"),
      nr_periods: numeric("cpu_nr_periods"),
      nr_throttled: numeric("cpu_nr_throttled"),
      throttled_usec: numeric("cpu_throttled_usec"),
    },
    pressure,
    pids: {
      current: numeric("pids_current"),
      peak: numeric("pids_peak"),
      max: nullableNumeric("pids_max"),
      events: keyed("pids_event_"),
    },
    ...(typeof processes === "number" ? { processes } : {}),
  };
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function dirBytes(path: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) total += await dirBytes(child);
    else if (entry.isFile()) total += (await stat(child)).size;
  }
  return total;
}

export function createResourceIncidentStore(options: ResourceIncidentStoreOptions): ResourceIncidentStore {
  const limits = {
    maxAgeMs: options.maxAgeMs ?? 7 * 24 * 60 * 60_000,
    maxIncidents: options.maxIncidents ?? 20,
    maxHostBytes: options.maxHostBytes ?? 256 * 1024 * 1024,
    maxIncidentBytes: options.maxIncidentBytes ?? 8 * 1024 * 1024,
  };

  async function summaries(): Promise<ResourceIncidentSummary[]> {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    const rows: ResourceIncidentSummary[] = [];
    for (const entry of await readdir(options.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SAFE_INCIDENT_ID.test(entry.name)) continue;
      try {
        const value = decode(await readFile(join(options.root, entry.name, "summary.toon"), "utf8"));
        if (value !== null && typeof value === "object") rows.push(value as unknown as ResourceIncidentSummary);
      } catch {
        // A partial or foreign directory is never interpreted as an incident.
      }
    }
    return rows.sort((left, right) => Date.parse(right.opened_at) - Date.parse(left.opened_at));
  }

  async function enforceRetention(now = Date.now()): Promise<void> {
    let rows = await summaries();
    const completed = rows.filter((row) => row.state === "completed");
    for (const row of completed) {
      const closed = Date.parse(row.closed_at ?? row.opened_at);
      if (Number.isFinite(closed) && now - closed > limits.maxAgeMs) await rm(join(options.root, row.incident_id), { recursive: true, force: true });
    }
    rows = await summaries();
    for (const row of rows.filter((row) => row.state === "completed").slice(limits.maxIncidents)) {
      await rm(join(options.root, row.incident_id), { recursive: true, force: true });
    }
    rows = await summaries();
    let total = await dirBytes(options.root);
    for (const row of [...rows].reverse()) {
      if (total <= limits.maxHostBytes) break;
      if (row.state !== "completed") continue;
      await rm(join(options.root, row.incident_id), { recursive: true, force: true });
      total = await dirBytes(options.root);
    }
  }

  return {
    async save(incident: RedskilledResourceIncident): Promise<ResourceIncidentSummary> {
      assertNoForbiddenFields(incident);
      if (!SAFE_INCIDENT_ID.test(incident.incident_id)) throw new Error("invalid resource incident id");
      await mkdir(options.root, { recursive: true, mode: 0o700 });
      await chmod(options.root, 0o700);
      const incidentDir = join(options.root, incident.incident_id);
      await mkdir(incidentDir, { recursive: true, mode: 0o700 });
      await chmod(incidentDir, 0o700);

      const summary: ResourceIncidentSummary = {
        schema: incident.schema,
        incident_id: incident.incident_id,
        target: incident.target,
        opened_at: incident.opened_at,
        ...(incident.closed_at === undefined ? {} : { closed_at: incident.closed_at }),
        state: incident.state,
        triggers: incident.triggers,
        sample_count: incident.samples.length,
      };
      let samples = [...incident.samples];
      let sampleText = "";
      while (samples.length > 0) {
        const writer = encodeToonlLines({ trailer: false });
        sampleText = samples.map((row) => writer.push(toSampleRow(row))).join("");
        if (Buffer.byteLength(sampleText) <= limits.maxIncidentBytes) break;
        samples.shift();
      }
      summary.sample_count = samples.length;
      await writePrivate(join(incidentDir, "summary.toon"), encode(toJsonValue(summary)));
      await writePrivate(join(incidentDir, "resource-samples.toonl"), sampleText);
      await enforceRetention();
      return summary;
    },

    async list(filter: { workerId?: string; sinceMs?: number } = {}): Promise<ResourceIncidentSummary[]> {
      const rows = await summaries();
      return rows.filter((row) =>
        (filter.workerId === undefined || row.target.id === filter.workerId) &&
        (filter.sinceMs === undefined || Date.parse(row.opened_at) >= filter.sinceMs));
    },

    async read(incidentId: string): Promise<RedskilledResourceIncident | undefined> {
      if (!SAFE_INCIDENT_ID.test(incidentId)) return undefined;
      try {
        const summary = decode(await readFile(join(options.root, incidentId, "summary.toon"), "utf8")) as unknown as ResourceIncidentSummary;
        const parsed = parseRecords(await readFile(join(options.root, incidentId, "resource-samples.toonl"), "utf8"));
        return {
          schema: summary.schema,
          incident_id: summary.incident_id,
          target: summary.target,
          opened_at: summary.opened_at,
          ...(summary.closed_at === undefined ? {} : { closed_at: summary.closed_at }),
          state: summary.state,
          triggers: summary.triggers,
          samples: (parsed as unknown as ToonlSampleRow[]).map(fromSampleRow),
        };
      } catch {
        return undefined;
      }
    },

    enforceRetention,
  };
}
