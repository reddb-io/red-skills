import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  CONFIG_DEFAULTS,
  getConfig,
  loadConfig,
  MalformedConfigError,
  parseConfigYaml,
  readBackpressure,
  resolveTier,
} from "../src/core/config.js";

async function writeConfig(yaml: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "afk-config-"));
  const path = join(dir, ".red", "config.yaml");
  await mkdir(join(dir, ".red"), { recursive: true });
  await writeFile(path, yaml, "utf8");
  return path;
}

describe("config", () => {
  it("missing file → all defaults, no warning", async () => {
    const warnings: string[] = [];
    const values = loadConfig(join(tmpdir(), "nope", ".red", "config.yaml"), {
      warn: (m) => warnings.push(m),
    });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("true");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("false");
    expect(warnings).toHaveLength(0);
  });

  it("partial override only touches the specified key", async () => {
    const path = await writeConfig(`afk:\n  default_runner: codex\n`);
    const values = loadConfig(path);
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("true");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
  });

  it("unknown top-level key is ignored without warning", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`zzz: foo\nafk:\n  default_runner: codex\n`);
    const values = loadConfig(path, { warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "zzz")).toBe("foo");
    expect(warnings).toHaveLength(0);
  });

  it("unknown nested key is ignored silently", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n  default_runner: codex\n  unknown_thing: 42\n`);
    const values = loadConfig(path, { warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
    expect(warnings).toHaveLength(0);
  });

  it("malformed YAML (unclosed quote) → one warning, all defaults", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n  default_runner: "codex\n`);
    const values = loadConfig(path, { warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("config.yaml");
  });

  it("malformed YAML (odd indentation) → one warning, all defaults", async () => {
    const warnings: string[] = [];
    const path = await writeConfig(`afk:\n   default_runner: codex\n`);
    const values = loadConfig(path, { warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("claude");
    expect(warnings).toHaveLength(1);
  });

  it("every documented v1 key has a default", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    for (const key of Object.keys(CONFIG_DEFAULTS)) {
      expect(getConfig(values, key)).not.toBe("");
    }
  });

  it("reads afk.release.channel and defaults it to stable (ADR 0058)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(defaults, "afk.release.channel")).toBe("stable");

    const values = loadConfig("/x/.red/config.yaml", {
      read: () => "plugins:\n  dev:\n    afk:\n      release:\n        channel: canary\n",
    });
    expect(getConfig(values, "afk.release.channel")).toBe("canary");
  });

  it("reads dev.lock.primary-branch and defaults it off", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(defaults, "dev.lock.primary-branch")).toBe("false");

    const values = loadConfig("/x/.red/config.yaml", {
      read: () => "dev:\n  lock:\n    primary-branch: true\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
  });

  it("reads afk.review_gate.* and defaults the gate off at the complex threshold (#749)", () => {
    const defaults = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(defaults, "afk.review_gate.enabled")).toBe("false");
    expect(getConfig(defaults, "afk.review_gate.threshold")).toBe("complex");

    const values = loadConfig("/x/.red/config.yaml", {
      read: () =>
        "plugins:\n  dev:\n    afk:\n      review_gate:\n        enabled: true\n        threshold: simple\n",
    });
    expect(getConfig(values, "afk.review_gate.enabled")).toBe("true");
    expect(getConfig(values, "afk.review_gate.threshold")).toBe("simple");
  });

  it("folds the namespaced `plugins.dev.lock.primary-branch` onto `dev.lock.primary-branch`", () => {
    // The root-sacred convention: dev-plugin keys nest under `plugins.dev.*` and
    // fold to the `dev.*` accessor (afk keeps its bare `afk.*` accessor).
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => "plugins:\n  dev:\n    lock:\n      primary-branch: true\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
  });

  it("folds `plugins.dev` dev-keys and afk-keys to their distinct accessors at once", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () =>
        "plugins:\n  dev:\n    lock:\n      primary-branch: true\n    afk:\n      default_runner: codex\n",
    });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("nested override leaves siblings untouched", async () => {
    const path = await writeConfig(
      `afk:\n  hooks:\n    defaults:\n      cargo: false\n`,
    );
    const values = loadConfig(path);
    expect(getConfig(values, "afk.hooks.defaults.cargo")).toBe("false");
    expect(getConfig(values, "afk.hooks.defaults.gradle")).toBe("true");
    expect(getConfig(values, "afk.fleet.target")).toBe("2");
  });

  it("integer values round-trip as strings", async () => {
    const path = await writeConfig(`afk:\n  fleet:\n    target: 5\n`);
    const values = loadConfig(path);
    expect(getConfig(values, "afk.fleet.target")).toBe("5");
  });

  it("comments and blank lines are ignored", async () => {
    const warnings: string[] = [];
    const yaml = [
      "# top-level comment",
      "afk:",
      "  # inner comment",
      "  default_runner: codex",
      "",
      "  fleet:",
      "    target: 3   # inline comment",
      "",
    ].join("\n");
    const path = await writeConfig(yaml);
    const values = loadConfig(path, { warn: (m) => warnings.push(m) });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("3");
    expect(warnings).toHaveLength(0);
  });

  it("getConfig returns empty string for unset keys", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(values, "afk.does.not.exist")).toBe("");
  });

  it("parseConfigYaml is pure and throws MalformedConfigError on bad input", () => {
    expect(parseConfigYaml("afk:\n  default_runner: codex\n")).toEqual({
      "afk.default_runner": "codex",
    });
    expect(() => parseConfigYaml("afk:\n  default_runner: 'codex\n")).toThrow(
      MalformedConfigError,
    );
    expect(() => parseConfigYaml("- not a mapping\n")).toThrow(MalformedConfigError);
  });

  it("inline comment after double-quoted scalar parses without throwing", () => {
    const text = 'afk:\n  default_runner: "codex" # preferred runner\n';
    expect(parseConfigYaml(text)).toEqual({ "afk.default_runner": "codex" });
  });

  it("inline comment after single-quoted scalar parses without throwing", () => {
    const text = "afk:\n  default_runner: 'codex' # preferred runner\n";
    expect(parseConfigYaml(text)).toEqual({ "afk.default_runner": "codex" });
  });

  it("block-sequence config does not disable the primary-branch guard", () => {
    const text =
      'dev:\n  lock:\n    primary-branch: true\nafk:\n  backpressure:\n    - "npm run test" # full suite\n    - npm run lint\n';
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "dev.lock.primary-branch")).toBe("true");
    expect(readBackpressure(values)).toEqual(["npm run test", "npm run lint"]);
  });

  it("injectable reader bypasses the filesystem", () => {
    const values = loadConfig("virtual.yaml", {
      read: () => "afk:\n  fleet:\n    target: 9\n",
    });
    expect(getConfig(values, "afk.fleet.target")).toBe("9");
  });
});

describe("config — plugins.dev namespace (ADR 0042)", () => {
  it("folds plugins.dev.afk.* down to the bare afk.* accessor keys", () => {
    const text = "plugins:\n  dev:\n    afk:\n      default_runner: codex\n      fleet:\n        target: 4\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(getConfig(values, "afk.fleet.target")).toBe("4");
  });

  it("still reads the legacy top-level afk.* block (back-compat)", () => {
    const text = "afk:\n  default_runner: codex\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });

  it("lets the namespaced location win over a legacy top-level key", () => {
    const text = "afk:\n  default_runner: claude\nplugins:\n  dev:\n    afk:\n      default_runner: codex\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
  });
});

describe("config — block sequences (afk.backpressure, #430)", () => {
  it("parses a `- item` sequence into ordered indexed keys", () => {
    const text = "afk:\n  backpressure:\n    - npm run test\n    - npm run lint\n";
    expect(parseConfigYaml(text)).toEqual({
      "afk.backpressure.0": "npm run test",
      "afk.backpressure.1": "npm run lint",
    });
  });

  it("keeps a sibling scalar key alongside a sequence", () => {
    const text = "afk:\n  default_runner: codex\n  backpressure:\n    - npm test\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.default_runner")).toBe("codex");
    expect(readBackpressure(values)).toEqual(["npm test"]);
  });

  it("strips quotes from sequence items", () => {
    const text = 'afk:\n  backpressure:\n    - "npm run test -- --reporter=dot"\n';
    expect(parseConfigYaml(text)).toEqual({
      "afk.backpressure.0": "npm run test -- --reporter=dot",
    });
  });

  it("strips inline comment after closing quote on a sequence item", () => {
    const text = 'afk:\n  backpressure:\n    - "npm run test" # full suite\n';
    expect(parseConfigYaml(text)).toEqual({ "afk.backpressure.0": "npm run test" });
  });

  it("throws on a top-level sequence with no enclosing mapping", () => {
    expect(() => parseConfigYaml("- npm test\n")).toThrow(MalformedConfigError);
  });

  it("readBackpressure reads the list in order", () => {
    const text = "afk:\n  backpressure:\n    - npm run test\n    - npm run lint\n    - npm run build\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(readBackpressure(values)).toEqual(["npm run test", "npm run lint", "npm run build"]);
  });

  it("readBackpressure reads the namespaced location (ADR 0042)", () => {
    const text = "plugins:\n  dev:\n    afk:\n      backpressure:\n        - npm run test\n        - npm run lint\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(readBackpressure(values)).toEqual(["npm run test", "npm run lint"]);
  });

  it("readBackpressure accepts a single-line scalar as a one-command list", () => {
    const text = "afk:\n  backpressure: npm run test\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(readBackpressure(values)).toEqual(["npm run test"]);
  });

  it("readBackpressure returns [] when absent (the gate is a no-op)", () => {
    const values = loadConfig("/x/.red/config.yaml", { read: () => "afk:\n  default_runner: codex\n" });
    expect(readBackpressure(values)).toEqual([]);
  });
});

describe("config — afk.merge.wait_for_review (ADR 0048)", () => {
  it("defaults to false (merge-without-advice) with CodeRabbit as the review check", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("false");
    expect(getConfig(values, "afk.merge.review_check")).toBe("CodeRabbit");
  });

  it("reads the namespaced plugins.dev.afk.merge.* block", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      merge:\n        wait_for_review: true\n        review_check: my-reviewer\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("true");
    expect(getConfig(values, "afk.merge.review_check")).toBe("my-reviewer");
  });

  it("reads the legacy top-level afk.merge.* block (back-compat)", () => {
    const text = "afk:\n  merge:\n    wait_for_review: true\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.merge.wait_for_review")).toBe("true");
    // review_check keeps its default when unset.
    expect(getConfig(values, "afk.merge.review_check")).toBe("CodeRabbit");
  });
});

describe("config — afk.worktree_launches_pull_request (ADR 0030 amended, #842)", () => {
  it("defaults to true (admin-PR landing) when unset", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("true");
  });

  it("reads the namespaced plugins.dev.afk.* block", () => {
    const text = "plugins:\n  dev:\n    afk:\n      worktree_launches_pull_request: false\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("false");
  });

  it("reads the legacy top-level afk.* block (back-compat)", () => {
    const text = "afk:\n  worktree_launches_pull_request: false\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("false");
  });

  it("lets the namespaced location win over a legacy top-level key", () => {
    const text =
      "afk:\n  worktree_launches_pull_request: false\n" +
      "plugins:\n  dev:\n    afk:\n      worktree_launches_pull_request: true\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(getConfig(values, "afk.worktree_launches_pull_request")).toBe("true");
  });
});

describe("config — AFK model tier table (ADR 0049)", () => {
  it("defaults the unclassified AFK tier to think per runner", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "claude")).toEqual({ model: "claude-opus-4-8", effort: "high" });
    expect(resolveTier(values, "codex")).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("lets RED_AFK_MODEL / RED_AFK_EFFORT override every tier (flag pre-sets the env)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    // Override flattens all tiers onto one slug, beating the config/default table.
    expect(resolveTier(values, "opencode", "simple", { RED_AFK_MODEL: "minimax/MiniMax-M2" })).toEqual({
      model: "minimax/MiniMax-M2",
      effort: "high",
    });
    expect(
      resolveTier(values, "opencode", "validate", { RED_AFK_MODEL: "minimax/MiniMax-M2", RED_AFK_EFFORT: "high" }),
    ).toEqual({ model: "minimax/MiniMax-M2", effort: "high" });
    // An empty override is treated as unset — config/default stays in charge.
    expect(resolveTier(values, "opencode", "simple", { RED_AFK_MODEL: "" })).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
    // No env arg (e.g. the interactive model-tier route) → never overridden.
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
  });

  it("resolves every Claude tier from the default table", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "claude", "validate")).toEqual({ model: "claude-haiku-4-5", effort: "low" });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    expect(resolveTier(values, "claude", "complex")).toEqual({ model: "claude-opus-4-8", effort: "medium" });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "claude-opus-4-8", effort: "high" });
  });

  it("resolves every Codex tier from the default gpt-5.x table", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "codex", "validate")).toEqual({ model: "gpt-5.5", effort: "low" });
    expect(resolveTier(values, "codex", "simple")).toEqual({ model: "gpt-5.5", effort: "high" });
    expect(resolveTier(values, "codex", "complex")).toEqual({ model: "gpt-5.5", effort: "medium" });
    expect(resolveTier(values, "codex", "think")).toEqual({ model: "gpt-5.5", effort: "high" });
  });

  it("resolves every OpenCode tier from the default openrouter table (ADR 0059)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "opencode", "validate")).toEqual({
      model: "openrouter/anthropic/claude-3.5-haiku",
      effort: "low",
    });
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/anthropic/claude-sonnet-4",
      effort: "high",
    });
    expect(resolveTier(values, "opencode", "complex")).toEqual({
      model: "openrouter/anthropic/claude-opus-4",
      effort: "medium",
    });
    expect(resolveTier(values, "opencode", "think")).toEqual({
      model: "openrouter/anthropic/claude-opus-4",
      effort: "high",
    });
  });

  it("resolves every claude-minimax tier to MiniMax-M3/low from the default table (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "claude-minimax", "validate")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "simple")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "complex")).toEqual({ model: "MiniMax-M3", effort: "low" });
    expect(resolveTier(values, "claude-minimax", "think")).toEqual({ model: "MiniMax-M3", effort: "low" });
  });

  it("RED_AFK_MODEL still overrides the claude-minimax tier table (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "claude-minimax", "think", { RED_AFK_MODEL: "MiniMax-M3-Custom" })).toEqual({
      model: "MiniMax-M3-Custom",
      effort: "low",
    });
  });

  it("claude-minimax does not bleed into the claude table — runners stay isolated (#792)", () => {
    const values = loadConfig("/nonexistent/.red/config.yaml", { warn: () => {} });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
    expect(resolveTier(values, "claude-minimax", "simple")).toEqual({ model: "MiniMax-M3", effort: "low" });
  });

  it("honours an overridden opencode tier under plugins.dev.afk.models.opencode.*", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          simple:\n            model: openrouter/openai/gpt-4o-mini\n            effort: medium\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(resolveTier(values, "opencode", "simple")).toEqual({
      model: "openrouter/openai/gpt-4o-mini",
      effort: "medium",
    });
  });

  it("auto-populates every tier from `base`, with a specialized tier overriding it", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          base:\n            model: minimax/MiniMax-M2\n            effort: medium\n          think:\n            model: minimax/MiniMax-M2-thinking\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    // base flows to every un-specialized tier (model AND effort)
    expect(resolveTier(values, "opencode", "validate")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "simple")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "complex")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    // a specialized tier overrides the base model; its effort still inherits from base
    expect(resolveTier(values, "opencode", "think")).toEqual({ model: "minimax/MiniMax-M2-thinking", effort: "medium" });
    // base does not leak across runners — claude keeps its own table
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
  });

  it("`base.model` alone uniformly sets the model but leaves each tier's default effort", () => {
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        opencode:\n          base:\n            model: minimax/MiniMax-M2\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    // model is uniform from base; effort stays at each tier's table default (low/high/medium/high)
    expect(resolveTier(values, "opencode", "validate")).toEqual({ model: "minimax/MiniMax-M2", effort: "low" });
    expect(resolveTier(values, "opencode", "complex")).toEqual({ model: "minimax/MiniMax-M2", effort: "medium" });
    expect(resolveTier(values, "opencode", "think")).toEqual({ model: "minimax/MiniMax-M2", effort: "high" });
  });

  it("lets explicit tier entries override legacy scalar model keys", () => {
    const text =
      "afk:\n  model: shared-model\n  models:\n    claude:\n      think:\n        model: claude-tier-model\n        effort: max\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "claude-tier-model", effort: "max" });
  });

  it("an explicit tier pin equal to the default beats a stale legacy scalar (bug #583)", () => {
    // simple tier default = claude-sonnet-4-6; legacy afk.model = custom-model.
    // An explicit simple.model = claude-sonnet-4-6 (same as the default) must
    // still win — the old tierModel !== defaultModel guard silently dropped it.
    const text = "afk:\n  model: custom-model\n  models:\n    claude:\n      simple:\n        model: claude-sonnet-4-6\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(resolveTier(values, "claude", "simple")).toEqual({ model: "claude-sonnet-4-6", effort: "high" });
  });

  it("an explicit tier effort pin equal to the default beats a base effort override (bug #583)", () => {
    // validate tier default effort = low; base effort = medium.
    // An explicit validate.effort = low (same as the default) must still win.
    const text =
      "plugins:\n  dev:\n    afk:\n      models:\n        claude:\n          base:\n            effort: medium\n          validate:\n            effort: low\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(resolveTier(values, "claude", "validate")).toEqual({ model: "claude-haiku-4-5", effort: "low" });
  });

  it("falls back to legacy per-runner and global scalar model keys", () => {
    const values = loadConfig("/x/.red/config.yaml", {
      read: () => "afk:\n  model: shared-model\n  models:\n    codex: gpt-custom\n",
    });
    expect(resolveTier(values, "codex", "think")).toEqual({ model: "gpt-custom", effort: "high" });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "shared-model", effort: "high" });
  });

  it("lets the namespaced plugins.dev tier table win over the legacy top-level table", () => {
    const text =
      "afk:\n  models:\n    claude:\n      think:\n        model: legacy-tier\n        effort: low\nplugins:\n  dev:\n    afk:\n      models:\n        claude:\n          think:\n            model: namespaced-tier\n            effort: high\n";
    const values = loadConfig("/x/.red/config.yaml", { read: () => text });
    expect(resolveTier(values, "claude", "think")).toEqual({ model: "namespaced-tier", effort: "high" });
  });
});
