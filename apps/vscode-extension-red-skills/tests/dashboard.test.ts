/**
 * The dashboard is drawn HERE, by the one render module every surface shares
 * (ADR 0132 decisions 1 and 9) — this extension owns no layout of its own. So
 * what these assert is the only thing a surface can get wrong: that it shows
 * what the shared render handed it, that it re-derives no cell, that a state
 * change in the daemon reaches both surfaces, and that an absence is drawn as an
 * absence.
 */
import { afterEach, describe, expect, it } from "vitest";
import { stripAnsi } from "@reddb-io/redskilled-render/format.js";
import {
  dashboardRows,
  escapeHtml,
  renderDashboardHtml,
  statusBarView,
  STATUS_BAR_ABSENCE,
} from "../src/model/dashboard-view.js";
import { buildWorkersTree } from "../src/model/nodes.js";
import { readHostSnapshot, type HostSnapshot } from "../src/model/snapshot.js";
import { createRedskilledReadClient } from "../src/redskilled/client.js";
import { startFakeDaemon, type FakeDaemon } from "./fake-daemon.js";
import { dashboard, hostState, statuslinePayload } from "./fixtures.js";

/** The same payload with a published display record, so the row has cells. */
function withDisplay(payload: ReturnType<typeof statuslinePayload>): ReturnType<typeof statuslinePayload> {
  return {
    ...payload,
    workers: payload.workers.map((entry) => ({
      ...entry,
      display: {
        runner: "claude",
        model: "opus",
        effort: "high",
        origin: "afk",
        issue: "3096",
        phase: "coding",
        step: null,
        phase_index: 2,
        phase_total: 6,
        failed: false,
        heartbeat: "3s",
        // A Worker that is not waiting on anything: the absence this whole slice
        // exists to tell apart from a Worker that went quiet.
        wait_kind: null,
        wait_subject: null,
        wait_pid: null,
        wait_started_at: null,
        wait_deadline: null,
        wait_escalation: null,
        started_at: null,
        context: null,
        eta: null,
        added: null,
        removed: null,
        tokens: null,
        tools: null,
        reasoning: null,
        text: null,
      },
      display_published_at: payload.generated_at,
    })),
  };
}

const daemons: FakeDaemon[] = [];

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
});

async function fake(options: Parameters<typeof startFakeDaemon>[0] = {}): Promise<FakeDaemon> {
  const daemon = await startFakeDaemon(options);
  daemons.push(daemon);
  return daemon;
}

function snapshotOf(overrides: Partial<HostSnapshot> = {}): HostSnapshot {
  return {
    reachable: true,
    socketPath: "/tmp/rsk/d.sock",
    source: "derived from XDG_RUNTIME_DIR",
    payload: statuslinePayload(),
    hostState: hostState(),
    dashboard: dashboard(),
    lane: { path: "/tmp/rsk/lane.toonl", exists: true, truncated: false, events: [] },
    error: null,
    readAt: "2026-08-01T10:00:00.000Z",
    ...overrides,
  };
}

describe("the status bar shows the daemon's own summary", () => {
  it("puts the header line in the bar verbatim, and the whole render in the tooltip", () => {
    const view = statusBarView(snapshotOf());
    expect(view.text).toContain("» reddb-io/red-skills v0.4.1");
    expect(view.text).toContain("prs=3");
    expect(view.text).toContain("iss=24");
    expect(view.warning).toBe(false);
    expect(view.tooltip).toContain("iss=3012");
  });

  it("warns on a stale frame and says so in the bar, not only in the tooltip", () => {
    const view = statusBarView(snapshotOf({ dashboard: dashboard({ stale: true }) }));
    expect(view.warning).toBe(true);
    expect(view.text).toContain("$(warning)");
  });

  it("reports an unreachable daemon as an outage, never as an idle machine", () => {
    const view = statusBarView(
      snapshotOf({
        reachable: false,
        payload: null,
        hostState: null,
        dashboard: null,
        error: { name: "RedskilledUnreachableError", message: "not reachable" },
      }),
    );
    expect(view.text).toBe(STATUS_BAR_ABSENCE);
    expect(view.warning).toBe(true);
    expect(view.tooltip).toContain("not reachable");
  });

  it("says a daemon predating the op has nothing to draw, rather than drawing zeros", () => {
    const view = statusBarView(snapshotOf({ dashboard: null }));
    expect(view.warning).toBe(false);
    expect(view.text).not.toContain("wrk=");
    expect(view.tooltip).toContain("statusline-dashboard");
  });
});

describe("the dashboard panel shows the rows the daemon rendered", () => {
  it("carries every statusline field into the body", () => {
    const html = renderDashboardHtml(snapshotOf());
    for (const cell of [
      "run=claude opus-4.8 high",
      "org=afk",
      "iss=3012",
      "██▶░░░",
      "coding·impl",
      "1h0m",
      "hb=3s",
      "loc=+142 -36",
      "tks=45k",
      "tls=12",
      "rsn=4",
      "txt=9",
    ]) {
      expect(html).toContain(cell);
    }
  });

  it("keeps a trailing line the daemon added, like the row budget's own", () => {
    const board = dashboard();
    const withMore = dashboard({
      lines: [...board.lines, "… 3 more Worker(s) — the row budget is short, not the host"],
      hidden_row_count: 3,
    });
    expect(dashboardRows(withMore).at(-1)).toContain("3 more Worker(s)");
    expect(renderDashboardHtml(snapshotOf({ dashboard: withMore }))).toContain("3 more Worker(s)");
  });

  it("escapes what the daemon rendered rather than trusting it as markup", () => {
    expect(escapeHtml('<script>&"')).toBe("&lt;script&gt;&amp;&quot;");
    const html = renderDashboardHtml(
      snapshotOf({ dashboard: dashboard({ lines: ["<script>alert(1)</script>"], rows: [] }) }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("draws an absence when nothing answered, never a table of zeros", () => {
    const html = renderDashboardHtml(
      snapshotOf({
        reachable: false,
        payload: null,
        dashboard: null,
        error: { name: "RedskilledUnreachableError", message: "not reachable" },
      }),
    );
    expect(html).toContain("redskilled provision");
    expect(html).not.toContain("wrk=");
  });

  it("says the host is idle when the daemon renders no rows", () => {
    const html = renderDashboardHtml(snapshotOf({ dashboard: dashboard({ rows: [], lines: ["» host v0.4.1"] }) }));
    expect(html).toContain("the machine is idle, and this is the daemon saying so");
  });
});

describe("the frame is drawn here, from the one document the daemon composed", () => {
  it("draws the table from the payload it already read, at the size the panel has", async () => {
    const daemon = await fake({ payload: () => withDisplay(statuslinePayload()) });
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
      sessionProject: "reddb-io/red-skills",
      dashboardRender: { maxWidth: 118, maxRows: 9 },
    });

    expect(snapshot.reachable).toBe(true);
    // ONE read, and no second round trip for text this process can compute from
    // bytes it already holds (ADR 0132 decisions 1 and 9).
    expect(daemon.served.get("statusline-payload")).toBe(1);
    expect(daemon.served.has("statusline-dashboard")).toBe(false);
    // The wire line is coloured by design (#3150/#3152); the identity is asserted
    // through the same strip every ANSI-free reader applies at its boundary.
    expect(stripAnsi(snapshot.dashboard?.header.line ?? "")).toContain("» reddb-io/red-skills");
    // The cells come from the shared render module, so a terminal pane standing
    // in the same directory draws this row character for character.
    expect(snapshot.dashboard?.rows[0]?.cells.bar).toBe("██▶░░░");
  });

  it("shows why a process died, and the engine that answered, from the daemon's own frame", async () => {
    const daemon = await fake();
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
      sessionProject: "reddb-io/red-skills",
    });

    // The bar: the count and the class, because "why did it die" must survive
    // being read at a glance beside a Worker count that looks perfectly healthy.
    const bar = statusBarView(snapshot);
    expect(bar.text).toContain("†1 oomd");
    expect(bar.text).toContain("v0.4.1");

    // The panel: the receipt the bar has no room for — and not one character of
    // it computed here.
    const html = renderDashboardHtml(snapshot);
    expect(html).toContain("worker:w-gone");
    expect(html).toContain("oomd/high");
    expect(html).toContain("signal=SIGKILL");
    expect(html).toContain("systemd-oomd killed");
  });

  it("carries the daemon's rates and shares into the bar and into the trees", async () => {
    const daemon = await fake();
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
      sessionProject: "reddb-io/red-skills",
    });

    // The bar: whatever fits the one line, and no figure the daemon did not
    // derive — the hour finished no issue, so no `iss/h` reaches the bar at all.
    const bar = statusBarView(snapshot);
    expect(bar.text).toContain("tk/m=1.2k");
    expect(bar.text).toContain("claude=67%");
    expect(bar.text).not.toContain("iss/h");

    // The tree: the whole block, both windows and both dimensions, off the same
    // aggregate the Worker rows are read from.
    const rates = buildWorkersTree(snapshot)[0]!.children;
    expect(rates.map((row) => row.label)).toEqual(["rates · last hour", "rates · last 24 hours"]);
    const hour = rates[0]!.children;
    expect(hour.find((row) => row.label === "tokens/min")?.description).toBe("1.2k · 18 samples");
    expect(hour.find((row) => row.label === "runner share")?.description).toBe("claude 67% (2) · codex 33% (1)");
    expect(rates[1]!.children.find((row) => row.label === "model share")?.description).toBe(
      "opus 50% (1) · sonnet 50% (1) · 3 unattributed",
    );
  });

  it("draws a rate the daemon could not derive as an absence, never as a zero", async () => {
    const daemon = await fake();
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
    });

    const hour = buildWorkersTree(snapshot)[0]!.children[0]!.children;
    const issues = hour.find((row) => row.label === "issues/hour")!;
    expect(issues.description).toBe("— no Worker outcome was recorded in the last 1h");
    expect(issues.description).not.toContain("0");

    const models = hour.find((row) => row.label === "model share")!;
    expect(models.description).toContain("no Worker published a model in the last 1h");
    expect(models.description).not.toContain("0%");

    // The source that had nothing to answer with is named, because "the sampler
    // is down" and "the machine is quiet" produce the same dash above.
    const unavailable = hour.find((row) => row.label === "unavailable")!;
    expect(unavailable.description).toBe("worker-outcomes");
    expect(unavailable.tone).toBe("warning");
  });

  it("says a daemon deriving no metrics has none, rather than reporting an idle machine", async () => {
    const daemon = await fake({
      payload: () => ({ ...statuslinePayload(), metrics: undefined }),
    });
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
    });

    const rows = buildWorkersTree(snapshot)[0]!.children;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("absence");
    expect(rows[0]!.label).toBe("no metrics on this daemon");
  });

  it("keeps the frame usable when a daemon refuses the read beside the payload", async () => {
    const daemon = await fake({ refuse: ["host-state"] });
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
    });

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.payload).not.toBeNull();
    expect(snapshot.hostState).toBeNull();
    // The table survives a refused `host-state`, because it is drawn from the
    // payload and from nothing else — there is no second op to lose.
    expect(snapshot.dashboard).not.toBeNull();
  });

  it("reflects a state change in the daemon on the next payload it reads", async () => {
    let stale = false;
    const daemon = await fake({
      payload: () => statuslinePayload({ stale, ...(stale ? { workers: [] } : {}) }),
    });
    const client = createRedskilledReadClient({ socketPath: daemon.socketPath });
    const read = async (): Promise<HostSnapshot> =>
      await readHostSnapshot({ client, eventLanePath: daemon.eventLanePath, source: "the test pinned it" });

    const before = statusBarView(await read());
    expect(before.warning).toBe(false);

    stale = true;
    const after = await read();
    expect(statusBarView(after).warning).toBe(true);
    expect(renderDashboardHtml(after)).toContain("the machine is idle");
  });
});
