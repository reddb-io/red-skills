import { describe, expect, it } from "vitest";
import {
  configuredChannelValue,
  type EntrypointPlan,
  parseEntrypoint,
  resolveLauncherChannel,
} from "./entrypoint-cli.js";

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

  it("routes an explicit `fetch <plugin> <version>` with flags under the generic role", () => {
    const plan = parseEntrypoint(
      ["fetch", "memory", "1.2.3", "--repo", "o/n", "--cache-dir", "/c"],
      "fetch",
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

  // #434 Defect 1: a run-pinned launcher (afk.mjs, role "run:dev") is a dedicated
  // forwarder — the generic `run`/`fetch` verbs must NOT shadow the pinned
  // plugin's own command surface. The pin is honoured before argv[0].
  it("does NOT let `run` shadow a run-pinned launcher: `afk.mjs run --boot-only` forwards to dev", () => {
    const plan = parseEntrypoint(["run", "--boot-only"], "run:dev");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "run",
      plugin: "dev",
      rest: ["run", "--boot-only"],
      repo: DEFAULT_REPO,
    });
  });

  it("forwards a bare AFK command (`monitor`) to the pinned bundle under run:dev", () => {
    expect(parseEntrypoint(["monitor"], "run:dev")).toMatchObject({
      mode: "run",
      plugin: "dev",
      rest: ["monitor"],
    });
  });

  it("forwards AFK's own `run` command (with flags) to the pinned bundle, not the plugin slot", () => {
    expect(parseEntrypoint(["run", "--issues", "430", "-n", "1"], "run:dev")).toMatchObject({
      mode: "run",
      plugin: "dev",
      rest: ["run", "--issues", "430", "-n", "1"],
    });
  });

  it("forwards a literal `fetch` token to the pinned bundle under run:dev (red-fetch.mjs owns real fetch)", () => {
    expect(parseEntrypoint(["fetch", "memory", "1.2.3"], "run:dev")).toMatchObject({
      mode: "run",
      plugin: "dev",
      rest: ["fetch", "memory", "1.2.3"],
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

describe("configuredChannelValue", () => {
  const yaml = [
    "plugins:",
    "  dev:",
    "    afk:",
    "      release:",
    "        channel: canary",
    "      models:",
    "        claude:",
    "          validate:",
    "            model: claude-haiku-4-5",
  ].join("\n");

  it("reads the namespaced plugins.dev.afk.release.channel key", () => {
    expect(configuredChannelValue(yaml)).toBe("canary");
  });

  it("reads the legacy top-level afk.release.channel as a fallback", () => {
    const legacy = ["afk:", "  release:", "    channel: canary"].join("\n");
    expect(configuredChannelValue(legacy)).toBe("canary");
  });

  it("returns undefined when no channel key is present", () => {
    expect(configuredChannelValue("plugins:\n  dev:\n    afk:\n      fleet:\n        target: 2")).toBeUndefined();
    expect(configuredChannelValue("")).toBeUndefined();
  });

  it("ignores a commented-out channel line", () => {
    const commented = ["plugins:", "  dev:", "    afk:", "      release:", "        # channel: canary"].join("\n");
    expect(configuredChannelValue(commented)).toBeUndefined();
  });
});

describe("resolveLauncherChannel", () => {
  it("defaults to stable with no env and no config", () => {
    expect(resolveLauncherChannel({}, undefined)).toBe("stable");
  });

  it("uses the configured channel when env is unset", () => {
    const yaml = ["plugins:", "  dev:", "    afk:", "      release:", "        channel: canary"].join("\n");
    expect(resolveLauncherChannel({}, yaml)).toBe("canary");
  });

  it("RED_SKILLS_CHANNEL env overrides config", () => {
    const yaml = ["plugins:", "  dev:", "    afk:", "      release:", "        channel: canary"].join("\n");
    expect(resolveLauncherChannel({ RED_SKILLS_CHANNEL: "stable" }, yaml)).toBe("stable");
  });
});
