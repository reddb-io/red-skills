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
} from "../index.js";
import { display, payload, worker } from "./fixture.js";

const LOCAL = { ...REDSKILLED_STATUSLINE_DEFAULTS, project: "acme/widgets" };

describe("one module, three densities", () => {
  it("draws the same payload at a line, a panel and a table", () => {
    const doc = payload({ workers: [worker({ display: display() })] });

    const line = renderRedskilledStatusline(doc, LOCAL);
    const panel = renderRedskilledPanel(doc, { ...REDSKILLED_PANEL_DEFAULTS, project: "acme/widgets" });
    const table = renderRedskilledDashboard(doc, { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets" });

    expect(line.lines).toHaveLength(1);
    expect(line.line).toContain("acme/widgets 1w");
    // The panel's FIRST row is the line density's own output, not a second
    // spelling of it — the composition is the no-drift guarantee.
    expect(panel.head.line).toBe(panel.lines[0]);
    expect(panel.lines.length).toBeGreaterThan(line.lines.length);
    expect(panel.worker_rows[0]).toContain("w-1");
    expect(table.rows).toHaveLength(1);
    expect(table.header.line).toContain("wrk=1/1");
  });

  it("routes a density by name through the one entry point", () => {
    const doc = payload();
    const drawn = renderRedskilled(doc, { density: "panel", options: { project: "acme/widgets" } });
    expect(drawn.density).toBe("panel");
    expect(drawn.lines[0]).toContain("acme/widgets");
    expect(renderRedskilled(doc, { density: "line", options: { project: "acme/widgets" } }).lines)
      .toEqual(renderRedskilledStatusline(doc, LOCAL).lines);
  });

  it("degrades a crowded line down the shared ladder rather than overflowing", () => {
    const workers = Array.from({ length: 3 }, (_, index) => worker({ worker_id: `w-${index}` }));
    const doc = payload({ workers, host: { ...payload().host, worker_count: 3 } });
    const narrow = renderRedskilledStatusline(doc, { ...LOCAL, maxWidth: 40 });
    expect(narrow.detail).toBe("host");
    expect(narrow.degraded).toBe(true);
    expect([...narrow.line].length).toBeLessThanOrEqual(40);

    // The ladder is layout, and it now lives beside every density rather than
    // inside one of them.
    expect(detailLadder({ mode: "global", maxWorkers: 2, maxProjects: 4, workers, projects: doc.projects }))
      .toEqual(["projects", "host"]);
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
