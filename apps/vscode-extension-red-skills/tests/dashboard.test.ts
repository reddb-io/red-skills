/**
 * The dashboard is the one view whose correctness is NOT this extension's to
 * prove. Every cell arrives finished from `statusline-dashboard`, so what these
 * assert is the only thing a surface can get wrong: that it shows what it was
 * handed, that it re-derives nothing, that a state change in the daemon reaches
 * both surfaces, and that an absence is drawn as an absence.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  dashboardRows,
  escapeHtml,
  renderDashboardHtml,
  statusBarView,
  STATUS_BAR_ABSENCE,
} from "../src/model/dashboard-view.js";
import { readHostSnapshot, type HostSnapshot } from "../src/model/snapshot.js";
import { createRedskilledReadClient } from "../src/redskilled/client.js";
import { startFakeDaemon, type FakeDaemon } from "./fake-daemon.js";
import { dashboard, hostState, statuslinePayload } from "./fixtures.js";

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
      "run=claude opus high",
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

describe("the frame is read from the daemon, not derived from the payload", () => {
  it("asks statusline-dashboard beside the payload and states the size it has", async () => {
    const daemon = await fake();
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
      sessionProject: "reddb-io/red-skills",
      dashboardRender: { maxWidth: 118, maxRows: 9 },
    });

    expect(snapshot.reachable).toBe(true);
    expect(daemon.served.get("statusline-dashboard")).toBe(1);
    expect(snapshot.dashboard?.header.line).toContain("» reddb-io/red-skills");
    // The rows are the daemon's own, verbatim: nothing in this extension built
    // one, so a field the daemon stops rendering vanishes here too.
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

  it("keeps the trees usable when a daemon refuses the op", async () => {
    const daemon = await fake({ refuse: ["statusline-dashboard"] });
    const snapshot = await readHostSnapshot({
      client: createRedskilledReadClient({ socketPath: daemon.socketPath }),
      eventLanePath: daemon.eventLanePath,
      source: "the test pinned it",
    });

    expect(snapshot.reachable).toBe(true);
    expect(snapshot.payload).not.toBeNull();
    expect(snapshot.dashboard).toBeNull();
  });

  it("reflects a state change in the daemon without local re-derivation", async () => {
    let stale = false;
    const daemon = await fake({ dashboard: () => dashboard({ stale, rows: stale ? [] : dashboard().rows }) });
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
