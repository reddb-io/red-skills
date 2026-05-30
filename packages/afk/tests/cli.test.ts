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
});
