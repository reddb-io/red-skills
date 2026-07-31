import { describe, expect, it, vi } from "vitest";
import { HelpRequested, main, parseCli } from "../src/cli.js";
import { UnknownCommandError } from "@reddb-io/shared/args.js";

describe("cli parser", () => {
  it("preserves the legacy default /afk interface", () => {
    expect(parseCli(["--runner", "codex", "--once"])).toEqual({ command: "run", args: ["--runner", "codex", "--once"] });
    expect(parseCli(["run", "--once"])).toEqual({ command: "run", args: ["--once"] });
  });

  it("routes the monitor subcommand without changing its args", () => {
    expect(parseCli(["monitor", "--once"])).toEqual({ command: "monitor", args: ["--once"] });
  });

  // ADR 0130 Amendment 4 removed the per-project process, and `fleet` was its
  // launcher (#2909). A stale invocation is refused by name rather than routed.
  it("refuses the removed fleet launcher instead of routing it", () => {
    expect(() => parseCli(["fleet", "3", "--runner", "claude"])).toThrow(/unknown command 'fleet'/);
  });

  it("routes the trust-gated triage subcommand without changing its args", () => {
    expect(parseCli(["triage", "42", "--decision", "ready-for-agent"])).toEqual({
      command: "triage",
      args: ["42", "--decision", "ready-for-agent"],
    });
    expect(parseCli(["triage", "99", "--summon"])).toEqual({ command: "triage", args: ["99", "--summon"] });
  });

  it("routes rsp-instructions as a dev maintenance command", () => {
    expect(parseCli(["rsp-instructions", "--runner", "codex", "--hook"])).toEqual({
      command: "rsp-instructions",
      args: ["--runner", "codex", "--hook"],
    });
  });

  it("routes afk-output-shaping as a dev report command", () => {
    expect(parseCli(["afk-output-shaping", "--human"])).toEqual({
      command: "afk-output-shaping",
      args: ["--human"],
    });
  });
});

describe("top-level help and unknown flags never boot a worker (#2581)", () => {
  it("--help / -h / help short-circuit before any routing", () => {
    for (const argv of [["--help"], ["-h"], ["help"]]) {
      expect(() => parseCli(argv)).toThrow(HelpRequested);
    }
  });

  it("main prints usage and exits 0 on --help", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main(["--help"])).resolves.toBe(0);
      expect(String(write.mock.calls[0]![0])).toContain("Usage: red-skills-dev");
    } finally {
      write.mockRestore();
    }
  });

  it("an unknown leading flag errors instead of silently draining the queue", () => {
    expect(() => parseCli(["--definitely-not-a-flag"])).toThrow(UnknownCommandError);
  });

  it("the documented run-surface flags still route to the run default", () => {
    expect(parseCli(["--issues", "42"])).toEqual({ command: "run", args: ["--issues", "42"] });
    expect(parseCli(["--spec", "7"])).toEqual({ command: "run", args: ["--spec", "7"] });
  });

  it("<command> --help exits 0 without dispatching the command", async () => {
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await expect(main(["requeue", "--help"])).resolves.toBe(0);
      expect(String(write.mock.calls[0]![0])).toContain("red-skills-dev requeue");
    } finally {
      write.mockRestore();
    }
  });
});
