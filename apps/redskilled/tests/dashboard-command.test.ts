// `redskilled dashboard` — the host view a terminal can read (#3098).
//
// The same payload and the same render as the statusline, at a taller density
// (ADR 0132 decision 1). Layout moved out of the daemon so four surfaces could
// differ in HEIGHT without differing in content, so this asks for a density
// rather than importing a second renderer.
import { describe, expect, it } from "vitest";
import { REDSKILLED_USAGE, runDashboard } from "../src/cli.js";
import { resolveRedskilledPaths } from "../src/paths.js";
import type { RedskilledDashboard, RedskilledDashboardOptions } from "@reddb-io/redskilled-render";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (l: string) => out.push(l), warn: (l: string) => err.push(l) };
}

function rendered(line: string): RedskilledDashboard {
  return { lines: [line] } as unknown as RedskilledDashboard;
}

describe("the dashboard is reachable before anything works", () => {
  it("is named in the front-door usage", () => {
    // A shipped binary answers --help without a working machine, and a
    // subcommand nobody can discover is one nobody uses.
    expect(REDSKILLED_USAGE).toContain("dashboard");
  });

  it("names the scope word the statusline uses, not a second vocabulary", () => {
    // `global` means here exactly what it means there; two spellings of one
    // scope is how a second vocabulary starts.
    expect(REDSKILLED_USAGE).toContain("dashboard [global]");
  });
});

describe("the dashboard always answers", () => {
  it("takes one snapshot in a pipe", async () => {
    const io = capture();
    let reads = 0;
    await runDashboard(["global"], {
      write: io.write,
      warn: io.warn,
      cwd: "/",
      terminal: null,
      readDashboard: async () => rendered(`snapshot-${++reads}`),
    });

    expect(reads).toBe(1);
    expect(io.out.join("")).toBe("snapshot-1\n");
  });

  it("keeps one stable TTY frame, reacts to resize, and restores the cursor", async () => {
    const io = capture();
    const sizes = [{ columns: 100, rows: 8 }, { columns: 72, rows: 5 }];
    const asked: Partial<RedskilledDashboardOptions>[] = [];
    let frame = 0;
    await runDashboard(["global", "--verbose"], {
      write: io.write,
      warn: io.warn,
      cwd: "/",
      terminal: {
        size: () => sizes[Math.min(frame, sizes.length - 1)]!,
        next: async () => frame++ === 0 ? "resize" : "stop",
      },
      readDashboard: async (_paths, options) => {
        asked.push(options ?? {});
        return rendered(`frame-${asked.length}`);
      },
    });

    expect(asked).toEqual([
      expect.objectContaining({ mode: "global", maxWidth: 100, maxHeight: 8, maxRows: 3, showDeathDetails: true }),
      expect.objectContaining({ mode: "global", maxWidth: 72, maxHeight: 5, maxRows: 0, showDeathDetails: true }),
    ]);
    const output = io.out.join("");
    expect(output).toContain("\x1b[?25l\x1b[2J");
    expect(output.match(/\x1b\[Hframe-/g)).toHaveLength(2);
    expect(output).toMatch(/\x1b\[\?25h$/);
  });

  it("strips renderer colour when NO_COLOR is present", async () => {
    const io = capture();
    await runDashboard([], {
      write: io.write,
      warn: io.warn,
      cwd: "/",
      terminal: null,
      env: { NO_COLOR: "1" },
      readDashboard: async () => rendered("\x1b[31mplain\x1b[0m"),
    });
    expect(io.out.join("")).toBe("plain\n");
  });

  it("writes a stated absence and exits 0 when no daemon answers", async () => {
    // A dashboard that printed nothing is indistinguishable from a host with no
    // Workers — and an operator reaching for it is usually already trying to
    // find out why something is quiet.
    const io = capture();
    const code = await runDashboard([], {
      paths: resolveRedskilledPaths({ env: { XDG_RUNTIME_DIR: "/nonexistent-for-this-test" } }),
      write: io.write,
      warn: io.warn,
      // No spawn, no wait: this test is about what the command WRITES when
      // the host is not there, not about how long it is willing to wait.
      client: { serverCommand: "/nonexistent-daemon-for-this-test", readyTimeoutMs: 200, requestTimeoutMs: 200 },
      cwd: "/",
    });
    expect(code).toBe(0);
    expect(io.out.join("")).toContain("unreachable");
    expect(io.out.join("")).toMatch(/\n$/);
  });

  it("says why on stderr while still writing to stdout", async () => {
    const io = capture();
    await runDashboard([], {
      paths: resolveRedskilledPaths({ env: { XDG_RUNTIME_DIR: "/nonexistent-for-this-test" } }),
      write: io.write,
      warn: io.warn,
      // No spawn, no wait: this test is about what the command WRITES when
      // the host is not there, not about how long it is willing to wait.
      client: { serverCommand: "/nonexistent-daemon-for-this-test", readyTimeoutMs: 200, requestTimeoutMs: 200 },
      cwd: "/",
    });
    expect(io.err.join("")).toContain("redskilled dashboard:");
    expect(io.out.length).toBeGreaterThan(0);
  });
});
