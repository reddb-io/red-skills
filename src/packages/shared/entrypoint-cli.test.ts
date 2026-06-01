import { describe, expect, it } from "vitest";
import { type EntrypointPlan, parseEntrypoint } from "./entrypoint-cli.js";

const DEFAULT_REPO = "reddb-io/red-skills";

describe("parseEntrypoint", () => {
  it("routes an explicit `run <plugin>` and forwards the remaining args verbatim", () => {
    const plan = parseEntrypoint(["run", "dev", "fleet", "3", "--request", "x"], "fetch");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "run",
      plugin: "dev",
      rest: ["fleet", "3", "--request", "x"],
      repo: DEFAULT_REPO,
    });
  });

  it("routes an explicit `fetch <plugin> <version>` with flags", () => {
    const plan = parseEntrypoint(
      ["fetch", "memory", "1.2.3", "--repo", "o/n", "--cache-dir", "/c"],
      "run:dev",
    );
    expect(plan).toEqual<EntrypointPlan>({
      mode: "fetch",
      plugin: "memory",
      version: "1.2.3",
      repo: "o/n",
      cacheDir: "/c",
      help: false,
    });
  });

  it("falls back to the `run:<plugin>` build role, forwarding ALL argv as bundle args", () => {
    const plan = parseEntrypoint(["statusline"], "run:dev");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "run",
      plugin: "dev",
      rest: ["statusline"],
      repo: DEFAULT_REPO,
    });
  });

  it("falls back to legacy positional fetch under the `fetch` role (red-fetch.mjs dev <ver>)", () => {
    const plan = parseEntrypoint(["dev", "1.147.6"], "fetch");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "fetch",
      plugin: "dev",
      version: "1.147.6",
      repo: DEFAULT_REPO,
      help: false,
    });
  });

  it("treats `--version` as a run arg under run:dev (forwarded to the bundle), not a fetch flag", () => {
    const plan = parseEntrypoint(["--version"], "run:dev");
    expect(plan).toMatchObject({ mode: "run", plugin: "dev", rest: ["--version"] });
  });

  it("with no role and no subcommand, an empty argv is an incomplete fetch (prints usage, exits 0)", () => {
    const plan = parseEntrypoint([], "");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "fetch",
      plugin: undefined,
      version: undefined,
      repo: DEFAULT_REPO,
      help: false,
    });
  });
});
