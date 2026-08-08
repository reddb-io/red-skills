// "Why did it die" and "is my engine current" are one glance away, on the one
// document every surface reads. The verdicts the boot reaper posed (#3028) reach
// the statusline head and the dashboard from the daemon's own aggregate, and the
// engine version rides beside them — so a surface prints an attribution it never
// derived, and a daemon that never reaped renders no calm zero in its place.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeathAttribution } from "@reddb-io/shared/death-attribution.js";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { readRedskilledDashboard, readRedskilledStatuslineString } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { renderRedskilledDashboard } from "@reddb-io/redskilled-render";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { buildStatuslinePayload } from "../src/statusline-payload.js";
import { renderRedskilledStatusline, REDSKILLED_STATUSLINE_DEFAULTS } from "@reddb-io/redskilled-render";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await mkdtemp(join(tmpdir(), "redskilled-statusline-deaths-"));
  roots.push(root);
  return resolveRedskilledPaths({
    env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root },
    runtimeDir: root,
  });
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

/** The canned verdict every surface in this suite is handed. */
function attribution(overrides: Partial<DeathAttribution> = {}): DeathAttribution {
  return {
    version: 1,
    ts: "2026-07-29T00:59:00.000Z",
    kind: "worker",
    id: "worker:w-9",
    pid: 5150,
    last_seen: "2026-07-29T00:50:00.000Z",
    last_phase: "coding",
    sender_class: "oomd",
    confidence: "high",
    signal: "SIGKILL",
    host_boot_changed: false,
    evidence: ["systemd-oomd killed red-worker-acme-widgets-w-9.service"],
    checked: ["/proc", "/var/log/kern.log"],
    ...overrides,
  };
}

/** One host-observed boot refusal, carrying the grouping facts the renderer needs. */
function bootRefusal(id: string, ts: string): DeathAttribution {
  return {
    ...attribution({
      id,
      ts,
      last_seen: ts,
      last_phase: "boot-refused",
      sender_class: "boot-refused" as DeathAttribution["sender_class"],
      confidence: "high",
      signal: null,
      evidence: ["trunk freshness: dirt-collision (.red/config.yaml)"],
      checked: ["Worker log tail"],
    }),
    project_label: "acme/widgets",
    uptime_s: 1,
    detail: "trunk freshness: dirt-collision (.red/config.yaml)",
  } as unknown as DeathAttribution;
}

function payloadWith(
  deaths: readonly DeathAttribution[] | undefined,
  published?: { version: string | null; newer?: boolean; newest?: string | null },
) {
  return buildStatuslinePayload({
    hostState: buildHostState({
      daemonVersion: "3.2.1",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-07-29T00:00:00.000Z",
      workers: [worker()],
      ...(published == null
        ? {}
        : {
            published: {
              version: published.version,
              checkedAt: "2026-07-29T00:59:00.000Z",
              ...(published.newer == null ? {} : { newer: published.newer }),
              ...(published.newest === undefined ? {} : { newest: published.newest }),
            },
          }),
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss: { "w-1": 512 * 1024 * 1024 },
    sampledAt: "2026-07-29T01:00:00.000Z",
    now: "2026-07-29T01:00:05.000Z",
    ...(deaths === undefined ? {} : { deaths }),
  });
}

describe("the aggregate carries what could not be explained", () => {
  it("reduces a verdict to what a surface prints, and keeps the count beside it", () => {
    const payload = payloadWith([attribution(), attribution({ id: "worker:w-8", ts: "2026-07-29T00:58:00.000Z" })]);
    expect(payload.deaths?.count).toBe(2);
    // Newest first, so `latest` is the one a one-line surface names.
    expect(payload.deaths?.latest?.id).toBe("worker:w-9");
    expect(payload.deaths?.latest?.sender_class).toBe("oomd");
    expect(payload.deaths?.latest?.confidence).toBe("high");
    expect(payload.deaths?.latest?.evidence).toContain("systemd-oomd killed");
  });

  it("tells a reaping that found nothing from a daemon that never reaped", () => {
    // Absent is a daemon with no reaper — the block is not there to be read.
    expect(payloadWith(undefined).deaths).toBeUndefined();
    // Empty is a reaping that concluded: a real answer, and a count of zero.
    expect(payloadWith([]).deaths).toEqual({
      count: 0,
      sender_attributed_count: 0,
      recent: [],
      latest: null,
      latest_sender_attributed: null,
      reaped_at: null,
    });
  });

  it("caps the listed verdicts and still states how many there were", () => {
    const many = Array.from({ length: 9 }, (_, index) =>
      attribution({ id: `worker:w-${index}`, ts: `2026-07-29T00:5${index}:00.000Z` }),
    );
    const payload = payloadWith(many);
    expect(payload.deaths?.count).toBe(9);
    expect(payload.deaths?.recent.length).toBeLessThan(9);
  });

  it("states the sender-attributed subset without dropping bookkeeping gaps", () => {
    const gap = attribution({
      id: "worker:w-gap",
      ts: "2026-07-29T00:59:30.000Z",
      sender_class: "unknown",
      confidence: "none",
      signal: null,
      evidence: [],
      checked: ["the host no longer confirms this Worker"],
    });
    const payload = payloadWith([attribution(), gap]);

    expect(payload.deaths).toMatchObject({
      count: 2,
      sender_attributed_count: 1,
      latest_sender_attributed: { id: "worker:w-9", sender_class: "oomd" },
    });
    expect(payload.deaths?.recent.map((death) => death.id)).toContain("worker:w-gap");

    const line = renderRedskilledStatusline(payload, {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(line.line).toContain("†1 oomd");
    expect(line.line).not.toContain("unknown");

    const dashboard = renderRedskilledDashboard(payload, {
      mode: "local",
      project: "acme/widgets",
      maxWidth: 200,
      maxRows: 16,
      showDeathDetails: true,
    });
    expect(dashboard.lines.some((entry) => entry.includes("worker:w-gap"))).toBe(true);
  });
});

describe("the aggregate says which engine answered, and whether it is current", () => {
  it("states both versions rather than folding them into one", () => {
    const payload = payloadWith([], { version: "3.3.0", newer: true, newest: "3.3.0" });
    expect(payload.engine?.running_version).toBe("3.2.1");
    expect(payload.engine?.published_version).toBe("3.3.0");
    expect(payload.engine?.newer_published).toBe(true);
    expect(payload.engine?.current).toBe(false);
  });

  it("reports an unresolved published answer as unknown, never as up to date", () => {
    const payload = payloadWith([], { version: null, newest: null });
    expect(payload.engine?.published_version).toBeNull();
    expect(payload.engine?.current).toBeNull();
  });
});

describe("the statusline head answers both questions", () => {
  it("renders the engine version and the newest death's class", () => {
    const render = renderRedskilledStatusline(payloadWith([attribution()]), {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(render.line).toContain("v3.2.1");
    expect(render.line).toContain("†1 oomd");
  });

  it("marks an engine that is not the current one, without hiding what is running", () => {
    const render = renderRedskilledStatusline(payloadWith([], { version: "3.3.0", newer: true }), {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(render.line).toContain("v3.2.1⇡");
  });

  it("draws no badge for a machine where nothing died", () => {
    const render = renderRedskilledStatusline(payloadWith([]), {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(render.line).not.toContain("†");
  });

  it("names a repeated boot refusal as a loop, with its span and repair clue", () => {
    const payload = payloadWith([
      bootRefusal("worker:w-9", "2026-07-29T00:04:00.000Z"),
      bootRefusal("worker:w-9", "2026-07-29T00:02:00.000Z"),
      bootRefusal("worker:w-9", "2026-07-29T00:00:00.000Z"),
    ]);
    const render = renderRedskilledStatusline(payload, {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });

    expect(render.line).toContain("†3 boot-refused ×3 in 4m");
    expect(render.line).toContain("trunk freshness: dirt-collision (.red/config.yaml)");

    const dashboard = renderRedskilledDashboard(payload, {
      mode: "local",
      project: "acme/widgets",
      maxWidth: 200,
      maxRows: 16,
    });
    expect(dashboard.header.line).toContain("†3 boot-refused ×3 in 4m");
    expect(dashboard.header.line).toContain("trunk freshness: dirt-collision (.red/config.yaml)");
  });
});

describe("the dashboard carries the receipt the head has no room for", () => {
  it("names what died, who ended it, how sure the reaper is, and the evidence", () => {
    const dashboard = renderRedskilledDashboard(payloadWith([attribution()]), {
      mode: "local",
      project: "acme/widgets",
      maxWidth: 200,
      maxRows: 16,
      showDeathDetails: true,
    });
    expect(dashboard.header.line).toContain("†1 oomd");
    expect(dashboard.header.deaths?.count).toBe(1);
    expect(dashboard.header.engine?.running_version).toBe("3.2.1");
    const receipt = dashboard.lines.find((line) => line.includes("worker:w-9"));
    expect(receipt).toBeDefined();
    expect(receipt).toContain("oomd/high");
    expect(receipt).toContain("phase=coding");
    expect(receipt).toContain("signal=SIGKILL");
    expect(receipt).toContain("systemd-oomd killed");
  });

  it("spends no row telling a healthy machine it is healthy", () => {
    const dashboard = renderRedskilledDashboard(payloadWith([]), {
      mode: "local",
      project: "acme/widgets",
      maxWidth: 200,
      maxRows: 16,
    });
    expect(dashboard.lines.some((line) => line.includes("†"))).toBe(false);
  });
});

describe("a live daemon serves both answers over the socket", () => {
  it("hands the statusline and the dashboard the verdicts it was born holding", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      daemonVersion: "3.2.1",
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: { "w-1": 512 * 1024 * 1024 }, cpu_seconds: {} }),
      // Exactly what the boot reaper hands the daemon at `serve`.
      deaths: [attribution()],
    });
    running.push(daemon);
    daemon.trackWorker(worker());
    await daemon.sampleMemoryBudgets();

    const render = await readRedskilledStatuslineString(paths, {
      ...REDSKILLED_STATUSLINE_DEFAULTS,
      project: "acme/widgets",
    });
    expect(render.line).toContain("v3.2.1");
    expect(render.line).toContain("†1 oomd");

    const dashboard = await readRedskilledDashboard(paths, {
      mode: "local",
      project: "acme/widgets",
      showDeathDetails: true,
    });
    expect(dashboard.header.line).toContain("†1 oomd");
    expect(dashboard.lines.some((line) => line.includes("worker:w-9"))).toBe(true);
  });

  it("leaves the block absent when nothing reaped, rather than inventing a calm zero", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
      daemonVersion: "3.2.1",
      clock: () => "2026-07-29T01:00:05.000Z",
      treeSampler: () => ({ rss: {}, cpu_seconds: {} }),
    });
    running.push(daemon);

    const dashboard = await readRedskilledDashboard(paths, { mode: "local", project: "acme/widgets" });
    expect(dashboard.header.deaths).toBeNull();
    expect(dashboard.header.line).not.toContain("†");
  });
});
