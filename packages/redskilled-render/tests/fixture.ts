/**
 * fixture — one payload, built by hand, so a render can be asserted with no host.
 *
 * **This file is the whole claim of ADR 0132 decision 1 made testable**: the
 * render holds no state and opens no transport, so a payload typed out here must
 * draw byte-identically to one a live daemon composed. If it ever does not, the
 * renderer reached for something that was not an argument.
 */
import type {
  RedskilledRenderPayload,
  RedskilledRenderWorker,
  RedskilledRenderWorkerDisplay,
} from "../payload.js";

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
    step: "edit",
    phase_index: 2,
    phase_total: 5,
    failed: false,
    heartbeat: "3s",
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
