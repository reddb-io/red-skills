/**
 * Tests for `cli-args.ts` — opencode-host's argument surface stated as a
 * schema over the shared contract (ADR 0114). The CLI smoke suite spawns the
 * binary; this suite pins the parsing answers themselves, which is where a
 * hand-rolled parser used to differ per binary.
 */
import { describe, expect, it } from "vitest";
import {
  OpencodeHostUsageError,
  isVersionRequest,
  parseOpencodeHostArgs,
  renderHelp,
} from "../src/cli-args.js";

describe("parseOpencodeHostArgs", () => {
  it("defaults every path when argv is empty", () => {
    expect(parseOpencodeHostArgs([])).toEqual({
      command: "generate",
      configPath: "./.red/config.yaml",
      outPath: "./opencode.json",
      outDir: "./dist/opencode",
      pluginsRoot: "./plugins",
      showHelp: false,
      showVersion: false,
      versionJson: false,
      printJson: false,
      copySkills: false,
      pluginFilter: null,
      slice2: true,
    });
  });

  it("routes the explicit `generate` command and still parses its flags", () => {
    const args = parseOpencodeHostArgs(["generate", "--config", "a.yaml"]);
    expect(args.command).toBe("generate");
    expect(args.configPath).toBe("a.yaml");
  });

  it("routes a flag-led invocation to the default command without dropping flags", () => {
    expect(parseOpencodeHostArgs(["--config", "a.yaml"]).configPath).toBe("a.yaml");
  });

  it("accepts long, short, and inline spellings of the same flag", () => {
    expect(parseOpencodeHostArgs(["--config", "a.yaml"]).configPath).toBe("a.yaml");
    expect(parseOpencodeHostArgs(["-c", "a.yaml"]).configPath).toBe("a.yaml");
    expect(parseOpencodeHostArgs(["--config=a.yaml"]).configPath).toBe("a.yaml");
  });

  it("maps the remaining path flags onto their fields", () => {
    const args = parseOpencodeHostArgs([
      "--out",
      "o.json",
      "-d",
      "dist/x",
      "--plugins-root",
      "p",
      "--copy",
      "--print",
    ]);
    expect(args.outPath).toBe("o.json");
    expect(args.outDir).toBe("dist/x");
    expect(args.pluginsRoot).toBe("p");
    expect(args.copySkills).toBe(true);
    expect(args.printJson).toBe(true);
  });

  it("accumulates repeated --plugin occurrences in order", () => {
    expect(parseOpencodeHostArgs(["--plugin", "dev", "--plugin", "memory"]).pluginFilter).toEqual([
      "dev",
      "memory",
    ]);
  });

  it("keeps Slice 2 on by default, off under --no-slice-2, on under the compatibility spellings", () => {
    expect(parseOpencodeHostArgs([]).slice2).toBe(true);
    expect(parseOpencodeHostArgs(["--no-slice-2"]).slice2).toBe(false);
    expect(parseOpencodeHostArgs(["--slice-2"]).slice2).toBe(true);
    expect(parseOpencodeHostArgs(["--with-slice-2"]).slice2).toBe(true);
  });

  it("reads --help/-h and --version/-v/--json off the schema", () => {
    expect(parseOpencodeHostArgs(["--help"]).showHelp).toBe(true);
    expect(parseOpencodeHostArgs(["-h"]).showHelp).toBe(true);
    expect(parseOpencodeHostArgs(["--version"]).showVersion).toBe(true);
    expect(parseOpencodeHostArgs(["-v"]).showVersion).toBe(true);
    expect(parseOpencodeHostArgs(["--version", "--json"]).versionJson).toBe(true);
    expect(parseOpencodeHostArgs(["--config", "a.yaml", "--version"]).showVersion).toBe(true);
  });

  it("fails with a message naming the unknown flag", () => {
    expect(() => parseOpencodeHostArgs(["--bogus"])).toThrow(OpencodeHostUsageError);
    expect(() => parseOpencodeHostArgs(["--bogus"])).toThrow(/unknown flag '--bogus'/);
    expect(() => parseOpencodeHostArgs(["-z"])).toThrow(/unknown flag '-z'/);
  });

  it("fails when a value flag is missing its value", () => {
    expect(() => parseOpencodeHostArgs(["--config"])).toThrow(OpencodeHostUsageError);
    expect(() => parseOpencodeHostArgs(["--config"])).toThrow(/--config requires a value/);
  });

  it("fails on an unknown command rather than treating it as a flagless default", () => {
    expect(() => parseOpencodeHostArgs(["emitt"])).toThrow(/unknown command 'emitt'/);
  });

  it("fails on a stray positional after the command", () => {
    expect(() => parseOpencodeHostArgs(["generate", "stray"])).toThrow(/unexpected argument 'stray'/);
  });
});

describe("isVersionRequest", () => {
  it("recognises the leading version tokens only", () => {
    expect(isVersionRequest(["--version"])).toBe(true);
    expect(isVersionRequest(["-v", "--json"])).toBe(true);
    expect(isVersionRequest(["--config", "a.yaml"])).toBe(false);
    expect(isVersionRequest([])).toBe(false);
  });
});

describe("renderHelp", () => {
  it("documents every declared flag", () => {
    const help = renderHelp();
    for (const flag of [
      "--config",
      "--out",
      "--out-dir",
      "--plugins-root",
      "--plugin",
      "--copy",
      "--print",
      "--no-slice-2",
      "--version",
      "--json",
      "--help",
    ]) {
      expect(help).toContain(flag);
    }
  });
});
