import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@reddb-io/toon";
import { beforeEach, describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";
import { managerCommand } from "../src/commands/manager.js";
import { readEffort } from "../src/core/manager/effort-store.js";

let root: string;
let out: string[];
let err: string[];

function deps(at?: string): Parameters<typeof managerCommand>[1] {
  return {
    root,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
    // Pinned when a test starts two efforts, so "newest" never rides on two
    // real timestamps landing in the same millisecond.
    now: at ? () => new Date(at) : undefined,
  };
}

function brief(): Record<string, unknown> {
  return decode(out.join("")) as Record<string, unknown>;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "manager-command-"));
  out = [];
  err = [];
});

describe("manager <intent>", () => {
  it("starts an effort, persists it, and prints its brief", async () => {
    expect(await managerCommand(["ship the walking skeleton"], deps())).toBe(0);
    const rendered = brief();
    expect(rendered.kind).toBe("manager.brief");
    expect(rendered.lifecycle).toBe("inbox");
    expect(rendered.intent).toBe("ship the walking skeleton");

    const stored = await readEffort(root, String(rendered.effort_id));
    expect(stored?.intent).toBe("ship the walking skeleton");
    expect(stored?.generation).toBe(1);
  });

  it("joins a multi-word intent that the shell split into separate args", async () => {
    expect(await managerCommand(["ship", "the", "skeleton"], deps())).toBe(0);
    expect(brief().intent).toBe("ship the skeleton");
  });

  it("refuses an empty invocation with usage instead of minting a nameless effort", async () => {
    expect(await managerCommand([], deps())).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/usage/i);
  });
});

describe("manager status", () => {
  it("renders the most recently started effort", async () => {
    await managerCommand(["first intent"], deps("2026-07-21T00:00:00.000Z"));
    out = [];
    await managerCommand(["second intent"], deps("2026-07-21T01:00:00.000Z"));
    const second = brief();
    out = [];

    expect(await managerCommand(["status"], deps())).toBe(0);
    expect(brief().effort_id).toBe(second.effort_id);
  });

  it("renders a named effort by its id", async () => {
    await managerCommand(["first intent"], deps("2026-07-21T00:00:00.000Z"));
    const first = brief();
    out = [];
    await managerCommand(["second intent"], deps("2026-07-21T01:00:00.000Z"));
    out = [];

    expect(await managerCommand(["status", String(first.effort_id)], deps())).toBe(0);
    expect(brief().intent).toBe("first intent");
  });

  it("reports an unknown effort id instead of falling back to another effort", async () => {
    await managerCommand(["first intent"], deps());
    out = [];
    expect(await managerCommand(["status", "eff_zzzzzzzzzzzzzzzzzzzzzzzzzz"], deps())).toBe(1);
    expect(out).toEqual([]);
    expect(err.join("")).toMatch(/eff_zzzz/);
  });

  it("renders an empty brief when the portfolio holds no effort", async () => {
    expect(await managerCommand(["status"], deps())).toBe(0);
    expect(brief()).toEqual({ kind: "manager.brief", state_source: "owned", efforts: 0 });
  });
});

describe("cli routing", () => {
  it("routes manager with its intent preserved", () => {
    expect(parseCli(["manager", "ship", "the", "skeleton"])).toEqual({
      command: "manager",
      args: ["ship", "the", "skeleton"],
    });
    expect(parseCli(["manager", "status"])).toEqual({ command: "manager", args: ["status"] });
  });
});
