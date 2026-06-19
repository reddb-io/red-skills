import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";

describe("cli parser", () => {
  it("preserves the legacy default /afk interface", () => {
    expect(parseCli(["--runner", "codex", "--once"])).toEqual({ command: "run", args: ["--runner", "codex", "--once"] });
    expect(parseCli(["run", "--once"])).toEqual({ command: "run", args: ["--once"] });
  });

  it("routes monitor and fleet subcommands without changing their args", () => {
    expect(parseCli(["monitor", "--once"])).toEqual({ command: "monitor", args: ["--once"] });
    expect(parseCli(["fleet", "3", "--runner", "claude"])).toEqual({ command: "fleet", args: ["3", "--runner", "claude"] });
    expect(parseCli(["fleet", "stop"])).toEqual({ command: "fleet", args: ["stop"] });
  });

  it("routes the trust-gated triage subcommand without changing its args", () => {
    expect(parseCli(["triage", "42", "--decision", "ready-for-agent"])).toEqual({
      command: "triage",
      args: ["42", "--decision", "ready-for-agent"],
    });
    expect(parseCli(["triage", "99", "--summon"])).toEqual({ command: "triage", args: ["99", "--summon"] });
  });
});
