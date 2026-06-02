import { describe, expect, test } from "vitest";
import { CONFIG_VERSION, DEFAULT_NOTES_DIR } from "../src/config.js";
import { graphConfig, markdownOnlyConfig } from "../src/init.js";
import {
  emitMemoryBlockLines,
  mergeMemoryBlock,
  parsePluginsMemory,
  parseYamlFlat,
} from "../src/shared-config.js";

describe("parsePluginsMemory", () => {
  test("reads a markdown-only block, deriving reddb=false and the version constant", () => {
    const config = parsePluginsMemory("plugins:\n  memory:\n    mode: markdown-only\n");
    expect(config).not.toBeNull();
    expect(config?.mode).toBe("markdown-only");
    expect(config?.reddb).toBe(false);
    expect(config?.mcp).toBe(false);
    expect(config?.version).toBe(CONFIG_VERSION);
    expect(config?.notesDir).toBe(DEFAULT_NOTES_DIR);
    expect(config?.hooks).toEqual({
      sessionStart: false,
      postToolUse: false,
      stop: false,
      preCompact: false,
    });
  });

  test("reads a graph block with hooks, deriving reddb=true", () => {
    const text = [
      "plugins:",
      "  memory:",
      "    mode: graph",
      "    hooks:",
      "      sessionStart: true",
      "      stop: true",
      "    skillTelemetry: true",
      "",
    ].join("\n");
    const config = parsePluginsMemory(text);
    expect(config?.mode).toBe("graph");
    expect(config?.reddb).toBe(true);
    expect(config?.skillTelemetry).toBe(true);
    expect(config?.hooks).toEqual({
      sessionStart: true,
      postToolUse: false,
      stop: true,
      preCompact: false,
    });
  });

  test("returns null when there is no plugins.memory block", () => {
    expect(parsePluginsMemory("")).toBeNull();
    expect(parsePluginsMemory("plugins:\n  dev:\n    afk:\n      default_runner: codex\n")).toBeNull();
    expect(parsePluginsMemory("# just a comment\nfoo: bar\n")).toBeNull();
  });

  test("a top-level memory: (not nested under plugins:) does not count", () => {
    // parseYamlFlat keys it as `memory.mode`, not `plugins.memory.mode`.
    const flat = parseYamlFlat("memory:\n  mode: graph\n");
    expect(flat["memory.mode"]).toBe("graph");
    expect(parsePluginsMemory("memory:\n  mode: graph\n")).toBeNull();
  });
});

describe("emitMemoryBlockLines (sparse)", () => {
  test("markdown-only emits only mode", () => {
    expect(emitMemoryBlockLines(markdownOnlyConfig())).toEqual(["  memory:", "    mode: markdown-only"]);
  });

  test("graph drops derived reddb/version and default store/notes", () => {
    const lines = emitMemoryBlockLines(graphConfig({ hooks: { sessionStart: true } }));
    expect(lines).toContain("  memory:");
    expect(lines).toContain("    mode: graph");
    expect(lines).toContain("    hooks:");
    expect(lines).toContain("      sessionStart: true");
    expect(lines.join("\n")).not.toContain("reddb:");
    expect(lines.join("\n")).not.toContain("version:");
    expect(lines.join("\n")).not.toContain("storePath:"); // default → omitted
  });
});

describe("mergeMemoryBlock", () => {
  test("creates plugins: from an empty file", () => {
    const out = mergeMemoryBlock("", markdownOnlyConfig());
    expect(out).toBe("plugins:\n  memory:\n    mode: markdown-only\n");
  });

  test("appends a plugins: block after existing global keys", () => {
    const out = mergeMemoryBlock("# global\nsomeGlobal: 1\n", markdownOnlyConfig());
    expect(out).toContain("someGlobal: 1");
    expect(out).toContain("plugins:\n  memory:\n    mode: markdown-only");
  });

  test("inserts memory under an existing plugins.dev, preserving dev", () => {
    const existing = "plugins:\n  dev:\n    afk:\n      default_runner: codex\n";
    const out = mergeMemoryBlock(existing, markdownOnlyConfig());
    expect(out).toContain("  dev:");
    expect(out).toContain("default_runner: codex");
    expect(out).toContain("  memory:");
    expect(out).toContain("    mode: markdown-only");
  });

  test("replaces an existing memory block, preserving a dev sibling after it", () => {
    const existing = [
      "plugins:",
      "  memory:",
      "    mode: markdown-only",
      "  dev:",
      "    afk:",
      "      default_runner: codex",
      "",
    ].join("\n");
    const out = mergeMemoryBlock(existing, graphConfig());
    expect(out).toContain("    mode: graph");
    expect(out).not.toContain("    mode: markdown-only");
    expect(out).toContain("  dev:");
    expect(out).toContain("default_runner: codex");
  });

  test("round-trips: merge then parse yields an equivalent config", () => {
    const merged = mergeMemoryBlock(
      "plugins:\n  dev:\n    afk:\n      default_runner: codex\n",
      graphConfig({ hooks: { sessionStart: true, stop: true }, skillTelemetry: true }),
    );
    const parsed = parsePluginsMemory(merged);
    expect(parsed?.mode).toBe("graph");
    expect(parsed?.reddb).toBe(true);
    expect(parsed?.skillTelemetry).toBe(true);
    expect(parsed?.hooks.sessionStart).toBe(true);
    expect(parsed?.hooks.stop).toBe(true);
    expect(parsed?.hooks.postToolUse).toBe(false);
  });
});
