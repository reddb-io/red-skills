/**
 * Tests for `cli-args.ts` — code-nav's argument surface stated as a schema over
 * the shared contract (ADR 0114). The CLI smoke suite spawns the binary; this
 * suite pins the parsing answers themselves, which is where a hand-rolled
 * parser used to differ per binary.
 */
import { describe, expect, it } from "vitest";
import {
  CodeNavUsageError,
  isVersionRequest,
  parseCodeNavArgs,
  renderHelp,
} from "../src/cli-args.js";

describe("parseCodeNavArgs", () => {
  it("serves by default when argv is empty", () => {
    expect(parseCodeNavArgs([])).toEqual({
      command: "serve",
      showHelp: false,
      showVersion: false,
      versionJson: false,
    });
  });

  it("routes the explicit `serve` command", () => {
    expect(parseCodeNavArgs(["serve"]).command).toBe("serve");
  });

  it("routes the `version` command and asks for the version answer", () => {
    const args = parseCodeNavArgs(["version"]);
    expect(args.command).toBe("version");
    expect(args.showVersion).toBe(true);
  });

  it("carries --json through the `version` command", () => {
    expect(parseCodeNavArgs(["version", "--json"]).versionJson).toBe(true);
  });

  it("accepts both spellings of the version flag", () => {
    expect(parseCodeNavArgs(["--version"]).showVersion).toBe(true);
    expect(parseCodeNavArgs(["-v"]).showVersion).toBe(true);
  });

  it("accepts both spellings of the help flag", () => {
    expect(parseCodeNavArgs(["--help"]).showHelp).toBe(true);
    expect(parseCodeNavArgs(["-h"]).showHelp).toBe(true);
  });

  it("routes a flag-led invocation to the default command without dropping flags", () => {
    const args = parseCodeNavArgs(["--version", "--json"]);
    expect(args.command).toBe("serve");
    expect(args.showVersion).toBe(true);
    expect(args.versionJson).toBe(true);
  });

  it("names an unknown flag instead of silently ignoring it", () => {
    expect(() => parseCodeNavArgs(["--bogus"])).toThrow(CodeNavUsageError);
    expect(() => parseCodeNavArgs(["--bogus"])).toThrow(/unknown flag '--bogus'/);
  });

  it("names a typo'd command rather than serving anyway", () => {
    expect(() => parseCodeNavArgs(["serv"])).toThrow(CodeNavUsageError);
    expect(() => parseCodeNavArgs(["serv"])).toThrow(/unknown command 'serv'/);
  });

  it("rejects a stray positional after a known command", () => {
    expect(() => parseCodeNavArgs(["serve", "extra"])).toThrow(
      /unexpected argument 'extra'/,
    );
  });
});

describe("isVersionRequest", () => {
  it("recognises a leading version token and nothing else", () => {
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["-v", "--json"])).toBe(true);
    expect(isVersionRequest(["version"])).toBe(true);
    expect(isVersionRequest(["serve"])).toBe(false);
    expect(isVersionRequest([])).toBe(false);
  });
});

describe("renderHelp", () => {
  it("documents the routed commands and every declared flag", () => {
    const help = renderHelp();
    expect(help).toContain("code-nav");
    expect(help).toContain("serve");
    expect(help).toContain("--version");
    expect(help).toContain("--json");
    expect(help).toContain("--help");
    expect(help).toContain("CODE_NAV_ROOT");
    expect(help).toContain("CODE_NAV_SERVERS");
  });
});
