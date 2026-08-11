// One payload answers "what is this machine doing", and every fact in it comes
// from the daemon. Reach is asymmetric: a session reads the whole host and
// writes only its own project. Staleness travels inside the payload.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  readRedskilledStatuslinePayload,
  commandRedskilledWorker,
  startRedskilledWorker,
} from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { readRedskilledEvents } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import type {
  RedskilledActivityCounts,
  RedskilledActivityOutcome,
  RedskilledRepositoryActivity,
} from "../src/repository-activity.js";
import { REDSKILLED_REMOTE_COUNTER_NAMES } from "../src/remote-counters.js";
import {
  buildStatuslinePayload,
  isRedskilledStatuslinePayload,
  REDSKILLED_STALENESS_MS,
} from "../src/statusline-payload.js";
import {
  renderRedskilledStatusline,
  stripAnsi,
  REDSKILLED_STATUSLINE_DEFAULTS,
  type RedskilledRenderPayload,
} from "@reddb-io/redskilled-render";
import { deriveRedskilledLiveMetrics } from "../src/live-metrics.js";
import { evaluateSessionReach, REDSKILLED_OP_REACH } from "../src/session-reach.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-statusline-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

function worker(overrides: Partial<RedskilledWorkerView> = {}): RedskilledWorkerView {
  return {
    worker_id: "w-1",
    project_label: "acme/widgets",
    pid: 4242,
    started_at: "2026-07-29T00:00:00.000Z",
    workspace_path: "/tmp/acme/w-1",
    isolated: true,
    unit: "red-worker-acme-widgets-w-1.service",
    budget: { memory_max: "1G" },
    warnings: [],
    ...overrides,
  };
}

/** A daemon holding two projects' Workers, with the sampler unarmed. */
async function twoProjectDaemon(): Promise<{ daemon: RedskilledDaemon; paths: RedskilledPaths }> {
  const paths = await sessionPaths();
  const daemon = await startRedskilledDaemon({
    paths,
    idleMs: 60_000,
    sampleMs: 0,
    ceiling: UNBOUNDED_HOST_CEILING,
    stopWorker: () => true,
    treeSampler: () => ({ rss: { "w-1": 512 * 1024 * 1024, "w-2": 128 * 1024 * 1024 }, cpu_seconds: {} }),
  });
  running.push(daemon);
  daemon.trackWorker(worker());
  daemon.trackWorker(worker({
    worker_id: "w-2",
    project_label: "acme/gadgets",
    pid: 4343,
    workspace_path: "/tmp/acme/w-2",
    unit: "red-worker-acme-gadgets-w-2.service",
    budget: { memory_max: "512M" },
  }));
  return { daemon, paths };
}

describe("the statusline payload", () => {
  it("reports every project's Workers with their owning project, from one read", async () => {
    const { paths } = await twoProjectDaemon();
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });

    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    expect(payload.workers.map((w) => [w.worker_id, w.project_label])).toEqual([
      ["w-1", "acme/widgets"],
      ["w-2", "acme/gadgets"],
    ]);
    expect(payload.projects.map((p) => p.project_label)).toEqual(["acme/gadgets", "acme/widgets"]);
    expect(payload.host.worker_count).toBe(2);
    expect(payload.host.project_count).toBe(2);
  });

  it("carries each Worker's state, vitals and budget consumption", async () => {
    const { daemon, paths } = await twoProjectDaemon();
    await daemon.sampleMemoryBudgets();
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });

    const first = payload.workers.find((w) => w.worker_id === "w-1")!;
    expect(first.state).toBe("running");
    expect(first.vitals.rss_bytes).toBe(512 * 1024 * 1024);
    expect(first.vitals.fresh).toBe(true);
    expect(first.budget.name).toBe("MemoryMax");
    expect(first.budget.declared).toBe("1G");
    expect(first.budget.used_bytes).toBe(512 * 1024 * 1024);
    expect(first.budget.used_fraction).toBeCloseTo(0.5, 6);
    expect(payload.host.observed_rss_bytes).toBe(640 * 1024 * 1024);
  });

  it("carries staleness inside the payload rather than leaving it to be re-derived", () => {
    const workers = [worker()];
    const fresh = buildStatuslinePayload({
      hostState: hostStateOf(workers),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: { "w-1": 128 },
      sampledAt: "2026-07-29T12:00:00.000Z",
      now: "2026-07-29T12:00:05.000Z",
    });
    expect(fresh.staleness.age_ms).toBe(5_000);
    expect(fresh.staleness.stale).toBe(false);
    expect(fresh.staleness.threshold_ms).toBe(REDSKILLED_STALENESS_MS);

    const old = buildStatuslinePayload({
      hostState: hostStateOf(workers),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: { "w-1": 128 },
      sampledAt: "2026-07-29T12:00:00.000Z",
      now: "2026-07-29T12:10:00.000Z",
    });
    expect(old.staleness.stale).toBe(true);
    expect(old.workers[0]!.vitals.fresh).toBe(false);
    expect(old.staleness.reason).toContain("stale");

    const never = buildStatuslinePayload({
      hostState: hostStateOf(workers),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now: "2026-07-29T12:00:00.000Z",
    });
    expect(never.staleness.stale).toBe(true);
    expect(never.staleness.sampled_at).toBeNull();
    expect(never.staleness.unmeasured_workers).toEqual(["w-1"]);
    expect(never.workers[0]!.vitals.rss_bytes).toBeNull();
    expect(never.workers[0]!.budget.used_fraction).toBeNull();
  });

  it("is total when the host holds nothing at all", () => {
    const payload = buildStatuslinePayload({
      hostState: hostStateOf([]),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now: "2026-07-29T12:00:00.000Z",
    });
    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    expect(payload.workers).toEqual([]);
    expect(payload.projects).toEqual([]);
    expect(payload.staleness.stale).toBe(false);
    expect(payload.host.observed_rss_bytes).toBe(0);
  });

  it("carries each absent registration history without collapsing it", () => {
    const historical = {
      ...hostStateOf([]),
      lapsed_registrations: [{
        project_label: "acme/lapsed",
        registered_at: "2026-08-03T17:25:30.000Z",
        at: "2026-08-03T17:36:15.000Z",
        renew_by: "2026-08-03T17:36:15.000Z",
        renewals: 2,
        sustains: 0,
        detail: "nothing renewed it",
      }],
      stopped_registrations: [{
        project_label: "acme/stopped",
        registered_at: "2026-08-03T17:25:30.000Z",
        at: "2026-08-03T17:41:02.000Z",
        detail: "released by project_stop",
      }],
      orphaned_registrations: [{ project_label: "acme/orphaned" }],
    };
    const answer = buildStatuslinePayload({
      hostState: historical,
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now: "2026-08-03T17:42:00.000Z",
    });

    expect(answer.known_projects).toEqual(["acme/lapsed", "acme/orphaned", "acme/stopped"]);
    expect(answer.lapsed_projects).toEqual([{
      project_label: "acme/lapsed",
      registered_at: "2026-08-03T17:25:30.000Z",
      at: "2026-08-03T17:36:15.000Z",
      reason: "nothing renewed it",
    }]);
    expect(answer.stopped_projects).toEqual([{
      project_label: "acme/stopped",
      at: "2026-08-03T17:41:02.000Z",
    }]);
    expect(answer.orphaned_projects).toEqual(["acme/orphaned"]);
    expect(isRedskilledStatuslinePayload(answer)).toBe(true);
  });

  it("carries the derived metrics block, and validates with or without it", () => {
    const now = "2026-07-29T12:00:00.000Z";
    const metrics = deriveRedskilledLiveMetrics({
      now,
      observations: [
        { worker_id: "w-1", observed_at: "2026-07-29T11:50:00.000Z", tokens: 0, tools: 0, runner: "claude", model: "opus" },
        { worker_id: "w-1", observed_at: "2026-07-29T12:00:00.000Z", tokens: 6_000, tools: 20, runner: "claude", model: "opus" },
      ],
      outcomes: [{ worker_id: "w-0", ts: "2026-07-29T11:30:00.000Z", outcome: "worker-death" }],
    });
    const payload = buildStatuslinePayload({
      hostState: hostStateOf([worker()]),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: { "w-1": 128 },
      sampledAt: now,
      now,
      metrics,
    });

    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    expect(payload.metrics?.hour.tokens_per_min.value).toBe(600);
    expect(payload.metrics?.hour.tools_per_min.value).toBe(2);
    expect(payload.metrics?.hour.issues_per_hour.value).toBe(1);
    expect(payload.metrics?.hour.runner_share.shares).toEqual([{ key: "claude", worker_count: 1, share: 1 }]);

    // A daemon that derives none still answers completely: a consumer must not
    // reject the Worker set over a block it only wanted a rate from.
    const without = buildStatuslinePayload({
      hostState: hostStateOf([worker()]),
      ceiling: UNBOUNDED_HOST_CEILING,
      rss: {},
      sampledAt: null,
      now,
    });
    expect(without.metrics).toBeUndefined();
    expect(isRedskilledStatuslinePayload(without)).toBe(true);
  });

  it("permits a session to read another project's state", async () => {
    const { paths } = await twoProjectDaemon();
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    expect(payload.workers.some((w) => w.project_label === "acme/gadgets")).toBe(true);

    for (const op of ["ping", "host-state", "statusline-payload"] as const) {
      expect(REDSKILLED_OP_REACH[op]).toBe("host-read");
      const verdict = evaluateSessionReach({ op, sessionProject: "acme/widgets", targetProject: "acme/gadgets" });
      expect(verdict.permitted).toBe(true);
      expect(verdict.verdict).toBe("permitted-host-read");
    }
  });

  it("refuses to dispatch, stop, recycle or steer into another project", async () => {
    for (const op of ["worker-start", "worker-stop", "worker-recycle", "worker-steer"] as const) {
      expect(REDSKILLED_OP_REACH[op]).toBe("project-write");
      const refused = evaluateSessionReach({ op, sessionProject: "acme/widgets", targetProject: "acme/gadgets" });
      expect(refused.permitted).toBe(false);
      expect(refused.verdict).toBe("refused-cross-project");
      expect(refused.reason).toContain("acme/gadgets");

      const own = evaluateSessionReach({ op, sessionProject: "acme/widgets", targetProject: "acme/widgets" });
      expect(own.permitted).toBe(true);
      expect(own.verdict).toBe("permitted-own-project");
    }

    const { paths } = await twoProjectDaemon();
    await expect(startRedskilledWorker(
      paths,
      { project_label: "acme/gadgets", workspace_path: "/tmp/acme/w-3", command: "true" },
      { sessionProject: "acme/widgets" },
    )).rejects.toThrow(/acme\/gadgets/);

    for (const command of ["stop", "recycle", "steer"] as const) {
      await expect(commandRedskilledWorker(
        paths,
        { command, worker_id: "w-2", session_project: "acme/widgets" },
        {},
      )).rejects.toThrow(/refus/i);
    }
  });

  it("stops a Worker of the session's own project, and never one it cannot see", async () => {
    const { daemon, paths } = await twoProjectDaemon();
    const result = await commandRedskilledWorker(
      paths,
      { command: "stop", worker_id: "w-1", session_project: "acme/widgets" },
      {},
    );
    expect(result.applied).toBe(true);
    expect(daemon.workerCount()).toBe(1);

    // An unknown Worker is refused rather than reported as absent: a session must
    // not learn, from a refusal, what another project is running.
    await expect(commandRedskilledWorker(
      paths,
      { command: "stop", worker_id: "w-404", session_project: "acme/widgets" },
      {},
    )).rejects.toThrow(/refus/i);
  });

  it("forgets a Worker whose stop is unconfirmed and records the possibly surviving group", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      stopWorker: () => {
        throw new Error("host stop probe failed");
      },
    });
    running.push(daemon);
    daemon.trackWorker(worker({ pgid: 4342 }));

    const result = await commandRedskilledWorker(
      paths,
      { command: "stop", worker_id: "w-1", session_project: "acme/widgets" },
      {},
    );
    await daemon.flushEvents();

    expect(result.applied).toBe(true);
    expect(daemon.workerCount()).toBe(0);
    const death = (await readRedskilledEvents(paths.eventLanePath)).at(-1);
    expect(death).toMatchObject({ event: "worker-death", worker_id: "w-1" });
    expect(death?.detail).toContain("unconfirmed-stop");
    expect(death?.detail).toContain("process group 4342 may still be alive");
  });

  it("holds no private source: a malformed answer throws instead of being patched up", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000, sampleMs: 0 });
    running.push(daemon);

    expect(isRedskilledStatuslinePayload({ version: 1, workers: [], projects: [] })).toBe(false);
    expect(isRedskilledStatuslinePayload(null)).toBe(false);

    // The daemon's own numbers are the payload's numbers — nothing is re-derived.
    const payload = await readRedskilledStatuslinePayload(paths, { sessionProject: "acme/widgets" });
    expect(payload.daemon.pid).toBe(daemon.hostState().pid);
    expect(payload.daemon.daemon_version).toBe(daemon.hostState().daemon_version);
    expect(payload.host.budget_accounting).toEqual(daemon.hostState().budget_accounting);
  });
});

// ADR 0141 decision 2: every remote counter is daemon-owned, and decision 3 says
// a request never fetches — so the counters ride the payload with the age stated
// per counter. An unpolled counter is absent, never a zero: "the queue is empty"
// and "nobody asked" are opposite facts about a repository.
const POLLED_AT = "2026-08-11T12:00:00.000Z";

function counts(overrides: Partial<RedskilledActivityCounts> = {}): RedskilledActivityCounts {
  return {
    open_pull_requests: 3,
    open_issues: 24,
    merged_today: 7,
    recently_closed: 5,
    ready_queue: 1,
    human_queue: 11,
    ...overrides,
  };
}

function activityOf(
  projectCounts: RedskilledActivityCounts | null,
  outcome: RedskilledActivityOutcome = "counted",
  detail = "counted acme/widgets for project \"acme/widgets\"",
): RedskilledRepositoryActivity {
  return {
    version: 1,
    fetched_at: POLLED_AT,
    request_count: 3,
    project_count: 1,
    rate_limit: { remaining: 4_900, reset_at: null, exhausted: false, point_cost: null },
    projects: [{
      project_label: "acme/widgets",
      repository: "acme/widgets",
      outcome,
      counts: projectCounts,
      detail,
    }],
  };
}

function payloadWith(activity: RedskilledRepositoryActivity | null, now: string) {
  return buildStatuslinePayload({
    hostState: hostStateOf([worker()]),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss: {},
    sampledAt: null,
    now,
    ...(activity === null ? {} : { repositoryActivity: activity }),
  });
}

describe("the remote-counter block", () => {
  it("ships every counter the daemon polled, each carrying its own age", () => {
    const payload = payloadWith(activityOf(counts()), "2026-08-11T12:00:05.000Z");
    const block = payload.remote_counters!;
    const project = block.projects[0]!;

    expect(project.project_label).toBe("acme/widgets");
    expect(project.repository).toBe("acme/widgets");
    expect(Object.keys(project.counters).sort()).toEqual([...REDSKILLED_REMOTE_COUNTER_NAMES].sort());
    expect(project.counters.open_pull_requests).toMatchObject({ value: 3, fetched_at: POLLED_AT, age_ms: 5_000, stale: false });
    expect(project.counters.open_issues).toMatchObject({ value: 24, age_ms: 5_000 });
    expect(project.counters.merged_today).toMatchObject({ value: 7, fetched_at: POLLED_AT, age_ms: 5_000 });
    expect(project.counters.ready_queue).toMatchObject({ value: 1, fetched_at: POLLED_AT, age_ms: 5_000, stale: false });
    expect(project.counters.human_queue).toMatchObject({ value: 11, age_ms: 5_000 });
    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
  });

  it("carries a counter nobody polled as absent, never as a zero", () => {
    const payload = payloadWith(
      activityOf(counts({ ready_queue: null, human_queue: null })),
      "2026-08-11T12:00:05.000Z",
    );
    const counters = payload.remote_counters!.projects[0]!.counters;

    expect(counters.ready_queue.value).toBeNull();
    expect(counters.ready_queue.fetched_at).toBeNull();
    expect(counters.ready_queue.age_ms).toBeNull();
    // Absent is not stale: nothing old is being shown, nothing was ever asked.
    expect(counters.ready_queue.stale).toBe(false);
    expect(counters.ready_queue.reason).toContain("absent rather than zero");
    expect(counters.human_queue.value).toBeNull();
    // Its neighbours still answer — one unpolled counter is a fact about itself.
    expect(counters.open_issues.value).toBe(24);
  });

  it("states the age rather than presenting an old counter as current", () => {
    const payload = payloadWith(activityOf(counts()), "2026-08-11T12:10:00.000Z");
    const counters = payload.remote_counters!.projects[0]!.counters;

    expect(counters.ready_queue.stale).toBe(true);
    expect(counters.ready_queue.age_ms).toBe(600_000);
    expect(counters.ready_queue.reason).toContain("past the");
    expect(counters.open_pull_requests.stale).toBe(true);
  });

  it("keeps a spent quota out of the counters it would have read as empty", () => {
    const payload = payloadWith(
      activityOf(null, "rate-limited", "the host token's quota was spent before acme/widgets answered"),
      "2026-08-11T12:00:05.000Z",
    );
    const project = payload.remote_counters!.projects[0]!;

    expect(project.outcome).toBe("rate-limited");
    for (const name of REDSKILLED_REMOTE_COUNTER_NAMES) {
      expect(project.counters[name].value).toBeNull();
      expect(project.counters[name].stale).toBe(false);
      expect(project.counters[name].reason).toContain("quota");
    }
  });

  it("reaches the statusline tail as the compact panorama a reader sees", () => {
    // The seam between the block this daemon composes and the line a reader
    // gets: one poll in, the dated panorama out, drawn by the shared renderer
    // rather than by an assertion's own idea of the layout.
    const payload = payloadWith(activityOf(counts()), "2026-08-11T12:00:05.000Z");

    const line = stripAnsi(renderRedskilledStatusline(
      payload as unknown as RedskilledRenderPayload,
      { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" },
    ).line);

    expect(line).toContain("rdy=1 iss=24 pr=3 mrg=7");
    expect(line).not.toContain("cpr=");
  });

  it("is honestly empty when the daemon polled nothing, and validates without the block", () => {
    const payload = payloadWith(null, "2026-08-11T12:00:00.000Z");

    expect(payload.remote_counters!.projects).toEqual([]);
    expect(payload.remote_counters!.reason).toContain("no repository");
    expect(isRedskilledStatuslinePayload(payload)).toBe(true);
    // A daemon older than this block answers completely without it, and a
    // consumer must not reject the Worker set over a badge (ADR 0130 rule 3).
    const { remote_counters: _absent, ...older } = payload;
    expect(isRedskilledStatuslinePayload(older)).toBe(true);
  });
});

function hostStateOf(workers: readonly RedskilledWorkerView[]) {
  return {
    version: 1 as const,
    protocol_version: 1,
    daemon_version: "0.0.0-test",
    machine_id_hash: "machine",
    session_key_hash: "session",
    pid: 999,
    started_at: "2026-07-29T11:00:00.000Z",
    workers,
    projects: [...new Set(workers.map((w) => w.project_label))].sort().map((project_label) => ({
      project_label,
      worker_count: workers.filter((w) => w.project_label === project_label).length,
    })),
    budget_accounting: {
      version: 1 as const,
      worker_count: workers.length,
      memory_high_bytes: 0,
      memory_max_bytes: 0,
      cpu_weight_total: 0,
      unaccounted_workers: [],
      unisolated_workers: [],
    },
    upgrade: {
      running_version: "0.0.0-test",
      published_version: null,
      published_unknown: 1,
      newer_published: 0,
      replacement: "none" as const,
      checked_at: null,
      checks: 0,
      hold_reason: null,
      newest_published_version: null,
      major_held: 0,
      major_hold: null,
    },
  };
}
