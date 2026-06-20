import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPluginEnabled, pluginEnabledInConfig } from "./plugin-gate.js";

describe("pluginEnabledInConfig (strict opt-in, ADR 0067)", () => {
  it("is enabled only when plugins.<name>.enabled is explicitly true", () => {
    const yaml = ["plugins:", "  dev:", "    enabled: true"].join("\n");
    expect(pluginEnabledInConfig(yaml, "dev")).toBe(true);
  });

  it("a block WITHOUT an enabled key is disabled (block-presence is not enough)", () => {
    const yaml = ["plugins:", "  dev:", "    lock:", "      primary-branch: true"].join("\n");
    expect(pluginEnabledInConfig(yaml, "dev")).toBe(false);
  });

  it("enabled: false is disabled", () => {
    const yaml = ["plugins:", "  memory:", "    enabled: false"].join("\n");
    expect(pluginEnabledInConfig(yaml, "memory")).toBe(false);
  });

  it("an absent plugin block is disabled", () => {
    const yaml = ["plugins:", "  dev:", "    enabled: true"].join("\n");
    expect(pluginEnabledInConfig(yaml, "brain")).toBe(false);
  });

  it("isolates plugins from one another", () => {
    const yaml = [
      "plugins:",
      "  dev:",
      "    enabled: true",
      "  memory:",
      "    enabled: false",
      "  brain:",
      "    enabled: true",
    ].join("\n");
    expect(pluginEnabledInConfig(yaml, "dev")).toBe(true);
    expect(pluginEnabledInConfig(yaml, "memory")).toBe(false);
    expect(pluginEnabledInConfig(yaml, "brain")).toBe(true);
  });

  it("ignores a commented-out enabled line", () => {
    const yaml = ["plugins:", "  dev:", "    # enabled: true"].join("\n");
    expect(pluginEnabledInConfig(yaml, "dev")).toBe(false);
  });

  it("tolerates an inline comment after the value", () => {
    const yaml = ["plugins:", "  dev:", "    enabled: true   # turned on by setup"].join("\n");
    expect(pluginEnabledInConfig(yaml, "dev")).toBe(true);
  });

  it("an empty config is disabled", () => {
    expect(pluginEnabledInConfig("", "dev")).toBe(false);
  });
});

describe("isPluginEnabled (filesystem gate)", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "red-gate-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function writeConfig(dir: string, body: string): void {
    const redDir = join(dir, ".red");
    mkdirSync(redDir, { recursive: true });
    writeFileSync(join(redDir, "config.yaml"), body);
  }

  it("returns false when no .red/config.yaml exists anywhere (fully inert)", () => {
    expect(isPluginEnabled(root, "dev")).toBe(false);
  });

  it("returns true for an enabled plugin in the cwd", () => {
    writeConfig(root, ["plugins:", "  dev:", "    enabled: true"].join("\n"));
    expect(isPluginEnabled(root, "dev")).toBe(true);
  });

  it("walks up from a subdirectory to find the project config", () => {
    writeConfig(root, ["plugins:", "  dev:", "    enabled: true"].join("\n"));
    const sub = join(root, "apps", "thing", "src");
    mkdirSync(sub, { recursive: true });
    expect(isPluginEnabled(sub, "dev")).toBe(true);
  });

  it("returns false when the config exists but the plugin is not enabled", () => {
    writeConfig(root, ["plugins:", "  memory:", "    enabled: true"].join("\n"));
    expect(isPluginEnabled(root, "dev")).toBe(false);
  });
});
