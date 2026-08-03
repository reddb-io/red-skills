// `redskilled dashboard` — the host view a terminal can read (#3098).
//
// The same payload and the same render as the statusline, at a taller density
// (ADR 0132 decision 1). Layout moved out of the daemon so four surfaces could
// differ in HEIGHT without differing in content, so this asks for a density
// rather than importing a second renderer.
import { describe, expect, it } from "vitest";
import { REDSKILLED_USAGE, runDashboard } from "../src/cli.js";
import { resolveRedskilledPaths } from "../src/paths.js";

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, write: (l: string) => out.push(l), warn: (l: string) => err.push(l) };
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
