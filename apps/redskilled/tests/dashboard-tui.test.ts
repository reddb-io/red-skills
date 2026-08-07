import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { renderOnce } from "tuiuiu.js/minimal";
import {
  redskilledDashboardFrame,
  runRedskilledDashboardTui,
} from "../src/dashboard-tui.js";

describe("the dashboard TUI frame", () => {
  it("keeps the operating data above a persistent command footer", () => {
    const frame = renderOnce(
      redskilledDashboardFrame({
        lines: ["tk/h=12k  Tickets/h=4", "tokens 48h ▁▂▃", "Workers", "hE215 coding"],
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
        lines: ["one", "two", "three", "four"],
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
    const readFrame = vi.fn(async () => ["frame"]);

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
