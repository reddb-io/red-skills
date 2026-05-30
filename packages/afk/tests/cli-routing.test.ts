import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";

describe("cli routing — native commands", () => {
  it("routes reap and __supervise without changing their args", () => {
    expect(parseCli(["reap"])).toEqual({ command: "reap", args: [] });
    expect(parseCli(["__supervise", "3"])).toEqual({ command: "__supervise", args: ["3"] });
  });

  it("still defaults bare args to run", () => {
    expect(parseCli(["-n", "0"])).toEqual({ command: "run", args: ["-n", "0"] });
  });
});
