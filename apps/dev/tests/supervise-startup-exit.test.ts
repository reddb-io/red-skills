import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCastleLaneWriters, createEnginePaths } from "@reddb-io/red-castle/engine";

vi.mock("../src/core/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/config.js")>();
  return {
    ...actual,
    loadConfig: () => {
      throw new Error("injected post-lock startup failure");
    },
  };
});

const { superviseCommand } = await import("../src/commands/supervise.js");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("supervisor startup terminal record (#2442)", () => {
  it("records an exception raised after acquiring the pinned pid lock", async () => {
    const root = mkdtempSync(join(tmpdir(), "supervise-startup-exit-"));
    roots.push(root);
    await expect(superviseCommand([], root)).rejects.toThrow("injected post-lock startup failure");

    const lane = createCastleLaneWriters(createEnginePaths(join(root, ".red")))
      .supervisor(join("default", `s${process.pid}`));
    const rows = readFileSync(lane.path, "utf8");
    expect(rows).toContain("supervisor.exit");
    expect(rows).toContain("exception");
  });
});
