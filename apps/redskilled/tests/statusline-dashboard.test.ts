// The dashboard is the statusline with a vertical dimension, and it is rendered
// where the statusline is: in the daemon. These prove the three things a surface
// depends on and cannot check for itself — the rows carry the statusline's own
// fields, the bar is drawn from two published integers rather than from a
// pipeline vocabulary the daemon does not have, and the op serves the same answer
// a direct render of the payload produces.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import { publishRedskilledWorkerLogLine, readRedskilledDashboard } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import {
  REDSKILLED_DASHBOARD_COLUMNS,
  REDSKILLED_DASHBOARD_DEFAULTS,
  progressBar,
  renderRedskilledDashboard,
} from "@reddb-io/redskilled-render";
import { buildHostState, type RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { isRedskilledDashboard } from "../src/protocol.js";
import type { RedskilledStatuslineMetrics } from "../src/live-metrics.js";
import { buildStatuslinePayload, type RedskilledStatuslinePayload } from "../src/statusline-payload.js";
import {
  REDSKILLED_WORKER_DISPLAY_ABSENT,
  clampPublishedWorkerDisplay,
  coerceWorkerDisplay,
  REDSKILLED_DISPLAY_FIELD_MAX,
  type RedskilledWorkerDisplay,
} from "../src/worker-display.js";

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
  const root = await scratch("rsk-dash-");
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

function display(overrides: Partial<RedskilledWorkerDisplay> = {}): RedskilledWorkerDisplay {
  return {
    ...REDSKILLED_WORKER_DISPLAY_ABSENT,
    runner: "claude",
    model: "opus",
    effort: "high",
    origin: "afk",
    issue: "3012",
    phase: "coding",
    step: "impl",
    phase_index: 2,
    phase_total: 6,
    heartbeat: "3s",
    added: 142,
    removed: 36,
    tokens: 45_000,
    tools: 12,
    reasoning: 4,
    text: 9,
    ...overrides,
  };
}

/**
 * The canned metrics block both surfaces are handed, in the daemon's own shape.
 *
 * The hour finished no issue, so `issues_per_hour` is ABSENT rather than zero —
 * which is what makes it worth pinning here: the header must leave the figure
 * out entirely rather than print a rate nobody measured.
 */
function metricsOf(): RedskilledStatuslineMetrics {
  return {
    generated_at: "2026-07-29T01:00:05.000Z",
    hour: {
      window: "hour",
      window_ms: 3_600_000,
      from: "2026-07-29T00:00:05.000Z",
      to: "2026-07-29T01:00:05.000Z",
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
      from: "2026-07-28T01:00:05.000Z",
      to: "2026-07-29T01:00:05.000Z",
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
  };
}

function payloadOf(
  workers: readonly RedskilledWorkerView[],
  displays: Record<string, RedskilledWorkerDisplay> = {},
  metrics?: RedskilledStatuslineMetrics,
): RedskilledStatuslinePayload {
  return buildStatuslinePayload({
    metrics,
    hostState: buildHostState({
      daemonVersion: "0.1.0",
      machineIdHash: "mach",
      sessionKeyHash: "sess",
      pid: 99,
      startedAt: "2026-07-29T00:00:00.000Z",
      workers,
      registrations: [],
    }),
    ceiling: UNBOUNDED_HOST_CEILING,
    rss: {},
    sampledAt: "2026-07-29T01:00:00.000Z",
    displays: Object.fromEntries(
      Object.entries(displays).map(([id, value]) => [id, { display: value, published_at: "2026-07-29T01:00:00.000Z" }]),
    ),
    now: "2026-07-29T01:00:05.000Z",
  });
}

const LOCAL = { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" };

describe("the dashboard carries the statusline's own fields", () => {
  it("renders one row per Worker with run, org, iss, phase, elapsed, heartbeat, loc and the vitals", () => {
    const dashboard = renderRedskilledDashboard(payloadOf([worker()], { "w-1": display() }), LOCAL);

    expect(dashboard.rows).toHaveLength(1);
    const cells = dashboard.rows[0]!.cells;
    expect(cells.wid).toBe("w-1");
    expect(cells.run).toBe("run=claude opus high");
    expect(cells.org).toBe("org=afk");
    expect(cells.iss).toBe("iss=3012");
    expect(cells.phase).toBe("coding·impl");
    expect(cells.elapsed).toBe("1h0m");
    expect(cells.hb).toBe("hb=3s");
    expect(cells.loc).toBe("loc=+142 -36");
    expect(cells.tks).toBe("tks=45k");
    expect(cells.tls).toBe("tls=12");
    expect(cells.rsn).toBe("rsn=4");
    expect(cells.txt).toBe("txt=9");
  });

  it("names every column the statusline's per-worker line prints", () => {
    expect([...REDSKILLED_DASHBOARD_COLUMNS]).toEqual([
      "wid",
      "run",
      "org",
      "iss",
      "bar",
      "phase",
      "elapsed",
      "hb",
      "loc",
      "tks",
      "tls",
      "rsn",
      "txt",
    ]);
  });

  it("puts the repo, the version, the model and the prs/cpr/iss counts on the header line", () => {
    const payload = {
      ...payloadOf([worker()], { "w-1": display() }),
      repository_activity: {
        version: 1 as const,
        outcome: "counted" as const,
        fetched_at: "2026-07-29T01:00:00.000Z",
        age_ms: 1_000,
        threshold_ms: 120_000,
        stale: false,
        request_count: 1,
        project_count: 1,
        rate_limit: { remaining: 4_900, reset_at: null, exhausted: false },
        reason: "counted",
        projects: [
          {
            project_label: "acme/widgets",
            repository: "acme/widgets",
            outcome: "counted" as const,
            counts: { open_pull_requests: 3, open_issues: 24, recently_closed: 7 },
            detail: "counted",
            age_ms: 1_000,
            stale: false,
          },
        ],
      },
    } as unknown as RedskilledStatuslinePayload;

    const header = renderRedskilledDashboard(payload, LOCAL).header;
    expect(header.repo).toBe("acme/widgets");
    expect(header.version).toBe("0.1.0");
    expect(header.model).toBe("claude·opus·high");
    expect(header.counts).toMatchObject({ open_pull_requests: 3, open_issues: 24, recently_closed: 7 });
    expect(header.line).toContain("» acme/widgets v0.1.0");
    expect(header.line).toContain("prs=3");
    expect(header.line).toContain("cpr=7");
    expect(header.line).toContain("iss=24");
  });

  it("prints the header first and one line per row, so a surface prints and splits nothing", () => {
    const dashboard = renderRedskilledDashboard(
      payloadOf([worker(), worker({ worker_id: "w-2" })], { "w-1": display(), "w-2": display() }),
      LOCAL,
    );
    expect(dashboard.lines[0]).toBe(dashboard.header.line);
    expect(dashboard.lines.slice(1)).toEqual(dashboard.rows.map((row) => row.line));
  });

  it("says how many Workers the row budget left out rather than dropping them in silence", () => {
    const workers = [worker(), worker({ worker_id: "w-2" }), worker({ worker_id: "w-3" })];
    const dashboard = renderRedskilledDashboard(payloadOf(workers), { ...LOCAL, maxRows: 1 });
    expect(dashboard.rows).toHaveLength(1);
    expect(dashboard.hidden_row_count).toBe(2);
    expect(dashboard.lines.at(-1)).toContain("2 more Worker(s)");
  });
});

describe("an unpublished field is an absence, never a zero", () => {
  it("leaves every published cell empty for a Worker whose project publishes nothing", () => {
    const cells = renderRedskilledDashboard(payloadOf([worker()]), LOCAL).rows[0]!.cells;
    expect(cells.run).toBe("");
    expect(cells.iss).toBe("");
    expect(cells.tks).toBe("");
    expect(cells.loc).toBe("");
    expect(cells.hb).toBe("hb=?");
    // The identity and the daemon's own clock still render: they were never the
    // project's to publish.
    expect(cells.wid).toBe("w-1");
    expect(cells.elapsed).toBe("1h0m");
  });

  it("renders a genuine zero as a zero", () => {
    const cells = renderRedskilledDashboard(
      payloadOf([worker()], { "w-1": display({ tokens: 0, added: 0, removed: 0 }) }),
      LOCAL,
    ).rows[0]!.cells;
    expect(cells.tks).toBe("tks=0");
    expect(cells.loc).toBe("loc=0");
  });
});

describe("the header carries the rates the daemon derived", () => {
  it("puts the hour's rates and the leading runner share in the one line a status bar shows", () => {
    const dashboard = renderRedskilledDashboard(
      payloadOf([worker()], { "w-1": display() }, metricsOf()),
      LOCAL,
    );

    expect(dashboard.header.line).toContain("tk/m=1.2k");
    expect(dashboard.header.line).toContain("tl/m=8.4");
    expect(dashboard.header.line).toContain("claude=67%");
    // The whole block travels beside the line, so a surface with room draws both
    // windows and both dimensions without a second read.
    expect(dashboard.header.metrics?.day.model_share.shares.map((share) => share.key)).toEqual(["opus", "sonnet"]);
  });

  it("leaves an underived rate out of the line rather than printing it as zero", () => {
    const dashboard = renderRedskilledDashboard(
      payloadOf([worker()], { "w-1": display() }, metricsOf()),
      LOCAL,
    );

    expect(dashboard.header.line).not.toContain("iss/h");
    expect(dashboard.header.line).not.toContain("iss/h=0");
    expect(dashboard.header.metrics?.hour.issues_per_hour.value).toBeNull();
    expect(dashboard.header.metrics?.hour.issues_per_hour.absent_reason).toContain("no Worker outcome");
  });

  it("drops the rates whole when the line will not hold them, keeping every other part", () => {
    const narrow = renderRedskilledDashboard(
      payloadOf([worker()], { "w-1": display() }, metricsOf()),
      { ...LOCAL, maxWidth: 96 },
    );

    expect(narrow.header.line.length).toBeLessThanOrEqual(96);
    expect(narrow.header.line).not.toContain("tk/m");
    expect(narrow.header.line).toContain("wrk=1/1");
    // Dropped from the LINE, never from the answer: the block a surface reads
    // structurally does not shrink because a status bar is narrow.
    expect(narrow.header.metrics).not.toBeNull();
  });

  it("says nothing at all about rates on a daemon that derives none", () => {
    const dashboard = renderRedskilledDashboard(payloadOf([worker()], { "w-1": display() }), LOCAL);

    expect(dashboard.header.metrics).toBeNull();
    expect(dashboard.header.line).not.toContain("tk/m");
    expect(dashboard.header.line).not.toContain("0%");
  });
});

describe("the pipeline bar is two integers, not a vocabulary", () => {
  it("draws completed cells, one cursor, and the rest ahead", () => {
    expect(progressBar(display({ phase_index: 2, phase_total: 6 }))).toBe("██▶░░░");
  });

  it("marks a failed Worker's cursor without moving it", () => {
    expect(progressBar(display({ phase_index: 2, phase_total: 6, failed: true }))).toBe("██✗░░░");
  });

  it("fills the bar at the end of the pipeline", () => {
    expect(progressBar(display({ phase_index: 6, phase_total: 6 }))).toBe("██████");
  });

  it("draws no bar at all when the project published no position", () => {
    expect(progressBar(REDSKILLED_WORKER_DISPLAY_ABSENT)).toBe("");
  });
});

describe("the published display record is stored and never interpreted", () => {
  it("keeps a recognisable field and nulls one it cannot read, rather than failing the record", () => {
    const coerced = coerceWorkerDisplay({ runner: "codex", tokens: "many", issue: 17, phase_index: 3 });
    expect(coerced).not.toBeNull();
    expect(coerced!.runner).toBe("codex");
    expect(coerced!.tokens).toBeNull();
    // A number where a string was promised is not a string; the daemon says so
    // rather than stringifying it, because coercing content is reading it.
    expect(coerced!.issue).toBeNull();
    expect(coerced!.phase_index).toBe(3);
  });

  it("refuses a value that is not a record at all", () => {
    expect(coerceWorkerDisplay("coding")).toBeNull();
    expect(coerceWorkerDisplay(null)).toBeNull();
    expect(coerceWorkerDisplay([1, 2])).toBeNull();
  });

  it("clamps on the publisher's side, so a runaway value never makes a heartbeat expensive", () => {
    const clamped = clampPublishedWorkerDisplay(display({ step: "x".repeat(500) }));
    expect(clamped.step).toHaveLength(REDSKILLED_DISPLAY_FIELD_MAX);
  });
});

describe("the daemon serves the dashboard it renders", () => {
  it("answers statusline-dashboard with the same document a direct render produces", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      daemonVersion: "0.1.0",
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
    });
    running.push(daemon);

    const dashboard = await readRedskilledDashboard(paths, { mode: "global" });
    expect(isRedskilledDashboard(dashboard)).toBe(true);
    expect(dashboard.version).toBe(1);
    expect(dashboard.mode).toBe("global");
    expect(dashboard.lines[0]).toBe(dashboard.header.line);
    expect(dashboard.header.version).toBe("0.1.0");
  });

  it("reports no such Worker rather than storing a display record for one it does not hold", async () => {
    const paths = await sessionPaths();
    const daemon = await startRedskilledDaemon({
      paths,
      daemonVersion: "0.1.0",
      idleMs: 60_000,
      sampleMs: 0,
      ceiling: UNBOUNDED_HOST_CEILING,
      stopWorker: () => true,
    });
    running.push(daemon);

    const ack = await publishRedskilledWorkerLogLine(paths, {
      worker_id: "ghost",
      line: "still here",
      display: display(),
    });
    expect(ack.accepted).toBe(false);

    const dashboard = await readRedskilledDashboard(paths, { mode: "global" });
    expect(dashboard.rows).toHaveLength(0);
  });
});
