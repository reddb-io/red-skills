import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { renderOnce } from "tuiuiu.js/minimal";
import {
  renderRedskilledDashboard,
  REDSKILLED_DASHBOARD_DEFAULTS,
} from "@reddb-io/redskilled-render";
import {
  display,
  payload,
  worker,
} from "../../../packages/redskilled-render/tests/fixture.js";
import {
  redskilledDashboardFrame,
  runRedskilledDashboardTui,
} from "../src/dashboard-tui.js";

const BOX_DRAWING_CHARACTER = /[\u2500-\u257f]/u;

function expectBorderlessTable(
  frame: string,
  columns: number,
  header: RegExp,
  row: RegExp,
): void {
  const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
  const lines = plain.split("\n");
  const headerIndex = lines.findIndex((line) => header.test(line));
  const rowIndex = lines.findIndex((line) => row.test(line));
  expect(plain).not.toMatch(BOX_DRAWING_CHARACTER);
  expect(headerIndex).toBe(2);
  expect(rowIndex).toBe(headerIndex + 1);
  expect(lines.every((line) => line.length <= columns)).toBe(true);
}

describe("the dashboard TUI frame", () => {
  it("keeps the operating data above a persistent command footer", () => {
    const frame = renderOnce(
      redskilledDashboardFrame({
        frame: { lines: ["tk/h=12k  Tickets/h=4", "tokens 48h ▁▂▃", "Workers", "hE215 coding"] },
        columns: 80,
        rows: 5,
        showDeathDetails: false,
      }),
      80,
    );

    const plain = frame.replace(/\x1b\[[0-9;]*m/g, "");
    expect(plain.split("\n")).toEqual([
      "tk/h=12k  Tickets/h=4",
      "tokens 48h ▁▂▃",
      "Workers",
      "hE215 coding",
      "q quit · r refresh · v deaths: summary · live 1s",
    ]);
  });

  it("clips the body before it can overwrite the footer", () => {
    const frame = renderOnce(
      redskilledDashboardFrame({
        frame: { lines: ["one", "two", "three", "four"] },
        columns: 20,
        rows: 3,
        showDeathDetails: true,
      }),
      20,
    );

    expect(frame.split("\n")).toHaveLength(3);
    expect(frame).toContain("one");
    expect(frame).toContain("two");
    expect(frame).toContain("q quit");
    expect(frame).not.toContain("three");
  });

  it("paints the shared operational table on a wide terminal", () => {
    const dashboard = renderRedskilledDashboard(
      payload({
        workers: [worker({
          display: display({ runner: "codex", issue: "3495", phase: "validating", step: "tests" }),
          log: { last_line: "running focused checks", published_at: "2026-08-03T00:02:00.000Z" },
        })],
      }),
      { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets", maxWidth: 120 },
    );
    const markedDashboard = {
      ...dashboard,
      table: {
        ...dashboard.table!,
        rows: [{
          worker: "A",
          issue: "B",
          runner: "C",
          phase: "D",
          progress: "E",
          elapsed: "F",
          eta: "G",
          activity: "H",
        }],
      },
    };
    const frame = renderOnce(
      redskilledDashboardFrame({
        frame: { lines: dashboard.lines, dashboard: markedDashboard },
        columns: 120,
        rows: 12,
        showDeathDetails: false,
        noColor: true,
      }),
      120,
    );

    expect(frame).toContain("Worker");
    expect(frame).toContain("Issue");
    expect(frame).toContain("Runner");
    expect(frame).toContain("Phase");
    expect(frame).toContain("Activity");
    expect(frame).not.toContain("run=codex");
    expect(frame).toContain("\x1b[1m");
    expectBorderlessTable(
      frame,
      120,
      /Worker +Issue +Runner +Phase +Progress +Clocks +ETA +Activity/u,
      /A +B +C +D +E +F +G +H/u,
    );
  });

  it("paints the grouped table on a narrow terminal", () => {
    const dashboard = renderRedskilledDashboard(
      payload({ workers: [worker({ display: display({ issue: "3495", phase: "validating" }) })] }),
      { ...REDSKILLED_DASHBOARD_DEFAULTS, project: "acme/widgets", maxWidth: 80 },
    );
    const markedDashboard = {
      ...dashboard,
      table: {
        ...dashboard.table!,
        rows: [{ worker: "A", work: "B", state: "C", activity: "D" }],
      },
    };
    const frame = renderOnce(
      redskilledDashboardFrame({
        frame: { lines: dashboard.lines, dashboard: markedDashboard },
        columns: 80,
        rows: 12,
        showDeathDetails: false,
        noColor: true,
      }),
      80,
    );

    expect(frame).toContain("Worker");
    expect(frame).toContain("Work");
    expect(frame).toContain("State");
    expect(frame).toContain("Latest activity");
    expect(frame).not.toContain("Runner");
    expect(frame).toContain("\x1b[1m");
    expectBorderlessTable(
      frame,
      80,
      /Worker +Work +State +Latest activity/u,
      /A +B +C +D/u,
    );
  });
});

describe("the dashboard TUI lifecycle", () => {
  it("owns one alternate screen, refreshes, accepts q, and restores the terminal", async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    Object.defineProperties(stdin, {
      isTTY: { value: true },
      setRawMode: { value: vi.fn() },
    });
    Object.defineProperties(stdout, {
      isTTY: { value: true },
      columns: { value: 72, writable: true },
      rows: { value: 12, writable: true },
    });
    const chunks: string[] = [];
    stdout.on("data", (chunk) => chunks.push(chunk.toString()));
    const readFrame = vi.fn(async () => ({ lines: ["frame"] }));

    const running = runRedskilledDashboardTui({
      stdin,
      stdout,
      readFrame,
      refreshMs: 10_000,
      initialShowDeathDetails: false,
    });
    await vi.waitFor(() => expect(chunks.join("")).toContain("frame"));
    stdin.emit("data", Buffer.from("q"));
    await running;

    const output = chunks.join("");
    expect(output).toContain("\x1b[?1049h");
    expect(output).toContain("frame");
    expect(output).toContain("\x1b[?1049l");
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
  });
});
