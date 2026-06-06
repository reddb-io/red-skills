import { describe, expect, it } from "vitest";
import { parseCli } from "../src/cli.js";

describe("cli routing — native commands", () => {
  it("routes reap and __supervise without changing their args", () => {
    expect(parseCli(["reap"])).toEqual({ command: "reap", args: [] });
    expect(parseCli(["__supervise", "3"])).toEqual({ command: "__supervise", args: ["3"] });
  });

  it("routes ship as an interactive landing command", () => {
    expect(parseCli(["ship", "--issue", "395"])).toEqual({ command: "ship", args: ["--issue", "395"] });
  });

  it("routes retake as an issue resumption command", () => {
    expect(parseCli(["retake", "#395", "--json"])).toEqual({ command: "retake", args: ["#395", "--json"] });
  });

  it("routes statusline with the project-root arg preserved", () => {
    expect(parseCli(["statusline", "/repo"])).toEqual({ command: "statusline", args: ["/repo"] });
  });

  it("routes dashboard with reporting flags preserved", () => {
    expect(parseCli(["dashboard", "--period", "14d", "--json"])).toEqual({
      command: "dashboard",
      args: ["--period", "14d", "--json"],
    });
  });

  it("routes daily and weekly review commands", () => {
    expect(parseCli(["daily-review", "--json"])).toEqual({ command: "daily-review", args: ["--json"] });
    expect(parseCli(["weekly-review"])).toEqual({ command: "weekly-review", args: [] });
  });

  it("routes the development-workflow injector with its args preserved", () => {
    expect(parseCli(["inject-development-workflow", "--root", "/repo"])).toEqual({
      command: "inject-development-workflow",
      args: ["--root", "/repo"],
    });
  });

  it("routes version flags before the default run command", () => {
    expect(parseCli(["--version"])).toEqual({ command: "version", args: [] });
    expect(parseCli(["-v", "--json"])).toEqual({ command: "version", args: ["--json"] });
    expect(parseCli(["version", "--json"])).toEqual({ command: "version", args: ["--json"] });
  });

  it("still defaults bare args to run", () => {
    expect(parseCli(["-n", "0"])).toEqual({ command: "run", args: ["-n", "0"] });
  });
});
