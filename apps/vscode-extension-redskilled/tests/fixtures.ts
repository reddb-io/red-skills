/**
 * fixtures — canned host documents, shaped exactly like the daemon's.
 *
 * Built from the real types in `@reddb-io/redskilled`, so a field the daemon
 * renames stops compiling here instead of quietly making every assertion in the
 * suite test a shape that no longer exists.
 */
import type {
  RedskilledDashboard,
  RedskilledHostState,
  RedskilledStatuslineMetrics,
  RedskilledStatuslinePayload,
} from "@reddb-io/redskilled/protocol";
import type {
  RedskilledStatuslineWorker,
} from "@reddb-io/redskilled/statusline-payload";

export const FIXED_NOW = "2026-08-01T10:00:00.000Z";

export interface WorkerOverrides {
  readonly worker_id?: string;
  readonly project_label?: string;
  readonly rss_bytes?: number | null;
  readonly used_fraction?: number | null;
  readonly isolated?: boolean;
  readonly log_path?: string | null;
  readonly last_line?: string | null;
  readonly warnings?: readonly string[];
  readonly fresh?: boolean;
}

export function worker(overrides: WorkerOverrides = {}): RedskilledStatuslineWorker {
  const id = overrides.worker_id ?? "wA1B2";
  const isolated = overrides.isolated ?? true;
  const logPath = overrides.log_path === undefined ? `/tmp/${id}.log` : overrides.log_path;
  return {
    worker_id: id,
    project_label: overrides.project_label ?? "reddb-io/red-skills",
    workspace_path: `/workspaces/red-skills/.red/tmp/workers/${id}/2998`,
    pid: 4242,
    started_at: "2026-08-01T09:30:00.000Z",
    uptime_ms: 1_800_000,
    state: "running",
    isolated,
    unit: isolated ? `redskilled-${id}.service` : null,
    warnings: overrides.warnings ?? (isolated ? [] : ["this host afforded no transient unit"]),
    vitals: {
      rss_bytes: overrides.rss_bytes === undefined ? 512 * 1024 ** 2 : overrides.rss_bytes,
      sampled_at: FIXED_NOW,
      age_ms: 0,
      fresh: overrides.fresh ?? true,
    },
    budget: {
      name: "MemoryMax",
      declared: "2G",
      bytes: 2 * 1024 ** 3,
      used_bytes: overrides.rss_bytes === undefined ? 512 * 1024 ** 2 : overrides.rss_bytes,
      used_fraction: overrides.used_fraction === undefined ? 0.25 : overrides.used_fraction,
      enforceable: true,
    },
    log: {
      last_line: overrides.last_line ?? null,
      published_at: overrides.last_line ? FIXED_NOW : null,
      source: overrides.last_line ? "heartbeat" : null,
    },
    // `log_path` is not in the payload's Worker type on every daemon version, so
    // it is attached the way a real daemon serves it: present on the wire, read
    // defensively by the consumer.
    ...(logPath === null ? {} : { log_path: logPath }),
  } as RedskilledStatuslineWorker;
}

export interface PayloadOverrides {
  readonly workers?: readonly RedskilledStatuslineWorker[];
  readonly pid?: number;
  readonly stale?: boolean;
  readonly openPullRequests?: number | null;
  readonly generated_at?: string;
}

export function statuslinePayload(overrides: PayloadOverrides = {}): RedskilledStatuslinePayload {
  const workers = overrides.workers ?? [worker()];
  const declared = workers.reduce((total, entry) => total + (entry.budget.bytes ?? 0), 0);
  const observed = workers.reduce((total, entry) => total + (entry.vitals.rss_bytes ?? 0), 0);
  const open = overrides.openPullRequests === undefined ? 12 : overrides.openPullRequests;

  return {
    version: 1,
    generated_at: overrides.generated_at ?? FIXED_NOW,
    daemon: {
      pid: overrides.pid ?? 9001,
      daemon_version: "0.4.1",
      protocol_version: 1,
      started_at: "2026-08-01T08:00:00.000Z",
      machine_id_hash: "aaaaaaaaaaaa",
      session_key_hash: "bbbbbbbbbbbb",
    },
    staleness: {
      sampled_at: FIXED_NOW,
      age_ms: 0,
      threshold_ms: 30_000,
      stale: overrides.stale ?? false,
      measured_worker_count: workers.length,
      unmeasured_workers: [],
      reason: overrides.stale ? "the sampler has not measured inside its window" : "measured just now",
    },
    host: {
      worker_count: workers.length,
      project_count: new Set(workers.map((entry) => entry.project_label)).size,
      ceiling: {
        worker_count: 4,
        memory_bytes: 8 * 1024 ** 3,
        source: "declared",
      },
      consumption: { worker_count: workers.length, memory_bytes: declared, unaccounted_workers: [] },
      budget_accounting: {
        version: 1,
        worker_count: workers.length,
        memory_high_bytes: declared,
        memory_max_bytes: declared,
        cpu_weight_total: 100 * workers.length,
        unaccounted_workers: [],
        unisolated_workers: workers.filter((entry) => !entry.isolated).map((entry) => entry.worker_id),
      },
      observed_rss_bytes: observed,
      measured_worker_count: workers.length,
      ceiling_used_fraction: declared / (8 * 1024 ** 3),
    },
    projects: [...new Set(workers.map((entry) => entry.project_label))].sort().map((label) => ({
      project_label: label,
      worker_count: workers.filter((entry) => entry.project_label === label).length,
      declared_memory_bytes: declared,
      observed_rss_bytes: observed,
      measured_worker_count: workers.filter((entry) => entry.project_label === label).length,
    })),
    workers,
    // The token's balance, as the daemon last asked for it (ADR 0132 Amendment
    // 2). `open` here means the budget is nowhere near the reserved band, which
    // is the state every existing fixture assertion was written under.
    github_balance: {
      version: 1,
      origin: "asked",
      outcome: "asked",
      asked_at: FIXED_NOW,
      age_ms: 0,
      threshold_ms: 1_200_000,
      stale: false,
      posture: "open",
      reserved_fraction: 0.15,
      next_poll_ms: 600_000,
      pools: [
        { pool: "rest", resource: "core", limit: 5_000, remaining: 4_900, used: 100, reset_at: FIXED_NOW, fraction: 0.98 },
      ],
      unreported_pools: [],
      reason: "the rest pool is the tightest at 4900 of 5000, above the reserved band of 750",
    },
    repository_activity: {
      version: 1,
      fetched_at: FIXED_NOW,
      age_ms: 0,
      threshold_ms: 300_000,
      stale: false,
      request_count: 1,
      reason: "counted in one request",
      // `point_cost` is what GitHub charged this one aliased query in node
      // points: flat in requests, never flat in points (#3095).
      rate_limit: { remaining: 4_900, reset_at: null, limit: 5_000, exhausted: false, point_cost: 3 },
      projects: [
        open === null
          ? {
            project_label: "reddb-io/red-skills",
            repository: "reddb-io/red-skills",
            outcome: "unreachable",
            counts: null,
            detail: "the tracker did not answer",
            fetched_at: FIXED_NOW,
            age_ms: 0,
            stale: false,
          }
          : {
            project_label: "reddb-io/red-skills",
            repository: "reddb-io/red-skills",
            outcome: "counted",
            counts: { open_pull_requests: open, open_issues: 37, recently_closed: 4 },
            detail: "counted in one request",
            fetched_at: FIXED_NOW,
            age_ms: 0,
            stale: false,
          },
      ],
    },
    // What this host could not explain, posed by the boot reaper and reduced to
    // what a surface prints (#3028 → #3032). The verdict names a process that is
    // in no Worker row, which is the whole reason it has to ride on the header.
    deaths: {
      count: 1,
      // The canned verdict names systemd-oomd, so it is sender-attributed and
      // rides the head. The two counts coincide here on purpose: this fixture
      // proves the surface prints an ATTRIBUTED death, and a fixture whose only
      // death were un-narrated would prove the head prints nothing.
      sender_attributed_count: 1,
      recent: [CANNED_DEATH],
      latest: CANNED_DEATH,
      latest_sender_attributed: CANNED_DEATH,
      reaped_at: CANNED_DEATH.ts,
    },
    engine: {
      running_version: "0.4.1",
      published_version: "0.4.1",
      newer_published: false,
      major_held: false,
      current: true,
    },
    metrics: metrics(),
  } as RedskilledStatuslinePayload;
}

/**
 * The rates the daemon derived, as `deriveRedskilledLiveMetrics` shapes them.
 *
 * The SAME canned block the herdr suite is handed
 * (`apps/herdr-plugin-redskilled/tests/fixtures.mjs`), so the two surfaces are
 * proved against one aggregate rather than two hand-tuned ones that could drift
 * apart and each look right.
 *
 * It carries the awkward cases on purpose, and they are the ones a real host
 * produces: the last hour finished no issue, so `issues_per_hour` is ABSENT
 * rather than zero; the Workers running in that hour published no model, so the
 * hour's model share is absent while the day's — which sees the Workers that ran
 * earlier — is not; and both dimensions count their unattributed Workers instead
 * of dropping them.
 */
export function metrics(overrides: Partial<RedskilledStatuslineMetrics> = {}): RedskilledStatuslineMetrics {
  return {
    generated_at: FIXED_NOW,
    hour: {
      window: "hour",
      window_ms: 3_600_000,
      from: "2026-08-01T09:00:00.000Z",
      to: FIXED_NOW,
      tokens_per_min: { value: 1240, absent_reason: null, samples: 18 },
      tools_per_min: { value: 8.4, absent_reason: null, samples: 18 },
      issues_per_hour: { value: null, absent_reason: "no Worker outcome was recorded in the last 1h", samples: 0 },
      runner_share: {
        dimension: "runner",
        attributed_workers: 3,
        unattributed_workers: 0,
        shares: [
          { key: "claude", worker_count: 2, share: 2 / 3 },
          { key: "codex", worker_count: 1, share: 1 / 3 },
        ],
        absent_reason: null,
      },
      model_share: {
        dimension: "model",
        attributed_workers: 0,
        unattributed_workers: 3,
        shares: [],
        absent_reason: "no Worker published a model in the last 1h",
      },
      unavailable: ["worker-outcomes"],
    },
    day: {
      window: "day",
      window_ms: 86_400_000,
      from: "2026-07-31T10:00:00.000Z",
      to: FIXED_NOW,
      tokens_per_min: { value: 820, absent_reason: null, samples: 214 },
      tools_per_min: { value: 5.1, absent_reason: null, samples: 214 },
      issues_per_hour: { value: 4 / 24, absent_reason: null, samples: 4 },
      runner_share: {
        dimension: "runner",
        attributed_workers: 5,
        unattributed_workers: 0,
        shares: [
          { key: "claude", worker_count: 3, share: 0.6 },
          { key: "codex", worker_count: 2, share: 0.4 },
        ],
        absent_reason: null,
      },
      model_share: {
        dimension: "model",
        attributed_workers: 2,
        unattributed_workers: 3,
        shares: [
          { key: "opus", worker_count: 1, share: 0.5 },
          { key: "sonnet", worker_count: 1, share: 0.5 },
        ],
        absent_reason: null,
      },
      unavailable: [],
    },
    ...overrides,
  };
}

/** The one posed death every surface in this suite is handed. */
export const CANNED_DEATH = {
  kind: "worker",
  id: "worker:w-gone",
  pid: 5150,
  ts: "2026-08-01T09:02:00.000Z",
  last_seen: "2026-08-01T08:58:00.000Z",
  last_phase: "coding",
  sender_class: "oomd",
  confidence: "high",
  signal: "SIGKILL",
  evidence: "systemd-oomd killed red-worker-red-skills-w-gone.service",
} as const;

export interface HostStateOverrides {
  readonly pid?: number;
  readonly newerPublished?: number;
  readonly majorHeld?: number;
  readonly publishedVersion?: string | null;
}

export function hostState(overrides: HostStateOverrides = {}): RedskilledHostState {
  return {
    version: 1,
    protocol_version: 1,
    daemon_version: "0.4.1",
    machine_id_hash: "aaaaaaaaaaaa",
    session_key_hash: "bbbbbbbbbbbb",
    pid: overrides.pid ?? 9001,
    started_at: "2026-08-01T08:00:00.000Z",
    workers: [],
    projects: [],
    budget_accounting: {
      version: 1,
      worker_count: 0,
      memory_high_bytes: 0,
      memory_max_bytes: 0,
      cpu_weight_total: 0,
      unaccounted_workers: [],
      unisolated_workers: [],
    },
    upgrade: {
      running_version: "0.4.1",
      published_version: overrides.publishedVersion === undefined ? "0.4.1" : overrides.publishedVersion,
      published_unknown: 0,
      newer_published: overrides.newerPublished ?? 0,
      replacement: "none",
      checked_at: FIXED_NOW,
      checks: 3,
      hold_reason: null,
      newest_published_version: "0.4.1",
      major_held: overrides.majorHeld ?? 0,
      major_hold: null,
    },
  } as RedskilledHostState;
}

/**
 * A dashboard shaped exactly as `statusline-dashboard` sends it.
 *
 * Every cell here is already finished — which is the point: a surface test that
 * had to compute a cell to assert it would be testing the very re-derivation
 * this document exists to remove.
 */
export function dashboard(overrides: Record<string, unknown> = {}): RedskilledDashboard {
  const header = {
    repo: "reddb-io/red-skills",
    project: "reddb-io/red-skills",
    project_match: "matched",
    version: "0.4.1",
    model: "claude·opus·high",
    windows: {
      memory_used_fraction: 0.375,
      memory_used_bytes: 3 * 1024 ** 3,
      memory_ceiling_bytes: 8 * 1024 ** 3,
      worker_count: 2,
      worker_ceiling: 6,
    },
    counts: { open_pull_requests: 3, recently_closed: 7, open_issues: 24, stale: false },
    engine: {
      running_version: "0.4.1",
      published_version: "0.4.1",
      newer_published: false,
      major_held: false,
      current: true,
    },
    deaths: { count: 1, recent: [CANNED_DEATH], latest: CANNED_DEATH, reaped_at: CANNED_DEATH.ts },
    // The whole block travels beside the line even though only the hour's rates
    // fit inside it — and `iss/h` is missing from the line rather than zero,
    // because the canned hour finished no issue.
    metrics: metrics(),
    stale: false,
    age_ms: 5_000,
    line:
      "» reddb-io/red-skills v0.4.1 · claude·opus·high · wrk=1/1 · slots=1/6 · mem=3G/8G 38% · prs=3 · cpr=7 · iss=24 · tk/m=1.2k tl/m=8.4 claude=67% · †1 oomd",
  };
  const deathLine =
    "† worker worker:w-gone pid=5150 oomd/high phase=coding signal=SIGKILL — systemd-oomd killed red-worker-red-skills-w-gone.service";
  const rows = [
    {
      worker_id: "wA1B2",
      project_label: "reddb-io/red-skills",
      mine: true,
      cells: {
        wid: "wA1B2",
        run: "run=claude opus-4.8 high",
        org: "org=afk",
        iss: "iss=3012",
        bar: "██▶░░░",
        phase: "coding·impl",
        elapsed: "1h0m",
        hb: "hb=3s",
        loc: "loc=+142 -36",
        tks: "tks=45k",
        tls: "tls=12",
        rsn: "rsn=4",
        txt: "txt=9",
      },
      line: "wA1B2  run=claude opus-4.8 high  org=afk  iss=3012  ██▶░░░  coding·impl  1h0m  hb=3s  loc=+142 -36  tks=45k  tls=12  rsn=4  txt=9",
    },
  ];
  return {
    version: 1,
    generated_at: FIXED_NOW,
    mode: "local",
    project: "reddb-io/red-skills",
    columns: ["wid", "run", "org", "iss", "bar", "phase", "elapsed", "hb", "loc", "tks", "tls", "rsn", "txt"],
    header,
    rows,
    lines: [header.line, ...rows.map((row) => row.line), deathLine],
    hidden_row_count: 0,
    stale: false,
    ...overrides,
  } as unknown as RedskilledDashboard;
}
