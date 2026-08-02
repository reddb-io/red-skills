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
    // A death this host could not explain, posed by the boot reaper and reduced
    // to what a surface prints. It carries the awkward part on purpose: the
    // verdict names a Worker no longer in the Worker set, which is exactly the
    // reader that has no table to be found in.
    deaths: {
      count: 2,
      recent: [
        {
          kind: "worker",
          id: "worker:w-gone",
          pid: 5150,
          ts: "2026-07-31T09:02:00.000Z",
          last_seen: "2026-07-31T08:58:00.000Z",
          last_phase: "coding",
          sender_class: "oomd",
          confidence: "high",
          signal: "SIGKILL",
          evidence: "systemd-oomd killed red-worker-red-skills-w-gone.service",
        },
        {
          kind: "launcher",
          id: "launcher:1701",
          pid: 1701,
          ts: "2026-07-31T09:01:00.000Z",
          last_seen: "2026-07-31T08:50:00.000Z",
          last_phase: "booting",
          sender_class: "unknown",
          confidence: "none",
          signal: null,
          evidence: null,
        },
      ],
      latest: {
        kind: "worker",
        id: "worker:w-gone",
        pid: 5150,
        ts: "2026-07-31T09:02:00.000Z",
        last_seen: "2026-07-31T08:58:00.000Z",
        last_phase: "coding",
        sender_class: "oomd",
        confidence: "high",
        signal: "SIGKILL",
        evidence: "systemd-oomd killed red-worker-red-skills-w-gone.service",
      },
      reaped_at: "2026-07-31T09:02:00.000Z",
    },
    engine: {
      running_version: "0.4.1",
      published_version: "0.4.1",
      newer_published: false,
      major_held: false,
      current: true,
    },
    metrics: metrics(),
    ...overrides,
  };
}

/**
 * The rates the daemon derived, as `deriveRedskilledLiveMetrics` shapes them.
 *
 * The SAME canned block the VSCode suite is handed
 * (`apps/vscode-extension-red-skills/tests/fixtures.ts`), so the two surfaces are
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
export function metrics(overrides = {}) {
  return {
    generated_at: "2026-07-31T12:00:00.000Z",
    hour: {
      window: "hour",
      window_ms: 3_600_000,
      from: "2026-07-31T11:00:00.000Z",
      to: "2026-07-31T12:00:00.000Z",
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
      from: "2026-07-30T12:00:00.000Z",
      to: "2026-07-31T12:00:00.000Z",
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

/**
 * A dashboard shaped exactly as `statusline-dashboard` sends it.
 *
 * Written against `apps/redskilled/src/dashboard-render.ts`. Every cell here is
 * already finished — which is the point: a surface test that had to compute a
 * cell to assert it would be testing the very re-derivation this document
 * exists to remove.
 */
export function dashboard(overrides = {}) {
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
    stale: false,
    age_ms: 5_000,
    line: "» reddb-io/red-skills v0.4.1 · claude·opus·high · wrk=2/2 · slots=2/6 · mem=3G/8G 38% · prs=3 · cpr=7 · iss=24",
  };
  const rows = [
    {
      worker_id: "w-busy",
      project_label: "reddb-io/red-skills",
      mine: true,
      cells: {
        wid: "w-busy",
        run: "run=claude opus high",
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
      line: "w-busy  run=claude opus high  org=afk  iss=3012  ██▶░░░  coding·impl  1h0m  hb=3s  loc=+142 -36  tks=45k  tls=12  rsn=4  txt=9",
    },
    {
      worker_id: "w-idle",
      project_label: "acme/widgets",
      mine: false,
      cells: {
        wid: "w-idle",
        run: "",
        org: "",
        iss: "",
        bar: "",
        phase: "",
        elapsed: "12m0s",
        hb: "hb=?",
        loc: "",
        tks: "",
        tls: "",
        rsn: "",
        txt: "",
      },
      line: "w-idle                                        12m0s  hb=?",
    },
  ];
  return {
    version: 1,
    generated_at: "2026-07-31T12:00:00.000Z",
    mode: "global",
    project: "reddb-io/red-skills",
    columns: ["wid", "run", "org", "iss", "bar", "phase", "elapsed", "hb", "loc", "tks", "tls", "rsn", "txt"],
    header,
    rows,
    lines: [header.line, ...rows.map((row) => row.line)],
    hidden_row_count: 0,
    stale: false,
    ...overrides,
  };
}
