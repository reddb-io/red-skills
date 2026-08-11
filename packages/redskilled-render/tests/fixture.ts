/**
 * fixture — one payload, built by hand, so a render can be asserted with no host.
 *
 * **This file is the whole claim of ADR 0132 decision 1 made testable**: the
 * render holds no state and opens no transport, so a payload typed out here must
 * draw byte-identically to one a live daemon composed. If it ever does not, the
 * renderer reached for something that was not an argument.
 */
import {
  REDSKILLED_RENDER_COUNTER_NAMES,
  type RedskilledRenderCounter,
  type RedskilledRenderCounterName,
  type RedskilledRenderCounters,
  type RedskilledRenderPayload,
  type RedskilledRenderWorker,
  type RedskilledRenderWorkerDisplay,
} from "../payload.js";

/**
 * One dated remote-counter block, as the daemon composes it.
 *
 * Values are given per counter name; `null` is the daemon's absence (this poll
 * produced no such count) and is deliberately expressible, because the whole
 * reason the block carries `value: null` is that a zero would lie.
 */
export function counters(
  values: Partial<Record<RedskilledRenderCounterName, number | null>>,
  overrides: {
    readonly project_label?: string;
    readonly repository?: string;
    readonly ageMs?: number;
    readonly thresholdMs?: number;
    readonly fetchedAt?: string;
  } = {},
): RedskilledRenderCounters {
  const thresholdMs = overrides.thresholdMs ?? 120_000;
  const ageMs = overrides.ageMs ?? 5_000;
  const fetchedAt = overrides.fetchedAt ?? "2026-08-03T00:02:00.000Z";
  const build = (name: RedskilledRenderCounterName): RedskilledRenderCounter => {
    const value = values[name] ?? null;
    if (value == null) {
      return {
        name,
        value: null,
        fetched_at: null,
        age_ms: null,
        threshold_ms: thresholdMs,
        stale: false,
        reason: `this poll produced no ${name}, so it is absent rather than zero`,
      };
    }
    const stale = ageMs > thresholdMs;
    return {
      name,
      value,
      fetched_at: fetchedAt,
      age_ms: ageMs,
      threshold_ms: thresholdMs,
      stale,
      reason: stale
        ? `this ${name} is ${ageMs}ms old, past the ${thresholdMs}ms window`
        : `counted ${ageMs}ms ago, within the ${thresholdMs}ms window`,
    };
  };
  const built = {} as Record<RedskilledRenderCounterName, RedskilledRenderCounter>;
  for (const name of REDSKILLED_RENDER_COUNTER_NAMES) built[name] = build(name);
  return {
    version: 1,
    threshold_ms: thresholdMs,
    projects: [
      {
        project_label: overrides.project_label ?? "acme/widgets",
        repository: overrides.repository ?? "acme/widgets",
        outcome: "counted",
        counters: built,
      },
    ],
    reason: `every counter here was produced by the poll of ${fetchedAt}, ${ageMs}ms ago`,
  };
}

export function worker(overrides: Partial<RedskilledRenderWorker> = {}): RedskilledRenderWorker {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-08-03T00:00:00.000Z",
    uptime_ms: 125_000,
    vitals: {
      rss_bytes: 512 * 1024 * 1024,
      sampled_at: "2026-08-03T00:02:00.000Z",
      age_ms: 5_000,
      fresh: true,
      rss_source: "cgroup",
    },
    budget: {
      declared: "2G",
      bytes: 2 * 1024 * 1024 * 1024,
      used_bytes: 512 * 1024 * 1024,
      used_fraction: 0.25,
      enforceable: true,
    },
    log: { last_line: "coding: touched src/index.ts", published_at: "2026-08-03T00:02:00.000Z" },
    ...overrides,
  };
}

export function display(
  overrides: Partial<RedskilledRenderWorkerDisplay> = {},
): RedskilledRenderWorkerDisplay {
  return {
    runner: "claude",
    model: "opus",
    effort: "high",
    origin: "afk",
    issue: "3096",
    phase: "coding",
    step: "editing",
    phase_index: 2,
    phase_total: 5,
    failed: false,
    heartbeat: "3s",
    wait_kind: null,
    wait_subject: null,
    wait_pid: null,
    wait_started_at: null,
    wait_deadline: null,
    wait_escalation: null,
    started_at: "2026-08-03T00:00:00.000Z",
    phase_started_at: "2026-08-03T00:01:00.000Z",
    progress_at: "2026-08-03T00:01:30.000Z",
    context: 108_000,
    eta: 640,
    added: 120,
    removed: 8,
    tokens: 42_000,
    tools: 31,
    reasoning: 9,
    text: 4,
    ...overrides,
  };
}

export function payload(overrides: Partial<RedskilledRenderPayload> = {}): RedskilledRenderPayload {
  return {
    version: 1,
    generated_at: "2026-08-03T00:02:05.000Z",
    daemon: {
      pid: 111,
      daemon_version: "3.3.11",
      protocol_version: 1,
      started_at: "2026-08-02T22:00:00.000Z",
    },
    staleness: {
      sampled_at: "2026-08-03T00:02:00.000Z",
      age_ms: 5_000,
      threshold_ms: 30_000,
      stale: false,
      measured_worker_count: 1,
      unmeasured_workers: [],
      reason: "measured 5s ago",
    },
    host: {
      worker_count: 1,
      project_count: 1,
      ceiling: { memory_bytes: 8 * 1024 * 1024 * 1024, worker_count: 4 },
      consumption: { memory_bytes: 512 * 1024 * 1024 },
      observed_rss_bytes: 512 * 1024 * 1024,
      measured_worker_count: 1,
      ceiling_used_fraction: 0.0625,
    },
    projects: [
      {
        project_label: "acme/widgets",
        worker_count: 1,
        observed_rss_bytes: 512 * 1024 * 1024,
        measured_worker_count: 1,
      },
    ],
    workers: [worker()],
    known_projects: ["acme/widgets"],
    registered_projects: ["acme/widgets"],
    ...overrides,
  };
}
