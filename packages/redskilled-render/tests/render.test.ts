/**
 * render — the four acceptance claims of ADR 0132 decision 1, as assertions.
 *
 * One module, three densities, no state and no transport, and a fixture that
 * draws exactly what a live read draws.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { encode as encodeToon } from "@reddb-io/toon";
import {
  decodeRedskilledPayload,
  detailLadder,
  BAR_AHEAD,
  BAR_CURRENT,
  BAR_DONE,
  BOLD,
  DIM,
  GOLD,
  KEY,
  NOBG,
  RED,
  RESET,
  RedskilledRenderDecodeError,
  renderRedskilled,
  renderRedskilledDashboard,
  renderRedskilledPanel,
  renderRedskilledStatusline,
  renderRedskilledStatuslineAbsence,
  REDSKILLED_DASHBOARD_DEFAULTS,
  REDSKILLED_PANEL_DEFAULTS,
  REDSKILLED_RENDER_ABSENCE,
  REDSKILLED_STATUSLINE_DEFAULTS,
  stripAnsi,
  SOFT,
  VAL,
  WHITE,
  WINE,
  WINE2,
  width,
} from "../index.js";
import { display, payload, worker } from "./fixture.js";

const LOCAL = { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" };

describe("one module, three densities", () => {
  it("draws the same payload at a line, a panel and a table", () => {
    const doc = payload({ workers: [worker({ display: display() })] });

    const line = renderRedskilledStatusline(doc, LOCAL);
    const panel = renderRedskilledPanel(doc, { ...REDSKILLED_PANEL_DEFAULTS, project: "acme/widgets" });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });

    expect(line.lines).toHaveLength(2);
    expect(line.line).toContain("acme/widgets 1w");
    expect(stripAnsi(line.lines[1]!)).toContain("w-1");
    // The panel's FIRST row is the line density's own output, not a second
    // spelling of it — the composition is the no-drift guarantee.
    expect(panel.head.line).toBe(panel.lines[0]);
    expect(panel.lines.length).toBeGreaterThan(1);
    expect(panel.worker_rows[0]).toContain("w-1");
    expect(table.rows).toHaveLength(1);
    expect(stripAnsi(table.header.line)).toContain("wrk=1/1");
  });

  it("attributes target-plus-one slot usage to the interactive reservation", () => {
    const base = payload();
    const doc = payload({
      host: {
        ...base.host,
        worker_count: 4,
        ceiling: { ...base.host.ceiling, worker_count: 3, interactive_reservation: 1 },
      },
    });

    expect(stripAnsi(renderRedskilledDashboard(doc, REDSKILLED_DASHBOARD_DEFAULTS).header.line))
      .toContain("slots=4/3 reserve=1 interactive");
  });

  it("routes a density by name through the one entry point", () => {
    const doc = payload();
    const drawn = renderRedskilled(doc, { density: "panel", options: { project: "acme/widgets" } });
    expect(drawn.density).toBe("panel");
    expect(drawn.lines[0]).toContain("acme/widgets");
    expect(renderRedskilled(doc, { density: "line", options: { project: "acme/widgets" } }).lines)
      .toEqual(renderRedskilledStatusline(doc, LOCAL).lines);
  });

  it("names a repair lane, its patient and step at every density", () => {
    const coding = worker({ worker_id: "w-code", display: display() });
    const repair = worker({
      worker_id: "w-heal",
      display: display({
        runner: null,
        model: null,
        effort: null,
        origin: "repair",
        issue: "3291",
        phase: "merging",
        step: "regenerate",
      }),
    });
    const doc = payload({
      workers: [coding, repair],
      host: { ...payload().host, worker_count: 2 },
      projects: [{ ...payload().projects[0]!, worker_count: 2 }],
    });

    const line = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 240 });
    const panel = renderRedskilledPanel(doc, {
      ...REDSKILLED_PANEL_DEFAULTS,
      project: "acme/widgets",
      maxWidth: 240,
    });
    const table = renderRedskilledDashboard(doc, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      project: "acme/widgets",
      maxWidth: 240,
    });

    for (const row of [line.lines[2]!, panel.worker_rows[1]!, table.rows[1]!.line]) {
      expect(stripAnsi(row)).toContain("lane=repair");
      expect(stripAnsi(row)).toContain("pr=#3291");
      expect(stripAnsi(row)).toContain("merging·regenerate");
      expect(row).toContain(`${WINE}${WHITE}lane=repair`);
    }
    expect(line.line).toContain("1 coding + 1 repairing");
    expect(stripAnsi(table.header.line)).toContain("workers=1 coding + 1 repairing");
    expect(stripAnsi(renderRedskilledDashboard(payload(), REDSKILLED_DASHBOARD_DEFAULTS).header.line))
      .not.toContain("repairing");
  });

  it("degrades cells from the right without dropping selected Workers", () => {
    const workers = Array.from({ length: 3 }, (_, index) =>
      worker({ worker_id: `w-${index}`, display: display({ issue: String(3100 + index) }) }));
    const doc = payload({ workers, host: { ...payload().host, worker_count: 3 } });
    const narrow = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 40 });
    expect(narrow.detail).toBe("workers");
    expect(narrow.degraded).toBe(true);
    expect(narrow.lines).toHaveLength(4);
    for (const [index, line] of narrow.lines.entries()) {
      expect(width(line)).toBeLessThanOrEqual(40);
      if (index > 0) expect(stripAnsi(line)).toContain(`w-${index - 1}`);
    }
    expect(stripAnsi(narrow.lines[1]!)).not.toContain("txt=");

    // The ladder is layout, and it now lives beside every density rather than
    // inside one of them.
    expect(detailLadder({ mode: "global", maxWorkers: 2, maxProjects: 4, workers, projects: doc.projects }))
      .toEqual(["projects", "host"]);
  });
});

describe("the statusline Worker table (#3151)", () => {
  it("draws every dashboard cell in colour on a row beneath the head", () => {
    const doc = payload({ workers: [worker({ display: display({ model: "claude-opus-5" }) })] });
    const rendered = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 240 });

    expect(rendered.lines).toHaveLength(2);
    expect(rendered.line).toBe(rendered.lines[0]);
    const raw = rendered.lines[1]!;
    expect(stripAnsi(raw)).toBe(
      "w-1  run=claude opus-5 high  org=afk  iss=3096  ██▶░░  coding·edit  2m5s  eta=10m40s  hb=3s  loc=+120 -8  tks=42k  ctx=108k  tls=31  rsn=9  txt=4",
    );
    expect(raw).toContain(`${BOLD}w-1`);
    expect(raw).toContain(`${KEY}run=${VAL}claude opus-5 high`);
    expect(raw).toContain(`${BAR_DONE}██${BAR_CURRENT}▶${BAR_AHEAD}░░`);
    for (const key of ["run", "org", "iss", "eta", "hb", "loc", "tks", "ctx", "tls", "rsn", "txt"]) {
      expect(raw).toContain(`${KEY}${key}=${VAL}`);
    }
  });

  it("aligns every populated column across Workers", () => {
    const doc = payload({
      workers: [
        worker({ worker_id: "w-1", display: display() }),
        worker({
          worker_id: "worker-long",
          display: display({ runner: "opencode", model: "gpt-5.4", effort: "xhigh", issue: "42", phase: "validating" }),
        }),
      ],
      host: { ...payload().host, worker_count: 2 },
    });
    const rendered = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 260 });
    const rows = rendered.lines.slice(1).map(stripAnsi);

    expect(rows).toHaveLength(2);
    for (const token of ["run=", "org=", "iss=", "coding", "2m5s", "hb=", "loc=", "tks=", "ctx=", "tls=", "rsn=", "txt="]) {
      const starts = rows.map((row) => row.indexOf(token === "coding" ? (row.includes("coding") ? "coding" : "validating") : token));
      expect(starts[0], token).toBeGreaterThanOrEqual(0);
      expect(starts[1], token).toBe(starts[0]);
    }
  });

  it("uses the failure colour for a failed lifecycle cursor", () => {
    const doc = payload({ workers: [worker({ display: display({ failed: true }) })] });
    expect(renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 240 }).lines[1]).toContain(`${RED}✗`);
  });

  it.each([
    ["landing", display({ phase: "merge", origin: "afk" })],
    ["requeue", display({ phase: "validating", origin: "requeue" })],
  ])("omits agent activity cells from a %s row", (_kind, workerDisplay) => {
    const doc = payload({ workers: [worker({ display: workerDisplay })] });
    const row = stripAnsi(renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 240 }).lines[1]!);
    for (const key of ["loc=", "tks=", "tls=", "rsn=", "txt="]) expect(row).not.toContain(key);
    expect(row).toContain("ctx=108k");
    expect(row).toContain("hb=3s");
  });
});

describe("the coloured panel and dashboard (#3152)", () => {
  it("draws the dashboard identity, version, model and header pairs in their palette roles", () => {
    const doc = payload({ workers: [worker({ display: display({ model: "claude-opus-5" }) })] });
    const header = renderRedskilledDashboard(doc, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      project: "acme/widgets",
    }).header.line;

    expect(header).toContain(`${WINE2}${WHITE}${GOLD}»${WHITE} ${BOLD}acme/widgets`);
    expect(header).toContain(`${DIM}v3.3.11${WHITE}`);
    expect(header).toContain(`${WINE}${WHITE}claude·claude-opus-5·high${NOBG}${SOFT}`);
    for (const key of ["wrk", "slots", "reserve", "mem"]) {
      expect(header).toContain(`${KEY}${key}=${VAL}`);
    }
    expect(header.endsWith(RESET)).toBe(true);
  });

  it.each([
    ["healthy", false, BAR_CURRENT],
    ["failed", true, RED],
  ])("draws a %s lifecycle cursor in the same tone at every density", (_state, failed, cursorTone) => {
    const doc = payload({ workers: [worker({ display: display({ failed }) })] });
    const line = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 240 }).lines[1]!;
    const panel = renderRedskilledPanel(doc, {
      ...REDSKILLED_PANEL_DEFAULTS,
      project: "acme/widgets",
      maxWidth: 240,
    }).worker_rows[0]!;
    const dashboard = renderRedskilledDashboard(doc, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      project: "acme/widgets",
      maxWidth: 240,
    }).rows[0]!.line;
    const cursor = failed ? "✗" : "▶";

    for (const row of [line, panel, dashboard]) {
      expect(row).toContain(`${BAR_DONE}██${cursorTone}${cursor}${BAR_AHEAD}░░`);
      expect(row).toContain(`${KEY}eta=${VAL}10m40s`);
    }
  });

  it("keeps dashboard columns aligned after colouring their cells", () => {
    const doc = payload({
      workers: [
        worker({ worker_id: "w-1", display: display() }),
        worker({
          worker_id: "worker-long",
          display: display({ runner: "opencode", model: "gpt-5.4", effort: "xhigh", issue: "42" }),
        }),
      ],
      host: { ...payload().host, worker_count: 2 },
    });
    const rendered = renderRedskilledDashboard(doc, {
      ...REDSKILLED_DASHBOARD_DEFAULTS,
      project: "acme/widgets",
      maxWidth: 260,
    });
    const rows = rendered.rows.map((row) => stripAnsi(row.line));

    expect(rendered.rows[0]!.line).toContain(`${KEY}run=${VAL}`);
    for (const token of ["run=", "org=", "iss=", "eta=", "hb=", "loc=", "tks=", "ctx=", "tls=", "rsn=", "txt="]) {
      expect(rows[0]!.indexOf(token), token).toBeGreaterThanOrEqual(0);
      expect(rows[1]!.indexOf(token), token).toBe(rows[0]!.indexOf(token));
    }
  });
});

describe("stateless, and it opens no transport", () => {
  it("reaches no node builtin from any layout module", () => {
    const root = join(import.meta.dirname, "..");
    const layout = readdirSync(root).filter((name) => name.endsWith(".ts") && name !== "decode.ts");
    expect(layout.length).toBeGreaterThan(4);
    for (const module of layout) {
      expect(readFileSync(join(root, module), "utf8"), module).not.toMatch(/from "node:/);
    }
  });

  it("renders one payload identically however many times it is asked", () => {
    const doc = payload({ workers: [worker({ display: display() })] });
    const once = renderRedskilledDashboard(doc, REDSKILLED_DASHBOARD_DEFAULTS);
    const twice = renderRedskilledDashboard(doc, REDSKILLED_DASHBOARD_DEFAULTS);
    expect(twice).toEqual(once);
  });

  it("states an unreachable host rather than drawing a calm blank", () => {
    const absent = renderRedskilledStatuslineAbsence({ generated_at: "2026-08-03T00:00:00.000Z" });
    expect(absent.line).toBe(REDSKILLED_RENDER_ABSENCE);
    expect(absent.stale).toBe(true);
    expect(absent.project_match).toBe("unanswered");
  });
});

describe("an unknown project's registration history (#3191)", () => {
  const emptyHost = {
    ...payload().host,
    worker_count: 0,
    project_count: 0,
    observed_rss_bytes: 0,
    measured_worker_count: 0,
    ceiling_used_fraction: 0,
  };

  it("carries the pasteable registration repair beside the unregistered head", () => {
    const rendered = renderRedskilledStatusline(
      payload({
        host: emptyHost,
        projects: [],
        workers: [],
        known_projects: [],
        registered_projects: [],
      }),
      { ...LOCAL, maxWidth: 400 },
    );

    expect(rendered.repair).toEqual({
      tool: "project_start",
      args: { runner: "claude", target: 1 },
      why: "register this project with the host so its queue can drain",
    });
    expect(rendered.line).toBe(
      "project unknown — acme/widgets was never registered on this host; repair: call `project_start` with " +
      "`{\"runner\":\"claude\",\"target\":1}` because register this project with the host so its queue can drain v3.3.11",
    );
  });

  it.each([
    [
      "was never registered",
      payload({
        host: emptyHost,
        projects: [],
        workers: [],
        known_projects: [],
        registered_projects: [],
      }),
      "project unknown — acme/widgets was never registered on this host; repair: call `project_start` with " +
        "`{\"runner\":\"claude\",\"target\":1}` because register this project with the host so its queue can drain v3.3.11",
    ],
    [
      "lapsed",
      payload({
        host: emptyHost,
        projects: [],
        workers: [],
        known_projects: ["acme/widgets"],
        registered_projects: [],
        lapsed_projects: [{
          project_label: "acme/widgets",
          at: "2026-08-03T17:36:15.000Z",
          registered_at: "2026-08-03T17:25:30.000Z",
          reason: "nothing renewed it",
        }],
      }),
      "project unknown — acme/widgets lapsed at 17:36:15 (registered 17:25:30); repair: call `project_start` with " +
        "`{\"runner\":\"claude\",\"target\":1}` because register this project with the host so its queue can drain v3.3.11",
    ],
    [
      "was deliberately stopped",
      payload({
        host: emptyHost,
        projects: [],
        workers: [],
        known_projects: ["acme/widgets"],
        registered_projects: [],
        stopped_projects: [{ project_label: "acme/widgets", at: "2026-08-03T17:41:02.000Z" }],
      }),
      "project unknown — acme/widgets was stopped at 17:41:02; repair: call `project_start` with " +
        "`{\"runner\":\"claude\",\"target\":1}` because register this project with the host so its queue can drain v3.3.11",
    ],
    [
      "belongs to an orphaned daemon",
      payload({
        host: emptyHost,
        projects: [],
        workers: [],
        known_projects: ["acme/widgets"],
        registered_projects: [],
        orphaned_projects: ["acme/widgets"],
      }),
      "project unknown — acme/widgets is registered on a daemon this socket does not reach; repair: none because " +
        "this socket cannot safely replace a registration owned by an unreachable daemon v3.3.11",
    ],
  ])("states that it %s", (_history, doc, expected) => {
    const rendered = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 320 });
    expect(rendered.line).toBe(expected);
    if (_history === "belongs to an orphaned daemon") {
      expect(rendered).toMatchObject({
        repair: "none",
        repair_reason: "this socket cannot safely replace a registration owned by an unreachable daemon",
      });
    } else {
      expect(rendered.repair).toMatchObject({
        tool: "project_start",
        args: { runner: "claude", target: 1 },
      });
    }
  });

  it("argues none when this directory has no project identity to register", () => {
    const rendered = renderRedskilledStatusline(
      payload({ host: emptyHost, projects: [], workers: [] }),
      { ...LOCAL, project: null, maxWidth: 320 },
    );

    expect(rendered).toMatchObject({
      project_match: "unresolved",
      repair: "none",
      repair_reason: "the directory must resolve to a project before registration args can be safe",
    });
    expect(rendered.line).toContain(
      "repair: none because the directory must resolve to a project before registration args can be safe",
    );
  });
});

describe("a fixture payload renders identically to a live one", () => {
  it("draws the same line from JSON, from TOON and from an already-decoded value", () => {
    const doc = payload({ workers: [worker({ display: display() })] });
    const fromValue = renderRedskilled(doc, { density: "line", options: { project: "acme/widgets" } });
    const fromJson = renderRedskilled(JSON.stringify(doc), { density: "line", options: { project: "acme/widgets" } });
    const fromToon = renderRedskilled(encodeToon(doc as never), {
      density: "line",
      options: { project: "acme/widgets" },
    });

    expect(fromJson.lines).toEqual(fromValue.lines);
    expect(fromToon.lines).toEqual(fromValue.lines);
    expect(decodeRedskilledPayload(JSON.stringify(doc)).encoding).toBe("json");
    expect(decodeRedskilledPayload(encodeToon(doc as never)).encoding).toBe("toon");
  });

  it("draws the newest record of a line-delimited lane and keeps the history", () => {
    const older = payload({ generated_at: "2026-08-03T00:00:00.000Z" });
    const newer = payload({ generated_at: "2026-08-03T00:05:00.000Z" });
    const lane = `${JSON.stringify(older)}\n${JSON.stringify(newer)}\n`;

    const decoded = decodeRedskilledPayload(lane);
    expect(decoded.encoding).toBe("jsonl");
    expect(decoded.records).toHaveLength(2);
    expect(decoded.payload.generated_at).toBe("2026-08-03T00:05:00.000Z");
  });

  it("skips a torn tail rather than blanking a surface over a race", () => {
    const complete = payload();
    const lane = `${JSON.stringify(complete)}\n{"version":1,"generated_`;
    expect(decodeRedskilledPayload(lane).payload.generated_at).toBe(complete.generated_at);
  });

  it("refuses a document that is not a payload, rather than rendering an idle machine", () => {
    expect(() => decodeRedskilledPayload("")).toThrow(RedskilledRenderDecodeError);
    expect(() => decodeRedskilledPayload('{"hello":"world"}')).toThrow(RedskilledRenderDecodeError);
    expect(() => decodeRedskilledPayload("not a document at all")).toThrow(RedskilledRenderDecodeError);
  });
});

describe("a withheld extra is not a measurement gap", () => {
  it("draws an unmeasured Worker and a withheld one the same, and says which it was", () => {
    const withheld = payload({
      workers: [worker({ vitals: { rss_bytes: null, sampled_at: null, age_ms: null, fresh: false } })],
      withheld: ["vitals", "logs", "display"],
    });
    const panel = renderRedskilledPanel(withheld, { ...REDSKILLED_PANEL_DEFAULTS, project: "acme/widgets" });
    expect(panel.worker_rows[0]).toContain("?");
    // The render prints the honest `?`; the FIELD is what lets a consumer tell a
    // cheap read from a broken sampler.
    expect(withheld.withheld).toContain("vitals");
  });
});

describe("the elapsed span, the context figure and the estimate (#3097)", () => {
  it("derives elapsed from the record's start against the payload's own clock", () => {
    // `uptime_ms` is the PROCESS's age, dated by a daemon that is not told what a
    // work item is. A Worker that finished one issue and took another is one
    // process and two spans, and the row must show the span it is showing.
    const doc = payload({
      generated_at: "2026-08-03T00:30:00.000Z",
      workers: [worker({ uptime_ms: 7_200_000, display: display({ started_at: "2026-08-03T00:20:00.000Z" }) })],
    });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });
    expect(table.rows[0]!.cells.elapsed).toBe("10m0s");
  });

  it("falls back to the process uptime when the project states no start", () => {
    const doc = payload({ workers: [worker({ uptime_ms: 125_000, display: display({ started_at: null }) })] });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });
    expect(table.rows[0]!.cells.elapsed).toBe("2m5s");
  });

  it("prints the estimate and the context the project published", () => {
    const doc = payload({ workers: [worker({ display: display({ eta: 640, context: 108_000 }) })] });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });
    expect(table.rows[0]!.cells.eta).toBe("eta=10m40s");
    expect(table.rows[0]!.cells.ctx).toBe("ctx=108k");
    expect(stripAnsi(table.rows[0]!.line)).toContain("eta=10m40s");
  });

  it("draws NO estimate for a Worker with none — absent is null, never a zero", () => {
    const doc = payload({ workers: [worker({ display: display({ eta: null, context: null }) })] });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });
    const panel = renderRedskilledPanel(doc, { ...REDSKILLED_PANEL_DEFAULTS, project: "acme/widgets" });

    expect(table.rows[0]!.cells.eta).toBe("");
    expect(table.rows[0]!.cells.ctx).toBe("");
    expect(table.rows[0]!.line).not.toContain("eta=");
    expect(panel.worker_rows[0]).not.toContain("eta=");
    // A zero would read as "any second now", which is a claim, not an absence.
    expect(table.rows[0]!.line).not.toContain("eta=0s");
  });

  it("never extrapolates an estimate from the bar it draws beside it", () => {
    // Two Workers at the SAME position in the same pipeline. One published an
    // estimate, the other did not — and the render invents nothing for the second
    // from the bar it just drew for both.
    const doc = payload({
      workers: [
        worker({ worker_id: "w-a", display: display({ phase_index: 2, phase_total: 5, eta: 900 }) }),
        worker({ worker_id: "w-b", display: display({ phase_index: 2, phase_total: 5, eta: null }) }),
      ],
    });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });

    expect(table.rows[0]!.cells.bar).toBe(table.rows[1]!.cells.bar);
    expect(table.rows[0]!.cells.eta).toBe("eta=15m0s");
    expect(table.rows[1]!.cells.eta).toBe("");
  });
});
