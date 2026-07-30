import { describe, expect, it } from "vitest";
import {
  parseFlags,
  parseLooseArgs,
  routeCommand,
  UnknownCommandError,
  UnknownFlagError,
  type FlagSchema,
  type RouterSchema,
} from "./args.js";

const SCHEMA = {
  prd: { kind: "value", coerce: (raw: string) => Number(raw) },
  issues: {
    kind: "value",
    coerce: (raw: string) => raw.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n)),
  },
  n: { kind: "value", coerce: (raw: string) => Number(raw) },
  once: { kind: "boolean" },
  verbose: { kind: "boolean", aliases: ["v"] },
  offset: { kind: "value", coerce: (raw: string) => Number(raw) },
  runner: { kind: "value", coerce: (raw: string) => raw },
  request: { kind: "value", aliases: ["r"], coerce: (raw: string) => raw },
} satisfies FlagSchema;

const REPEATED_SCHEMA = {
  change: { kind: "value", type: "array", aliases: ["c"], coerce: (raw: string) => raw },
} satisfies FlagSchema;

describe("parseFlags", () => {
  it("returns empty values and positionals for empty argv", () => {
    expect(parseFlags([], SCHEMA)).toEqual({ values: {}, positionals: [] });
  });

  it("sets boolean flags to true only when present", () => {
    expect(parseFlags(["--once"], SCHEMA).values.once).toBe(true);
    expect(parseFlags([], SCHEMA).values.once).toBeUndefined();
  });

  it("parses a value flag with a following token (--flag value)", () => {
    expect(parseFlags(["--prd", "42"], SCHEMA).values.prd).toBe(42);
  });

  it("parses a value flag with inline value (--flag=value)", () => {
    expect(parseFlags(["--prd=7"], SCHEMA).values.prd).toBe(7);
  });

  it("applies the coercion (issues → ordered finite number list, trimmed)", () => {
    expect(parseFlags(["--issues", "3,1,2"], SCHEMA).values.issues).toEqual([3, 1, 2]);
    expect(parseFlags(["--issues=10, 20"], SCHEMA).values.issues).toEqual([10, 20]);
  });

  it("keeps numeric zero values (-n 0)", () => {
    expect(parseFlags(["-n", "0"], SCHEMA).values.n).toBe(0);
  });

  it("resolves short aliases (-r → request)", () => {
    expect(parseFlags(["-r", "go"], SCHEMA).values.request).toBe("go");
  });

  it("throws '<flag> requires a value' when a value flag has no argument", () => {
    expect(() => parseFlags(["--prd"], SCHEMA)).toThrow("--prd requires a value");
  });

  it("lets the last occurrence of a scalar flag win", () => {
    expect(parseFlags(["--runner", "claude", "--runner", "codex"], SCHEMA).values.runner).toBe("codex");
  });

  it("accumulates repeated value flags when the schema opts into an array", () => {
    expect(parseFlags(["--change", "alpha", "-c", "beta", "--change=gamma"], REPEATED_SCHEMA).values.change).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
  });

  it("preserves each raw array occurrence without splitting or coercing it", () => {
    expect(parseFlags(["--change=a,b", "--change=001"], REPEATED_SCHEMA).values.change).toEqual(["a,b", "001"]);
  });

  it("ignores unknown flags rather than throwing", () => {
    expect(parseFlags(["--unknown", "x", "--once"], SCHEMA).values.once).toBe(true);
  });

  it("parses a mixed run-style invocation", () => {
    const { values } = parseFlags(["-n", "0", "--once", "--runner", "codex", "--request", "do it"], SCHEMA);
    expect(values).toEqual({ n: 0, once: true, runner: "codex", request: "do it" });
  });

  it("collects positionals not matched by a flag", () => {
    expect(parseFlags(["alpha", "--once", "beta"], SCHEMA).positionals).toEqual(["alpha", "beta"]);
  });

  it("does not let a boolean short flag consume the following positional", () => {
    expect(parseFlags(["-v", "mycommand"], SCHEMA)).toEqual({
      values: { verbose: true },
      positionals: ["mycommand"],
    });
  });

  it("does not let a canonical one-character boolean consume the following positional", () => {
    const schema = { v: { kind: "boolean" } } satisfies FlagSchema;
    expect(parseFlags(["-v", "mycommand"], schema)).toEqual({
      values: { v: true },
      positionals: ["mycommand"],
    });
  });

  it("throws when a canonical one-character value flag is followed by another flag", () => {
    expect(() => parseFlags(["-n", "--once"], SCHEMA)).toThrow("-n requires a value");
  });

  it("preserves a positional containing an equals sign", () => {
    expect(parseFlags(["foo=bar", "--once"], SCHEMA)).toEqual({
      values: { once: true },
      positionals: ["foo=bar"],
    });
  });

  it("does not consume a following flag as a value", () => {
    expect(() => parseFlags(["--offset", "--once"], SCHEMA)).toThrow("--offset requires a value");
  });

  it("accepts a negative number as a value", () => {
    expect(parseFlags(["-n", "-5"], SCHEMA).values.n).toBe(-5);
  });

  it("names the offending flag when the caller opts into strict unknown handling", () => {
    expect(() => parseFlags(["--once", "--bogus"], SCHEMA, { unknownFlags: "error" })).toThrow(
      UnknownFlagError,
    );
    expect(() => parseFlags(["--once", "--bogus"], SCHEMA, { unknownFlags: "error" })).toThrow(
      /unknown flag '--bogus'/,
    );
  });

  it("names a short unknown flag with a single dash", () => {
    expect(() => parseFlags(["-z"], SCHEMA, { unknownFlags: "error" })).toThrow(/unknown flag '-z'/);
  });

  it("lists the declared flags alongside the unknown one", () => {
    try {
      parseFlags(["--bogus"], REPEATED_SCHEMA, { unknownFlags: "error" });
      expect.unreachable("expected UnknownFlagError");
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownFlagError);
      expect((err as UnknownFlagError).flag).toBe("--bogus");
      expect((err as UnknownFlagError).known).toEqual(["--change"]);
    }
  });

  it("accepts declared aliases and negated booleans under strict handling", () => {
    const schema = {
      "slice-2": { kind: "boolean", aliases: ["with-slice-2"] },
      config: { kind: "value", aliases: ["c"], coerce: (raw: string) => raw },
    } satisfies FlagSchema;
    expect(parseFlags(["--no-slice-2", "-c", "x"], schema, { unknownFlags: "error" }).values).toEqual({
      "slice-2": false,
      config: "x",
    });
    expect(parseFlags(["--with-slice-2"], schema, { unknownFlags: "error" }).values["slice-2"]).toBe(true);
  });

  it("still ignores unknown flags by default", () => {
    expect(parseFlags(["--bogus", "--once"], SCHEMA).values.once).toBe(true);
  });
});

describe("parseLooseArgs", () => {
  it("keeps the first token as command and parses remaining flags through cli-args-parser", () => {
    expect(parseLooseArgs(["references", "eval", "--v2", "--out=result.json"])).toEqual({
      command: "references",
      positional: ["eval"],
      flags: { v2: true, out: "result.json" },
    });
  });

  it("supports top-level version flags with trailing flags", () => {
    expect(parseLooseArgs(["--version", "--json"])).toEqual({
      command: "--version",
      positional: [],
      flags: { json: true },
    });
  });

  it("supports short boolean flags and value flags", () => {
    expect(parseLooseArgs(["bench", "latency", "-j", "--iterations", "10"])).toEqual({
      command: "bench",
      positional: ["latency"],
      flags: { j: true, iterations: "10" },
    });
  });

  it("retains ordered values for schema-declared array flags", () => {
    expect(
      parseLooseArgs(
        ["whatif", "rename alpha to beta", "--change=edit src/a.ts", "--change", "delete src/b.ts"],
        { change: { kind: "value", type: "array", coerce: (raw) => raw } },
      ),
    ).toEqual({
      command: "whatif",
      positional: ["rename alpha to beta"],
      flags: { change: "delete src/b.ts" },
      repeatedFlags: { change: ["edit src/a.ts", "delete src/b.ts"] },
    });
  });

  it("accepts a single-dash value for schema-declared array flags", () => {
    expect(
      parseLooseArgs(
        ["evidence", "--privacy-note", "- internal-only"],
        { "privacy-note": { kind: "value", type: "array", coerce: (raw) => raw } },
      ),
    ).toEqual({
      command: "evidence",
      positional: [],
      flags: { "privacy-note": "- internal-only" },
      repeatedFlags: { "privacy-note": ["- internal-only"] },
    });
  });
});

type Cmd = "run" | "monitor" | "fleet" | "reap";

const ROUTER: RouterSchema<Cmd> = {
  commands: { run: {}, monitor: {}, fleet: {}, reap: {} },
  default: "run",
  keepArgvOnDefault: true,
};

describe("routeCommand", () => {
  it("peels a known leading command and returns the rest", () => {
    expect(routeCommand(["monitor", "--once"], ROUTER)).toEqual({ command: "monitor", args: ["--once"] });
    expect(routeCommand(["reap"], ROUTER)).toEqual({ command: "reap", args: [] });
  });

  it("peels the default command name explicitly", () => {
    expect(routeCommand(["run", "--once"], ROUTER)).toEqual({ command: "run", args: ["--once"] });
  });

  it("falls through to default keeping the full argv when leading token is unknown", () => {
    expect(routeCommand(["-n", "0"], ROUTER)).toEqual({ command: "run", args: ["-n", "0"] });
    expect(routeCommand(["--runner", "codex", "--once"], ROUTER)).toEqual({
      command: "run",
      args: ["--runner", "codex", "--once"],
    });
  });

  it("routes empty argv to the default with no args", () => {
    expect(routeCommand([], ROUTER)).toEqual({ command: "run", args: [] });
  });

  it("matches command aliases", () => {
    const aliased: RouterSchema<Cmd> = {
      commands: { run: {}, monitor: { aliases: ["mon"] }, fleet: {}, reap: {} },
      default: "run",
    };
    expect(routeCommand(["mon", "x"], aliased)).toEqual({ command: "monitor", args: ["x"] });
  });

  it("drops the leading token on default when keepArgvOnDefault is false", () => {
    const drop: RouterSchema<Cmd> = { commands: { run: {}, monitor: {}, fleet: {}, reap: {} }, default: "run", keepArgvOnDefault: false };
    expect(routeCommand(["weird", "--once"], drop)).toEqual({ command: "run", args: ["--once"] });
  });

  describe("errorOnUnknownCommand", () => {
    const strict: RouterSchema<Cmd> = {
      commands: { run: {}, monitor: {}, fleet: {}, reap: {} },
      default: "run",
      keepArgvOnDefault: true,
      errorOnUnknownCommand: true,
    };

    it("throws on a typo'd subcommand (non-flag leading token)", () => {
      expect(() => routeCommand(["moniter"], strict)).toThrow(UnknownCommandError);
      expect(() => routeCommand(["fleeet", "3"], strict)).toThrow(/unknown command 'fleeet'/);
    });

    it("still routes flag-led and empty invocations to the default", () => {
      expect(routeCommand(["--runner", "codex"], strict)).toEqual({ command: "run", args: ["--runner", "codex"] });
      expect(routeCommand(["-n", "0"], strict)).toEqual({ command: "run", args: ["-n", "0"] });
      expect(routeCommand([], strict)).toEqual({ command: "run", args: [] });
    });

    it("still peels a known command", () => {
      expect(routeCommand(["monitor", "--once"], strict)).toEqual({ command: "monitor", args: ["--once"] });
    });
  });
});
