import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, test } from "vitest";
import { CONFIG_VERSION, DEFAULT_NOTES_DIR } from "../src/config.js";
import { migrateStorePathToRepoStore, readConfig } from "../src/config.js";
import { graphConfig, markdownOnlyConfig } from "../src/init.js";
import { DEFAULT_RECALL_RANKING_CONFIG } from "../src/recall-ranking.js";
import {
  emitMemoryBlockLines,
  mergeMemoryBlock,
  parsePluginsMemory,
  parseYamlFlat,
} from "../src/shared-config.js";
import { writeMemoryStateFile } from "../src/toon-state.js";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "memory-config-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

  test("reads a graph block with autohooks, deriving reddb=true", () => {
    const text = [
      "plugins:",
      "  memory:",
      "    mode: graph",
      "    autohooks:",
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

  test("reads deterministic recall-ranking overrides", () => {
    const text = [
      "plugins:",
      "  memory:",
      "    mode: graph",
      "    recallRanking:",
      "      rrfK: 42",
      "      recencyHalfLifeDays: 14",
      "      mmrLambda: 0.6",
      "      queryVariantLimit: 3",
      "      sessionRoundRobin: false",
      "",
    ].join("\n");
    expect(parsePluginsMemory(text)?.recallRanking).toEqual({
      rrfK: 42,
      recencyHalfLifeDays: 14,
      mmrLambda: 0.6,
      queryVariantLimit: 3,
      sessionRoundRobin: false,
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
    expect(lines).toContain("    autohooks:");
    expect(lines).toContain("      sessionStart: true");
    expect(lines.join("\n")).not.toContain("    hooks:"); // never the user-hook key
    expect(lines.join("\n")).not.toContain("reddb:");
    expect(lines.join("\n")).not.toContain("version:");
    expect(lines.join("\n")).not.toContain("storePath:"); // default → omitted
  });

  test("recall-ranking defaults stay sparse and overrides emit", () => {
    const defaults = emitMemoryBlockLines({
      ...graphConfig(),
      recallRanking: { ...DEFAULT_RECALL_RANKING_CONFIG },
    }).join("\n");
    expect(defaults).not.toContain("recallRanking:");

    const lines = emitMemoryBlockLines({
      ...graphConfig(),
      recallRanking: {
        recencyHalfLifeDays: 14,
        mmrLambda: 0.6,
        sessionRoundRobin: false,
      },
    });
    expect(lines).toContain("    recallRanking:");
    expect(lines).toContain("      recencyHalfLifeDays: 14");
    expect(lines).toContain("      mmrLambda: 0.6");
    expect(lines).toContain("      sessionRoundRobin: false");
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

describe("plugins.memory.enabled (ADR 0067 activation flag)", () => {
  test("parsePluginsMemory reads enabled: true", () => {
    const config = parsePluginsMemory("plugins:\n  memory:\n    enabled: true\n    mode: graph\n");
    expect(config?.enabled).toBe(true);
  });

  test("parsePluginsMemory reports enabled=false when the flag is absent", () => {
    const config = parsePluginsMemory("plugins:\n  memory:\n    mode: graph\n");
    expect(config?.enabled).toBe(false);
  });

  test("emitMemoryBlockLines writes enabled: true at the head of the block", () => {
    const lines = emitMemoryBlockLines({ ...markdownOnlyConfig(), enabled: true });
    expect(lines[0]).toBe("  memory:");
    expect(lines[1]).toBe("    enabled: true");
  });

  test("emitMemoryBlockLines omits the flag when not enabled (sparse)", () => {
    const lines = emitMemoryBlockLines(markdownOnlyConfig());
    expect(lines.some((l) => l.includes("enabled"))).toBe(false);
  });

  test("mergeMemoryBlock preserves an enabled: true that red-setup wrote", () => {
    // setup wrote only the activation flag; the init wizard's config object does
    // not carry it, yet the merge must not drop it (else memory goes dark).
    const existing = "plugins:\n  memory:\n    enabled: true\n";
    const merged = mergeMemoryBlock(existing, graphConfig());
    expect(parsePluginsMemory(merged)?.enabled).toBe(true);
    expect(parsePluginsMemory(merged)?.mode).toBe("graph");
  });
});

describe("migrateStorePathToRepoStore", () => {
  test("readConfig sniffs legacy standalone TOON config before JSON fallback", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "memory"), { recursive: true });
    await writeMemoryStateFile(join(root, ".red", "memory", "config.toon"), markdownOnlyConfig());

    await expect(readConfig(root)).resolves.toMatchObject({ mode: "markdown-only" });
    const raw = await readFile(join(root, ".red", "memory", "config.toon"), "utf8");
    expect(raw.trimStart().startsWith("{")).toBe(false);
  });

  test("copies a legacy standalone graph store and repoints memory config", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red", "memory"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), [
      "plugins:",
      "  memory:",
      "    enabled: true",
      "    mode: graph",
      "    storePath: .red/memory/graph.rdb",
      "",
    ].join("\n"), "utf8");
    await writeFile(join(root, ".red", "memory", "graph.rdb"), "legacy graph data", "utf8");

    const result = await migrateStorePathToRepoStore(root);

    expect(result).toMatchObject({
      fromStorePath: ".red/memory/graph.rdb",
      toStorePath: ".red/red.rdb",
      configChanged: true,
      storeCopied: true,
    });
    await expect(readFile(join(root, ".red", "red.rdb"), "utf8")).resolves.toBe("legacy graph data");
    expect((await readConfig(root))?.storePath).toBe(".red/red.rdb");
  });

  test("is a no-op after memory already points at the shared Repo store", async () => {
    const root = await tempRoot();
    await mkdir(join(root, ".red"), { recursive: true });
    await writeFile(join(root, ".red", "config.yaml"), [
      "plugins:",
      "  memory:",
      "    enabled: true",
      "    mode: graph",
      "    storePath: .red/red.rdb",
      "",
    ].join("\n"), "utf8");

    await expect(migrateStorePathToRepoStore(root)).resolves.toMatchObject({
      configChanged: false,
      storeCopied: false,
    });
  });
});
