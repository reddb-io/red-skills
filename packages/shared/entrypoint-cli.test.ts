import { describe, expect, it } from "vitest";
import { DEV_WARM_BUNDLE, companionBundlePlugins } from "./bundle-fetch.js";
import {
  configuredChannelValue,
  type EntrypointPlan,
  gatePluginName,
  parseEntrypoint,
  resolveLauncherChannel,
} from "./entrypoint-cli.js";

const DEFAULT_REPO = "reddb-io/red-skills";

describe("gatePluginName (ADR 0067)", () => {
  it("maps code-nav to dev (code-nav ships under the dev plugin)", () => {
    expect(gatePluginName("code-nav")).toBe("dev");
  });
  it("maps the warm anchor and its companions to dev", () => {
    // The SessionStart hook fetches `redskilled` (#4112), and nothing under the
    // dev umbrella has a `plugins.<name>` block — a gate on its own name would
    // read a flag no config ever sets and silently warm nothing.
    expect(gatePluginName(DEV_WARM_BUNDLE)).toBe("dev");
    for (const companion of companionBundlePlugins(DEV_WARM_BUNDLE)) {
      expect(gatePluginName(companion), companion).toBe("dev");
    }
  });
  it("leaves first-class plugins unchanged", () => {
    expect(gatePluginName("dev")).toBe("dev");
    expect(gatePluginName("memory")).toBe("memory");
    expect(gatePluginName("brain")).toBe("brain");
  });
});

describe("parseEntrypoint", () => {
  it("routes an explicit `fetch <plugin> <version>` with flags", () => {
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

  it("falls back to legacy positional fetch (red-fetch.mjs dev <ver>)", () => {
    const plan = parseEntrypoint(["dev", "1.147.6"], "fetch");
    expect(plan).toEqual<EntrypointPlan>({
      mode: "fetch",
      plugin: "dev",
      version: "1.147.6",
      repo: DEFAULT_REPO,
      help: false,
    });
  });

  // ADR 0147 rule 1: the `run:<plugin>` role was the path to a second shipped
  // binary. A stale build stamped with it is an artifact, not a second mode —
  // every argv shape lands in fetch, so nothing execs a bundle any more.
  it("routes a retired `run:dev` role's argv into fetch rather than launching anything", () => {
    expect(parseEntrypoint(["dev", "1.2.3"], "run:dev")).toEqual<EntrypointPlan>({
      mode: "fetch",
      plugin: "dev",
      version: "1.2.3",
      repo: DEFAULT_REPO,
      help: false,
    });
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
