import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import {
  configPath,
  DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
  HOOKS_ALL_ON,
  HOOKS_OFF,
  readConfig,
  resolveHooks,
  skillTelemetryEnabled,
} from "../src/config.js";
import { graphConfig, initMarkdownOnly, markdownOnlyConfig } from "../src/init.js";
import { MEMORY_COLLECTION_VERSIONING } from "../src/vcs-versioned-collections.js";

const TIMEOUT = 30_000;
const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, "..");
const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-init-"));
  roots.push(dir);
  return dir;
}

function runMemory(args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
    cwd: PLUGIN_ROOT,
    encoding: "utf8",
    timeout: TIMEOUT,
  });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("markdown-only init", () => {
  test("config has hooks off, mcp off, reddb not required", () => {
    const config = markdownOnlyConfig();
    expect(config.mode).toBe("markdown-only");
    expect(config.hooks).toEqual({
      sessionStart: false,
      postToolUse: false,
      stop: false,
      preCompact: false,
    });
    expect(config.mcp).toBe(false);
    expect(config.reddb).toBe(false);
  });

  test("writes the plugins.memory block to .red/config.yaml and creates notes dir", async () => {
    const root = await tempRoot();
    const result = await initMarkdownOnly(root);

    expect(result.configPath).toBe(configPath(root));
    expect(result.configPath.endsWith("/.red/config.yaml")).toBe(true);
    const written = await readFile(result.configPath, "utf8");
    expect(written).toContain("plugins:");
    expect(written).toContain("  memory:");
    expect(written).toContain("    mode: markdown-only");
    // sparse: derived/default fields are not persisted
    expect(written).not.toContain("reddb:");
    expect(written).not.toContain("version:");

    const notesStat = await stat(result.notesDir);
    expect(notesStat.isDirectory()).toBe(true);
  });

  test("readConfig round-trips what init wrote", async () => {
    const root = await tempRoot();
    await initMarkdownOnly(root);
    const config = await readConfig(root);
    expect(config?.mode).toBe("markdown-only");
    expect(config?.hooks.stop).toBe(false);
  });

  test("readConfig returns null before init", async () => {
    const root = await tempRoot();
    expect(await readConfig(root)).toBeNull();
  });
});

describe("hook gating — enable/disable choices produce the right active set", () => {
  test("markdown-only never gets hooks, whatever the choice", () => {
    expect(resolveHooks("markdown-only", true)).toEqual(HOOKS_OFF);
    expect(resolveHooks("markdown-only", { sessionStart: true })).toEqual(HOOKS_OFF);
    expect(markdownOnlyConfig().hooks).toEqual(HOOKS_OFF);
  });

  test("graph mode honors the opt-in: all on, all off, or a subset", () => {
    expect(resolveHooks("graph", true)).toEqual(HOOKS_ALL_ON);
    expect(resolveHooks("graph", false)).toEqual(HOOKS_OFF);
    expect(resolveHooks("graph", undefined)).toEqual(HOOKS_OFF);
    expect(resolveHooks("graph", { sessionStart: true, stop: true })).toEqual({
      sessionStart: true,
      postToolUse: false,
      stop: true,
      preCompact: false,
    });
  });

  test("graphConfig defaults hooks off but enables them on opt-in", () => {
    expect(graphConfig().hooks).toEqual(HOOKS_OFF);
    expect(graphConfig({ hooks: true }).hooks).toEqual(HOOKS_ALL_ON);
    expect(graphConfig({ hooks: { preCompact: true } }).hooks.preCompact).toBe(true);
    expect(graphConfig({ hooks: { preCompact: true } }).hooks.stop).toBe(false);
  });
});

describe("skill telemetry opt-in — graph-mode explicit flag", () => {
  test("graph defaults skill telemetry off (existing default behavior)", () => {
    const config = graphConfig();
    expect(config.skillTelemetry).toBe(false);
    expect(skillTelemetryEnabled(config)).toBe(false);
  });

  test("graph can enable skill telemetry explicitly", () => {
    const config = graphConfig({ skillTelemetry: true });
    expect(config.skillTelemetry).toBe(true);
    expect(skillTelemetryEnabled(config)).toBe(true);
  });

  test("markdown-only never carries skill telemetry — it is unsupported", () => {
    const config = markdownOnlyConfig();
    expect(config.skillTelemetry).toBeUndefined();
    expect(skillTelemetryEnabled(config)).toBe(false);
  });

  test("skillTelemetryEnabled requires graph mode even if the flag is set", () => {
    expect(skillTelemetryEnabled({ ...markdownOnlyConfig(), skillTelemetry: true })).toBe(false);
  });

  test("legacy graph config without the field reads as telemetry off", () => {
    const { skillTelemetry, ...legacy } = graphConfig();
    expect(skillTelemetry).toBe(false);
    expect(skillTelemetryEnabled(legacy)).toBe(false);
  });
});

describe("Memory event log retention config", () => {
  test("graph mode documents the default raw event retention horizon", () => {
    expect(DEFAULT_MEMORY_EVENT_RETENTION_DAYS).toBe(30);
    expect(graphConfig().eventLog).toEqual({
      retentionDays: DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
    });
  });

  test("graph mode can override the raw event retention horizon", () => {
    expect(graphConfig({ eventRetentionDays: 7 }).eventLog).toEqual({
      retentionDays: 7,
    });
  });

  test("graph init can set the raw event retention horizon", async () => {
    const root = await tempRoot();
    const result = runMemory([
      "init",
      "--mode",
      "graph",
      "--root",
      root,
      "--event-retention-days",
      "7",
      "--yes",
    ]);

    expect(result.status).toBe(0);
    await expect(readConfig(root)).resolves.toMatchObject({
      mode: "graph",
      eventLog: { retentionDays: 7 },
    });
  });
});

describe("graph init VCS opt-in", () => {
  test(
    "reports the versioned and skipped Memory collection boundary",
    async () => {
      const root = await tempRoot();
      const result = runMemory(["init", "--mode", "graph", "--root", root, "--yes"]);

      const expectedVersioned = MEMORY_COLLECTION_VERSIONING.filter((c) =>
        c.tiers.some((tier) => tier === "durable" || tier === "reasoning"),
      ).map((c) => c.name);
      const expectedSkipped = MEMORY_COLLECTION_VERSIONING.filter((c) =>
        c.tiers.every((tier) => tier === "ephemeral"),
      ).map((c) => c.name);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`vcs versioned: ${expectedVersioned.join(", ")}`);
      expect(result.stdout).toContain(`vcs skipped:   ${expectedSkipped.join(", ")}`);
    },
    TIMEOUT,
  );
});
