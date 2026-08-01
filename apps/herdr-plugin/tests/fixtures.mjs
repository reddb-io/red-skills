/**
 * fixtures — one payload shaped exactly as `redskilled` sends it.
 *
 * Written against `apps/redskilled/src/statusline-payload.ts` and
 * `host-state.ts` in reddb-io/red-skills. It carries the awkward cases on
 * purpose: an unmeasured Worker, one without a unit, a repository the host token
 * cannot reach, and a project with a registration and no Worker.
 */

export function statuslinePayload(overrides = {}) {
  return {
    version: 1,
    generated_at: "2026-07-31T12:00:00.000Z",
    daemon: {
      pid: 4242,
      daemon_version: "0.4.1",
      protocol_version: 1,
      started_at: "2026-07-31T09:00:00.000Z",
      machine_id_hash: "b3f2a19c0d55",
      session_key_hash: "9c0d41ba7e12",
    },
    staleness: {
      sampled_at: "2026-07-31T11:59:55.000Z",
      age_ms: 5_000,
      threshold_ms: 30_000,
      stale: false,
      measured_worker_count: 1,
      unmeasured_workers: ["w-idle"],
      reason: "measured 5000ms ago, within the 30000ms staleness window",
    },
    host: {
      worker_count: 2,
      project_count: 2,
      ceiling: { memory_bytes: 8 * 1024 ** 3, worker_count: 6, source: "host-fraction" },
      consumption: { worker_count: 2, memory_bytes: 3 * 1024 ** 3, unaccounted_workers: [] },
      budget_accounting: {
        version: 1,
        worker_count: 2,
        memory_high_bytes: 2 * 1024 ** 3,
        memory_max_bytes: 3 * 1024 ** 3,
        cpu_weight_total: 200,
        unaccounted_workers: [],
        unisolated_workers: ["w-idle"],
      },
      observed_rss_bytes: 900 * 1024 ** 2,
      measured_worker_count: 1,
      ceiling_used_fraction: 0.375,
    },
    projects: [
      {
        project_label: "reddb-io/red-skills",
        worker_count: 1,
        declared_memory_bytes: 2 * 1024 ** 3,
        observed_rss_bytes: 900 * 1024 ** 2,
        measured_worker_count: 1,
      },
      {
        project_label: "reddb-io/red-dev",
        worker_count: 1,
        declared_memory_bytes: 1024 ** 3,
        observed_rss_bytes: 0,
        measured_worker_count: 0,
      },
    ],
    known_projects: ["reddb-io/red-dev", "reddb-io/red-skills", "reddb-io/quiet"],
    workers: [
      {
        worker_id: "w-2f91a",
        project_label: "reddb-io/red-skills",
        workspace_path: "/home/op/red-skills/.red/tmp/workers/w-2f91a/2931",
        log_path: "/home/op/red-skills/.red/tmp/logs/2026-07-31/w-2f91a.log",
        pid: 51_201,
        started_at: "2026-07-31T11:42:00.000Z",
        uptime_ms: 1_080_000,
        state: "running",
        isolated: true,
        unit: "redskilled-w-2f91a.service",
        warnings: [],
        vitals: { rss_bytes: 900 * 1024 ** 2, sampled_at: "2026-07-31T11:59:55.000Z", age_ms: 5_000, fresh: true },
        budget: {
          name: "MemoryMax",
          declared: "2G",
          bytes: 2 * 1024 ** 3,
          used_bytes: 900 * 1024 ** 2,
          used_fraction: 0.44,
          enforceable: true,
        },
        log: { last_line: "gate: vitest packages/red-castle …", published_at: "2026-07-31T11:59:50.000Z", source: "heartbeat" },
      },
      {
        worker_id: "w-idle",
        project_label: "reddb-io/red-dev",
        workspace_path: "/home/op/red-dev/.red/tmp/workers/w-idle/88",
        pid: 51_444,
        started_at: "2026-07-31T11:58:00.000Z",
        uptime_ms: 120_000,
        state: "reattached",
        isolated: false,
        unit: null,
        warnings: ["this host afforded no transient unit; the Worker's charge lands on the daemon"],
        vitals: { rss_bytes: null, sampled_at: null, age_ms: null, fresh: false },
        budget: { name: null, declared: "1G", bytes: null, used_bytes: null, used_fraction: null, enforceable: false },
        log: { last_line: null, published_at: null, source: null },
      },
    ],
    repository_activity: {
      version: 1,
      fetched_at: "2026-07-31T11:59:30.000Z",
      age_ms: 30_000,
      threshold_ms: 120_000,
      stale: false,
      request_count: 1,
      rate_limit: { remaining: 4_832, reset_at: "2026-07-31T13:02:00.000Z", exhausted: false },
      projects: [
        {
          project_label: "reddb-io/red-skills",
          repository: "reddb-io/red-skills",
          outcome: "counted",
          counts: { open_pull_requests: 12, open_issues: 48, recently_closed: 31 },
          detail: "counted reddb-io/red-skills",
          fetched_at: "2026-07-31T11:59:30.000Z",
          age_ms: 30_000,
          stale: false,
        },
        {
          project_label: "reddb-io/red-dev",
          repository: "reddb-io/red-dev",
          outcome: "unreachable",
          counts: null,
          detail: "reddb-io/red-dev is not reachable with the host token",
          fetched_at: "2026-07-31T11:59:30.000Z",
          age_ms: 30_000,
          stale: false,
        },
      ],
      reason: "fetched 30000ms ago, within the 120000ms window",
    },
    ...overrides,
  };
}

export function hostState(overrides = {}) {
  return {
    version: 1,
    protocol_version: 1,
    daemon_version: "0.4.1",
    machine_id_hash: "b3f2a19c0d55",
    session_key_hash: "9c0d41ba7e12",
    pid: 4242,
    started_at: "2026-07-31T09:00:00.000Z",
    scope: { kind: "machine", owner_uid: 1000 },
    workers: [],
    projects: [],
    registrations: [
      {
        version: 1,
        project_label: "reddb-io/red-skills",
        selector: "label:ready-for-agent",
        argv: ["red", "__worker"],
        target: 3,
        registered_at: "2026-07-31T09:05:00.000Z",
        renew_within_ms: 300_000,
        renew_by: "2026-07-31T12:05:00.000Z",
        renewed_at: "2026-07-31T11:59:00.000Z",
        renewals: 34,
        renewal: "renewing",
      },
    ],
    budget_accounting: {
      version: 1,
      worker_count: 2,
      memory_high_bytes: 2 * 1024 ** 3,
      memory_max_bytes: 3 * 1024 ** 3,
      cpu_weight_total: 200,
      unaccounted_workers: [],
      unisolated_workers: ["w-idle"],
    },
    upgrade: {
      running_version: "0.4.1",
      published_version: "0.4.1",
      published_unknown: 0,
      newer_published: 0,
      replacement: "none",
      checked_at: "2026-07-31T11:50:00.000Z",
      newest_published_version: "0.4.1",
      major_held: 0,
      major_hold: null,
    },
    ...overrides,
  };
}

export function snapshot(overrides = {}) {
  return {
    reachable: true,
    payload: statuslinePayload(),
    hostState: hostState(),
    error: null,
    read_at: "2026-07-31T12:00:00.000Z",
    ...overrides,
  };
}
