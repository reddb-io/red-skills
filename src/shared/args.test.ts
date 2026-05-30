import { describe, expect, it } from "vitest";
import { parseFlags, routeCommand, type FlagSchema, type RouterSchema } from "./args.js";

const SCHEMA = {
  prd: { kind: "value", coerce: (raw: string) => Number(raw) },
  issues: {
    kind: "value",
    coerce: (raw: string) => raw.split(",").map((n) => Number(n.trim())).filter((n) => Number.isFinite(n)),
  },
  n: { kind: "value", coerce: (raw: string) => Number(raw) },
  once: { kind: "boolean" },
  runner: { kind: "value", coerce: (raw: string) => raw },
  request: { kind: "value", aliases: ["r"], coerce: (raw: string) => raw },
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

  it("lets the last occurrence of a flag win", () => {
    expect(parseFlags(["--runner", "claude", "--runner", "codex"], SCHEMA).values.runner).toBe("codex");
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
});
