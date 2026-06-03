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
