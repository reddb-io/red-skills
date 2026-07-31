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
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import {
  buildStatuslinePayload,
  isRedskilledStatuslinePayload,
  REDSKILLED_STALENESS_MS,
} from "../src/statusline-payload.js";
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
      newest_published_version: null,
      major_held: 0,
      major_hold: null,
    },
  };
}
