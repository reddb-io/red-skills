import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { rm } from "node:fs/promises";
import {
  configPath,
  HOOKS_ALL_ON,
  HOOKS_OFF,
  readConfig,
  resolveHooks,
  skillTelemetryEnabled,
} from "../src/config.js";
import { graphConfig, initMarkdownOnly, markdownOnlyConfig } from "../src/init.js";

const roots: string[] = [];
async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "memory-init-"));
  roots.push(dir);
  return dir;
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

  test("writes config to .red/memory/config.json and creates notes dir", async () => {
    const root = await tempRoot();
    const result = await initMarkdownOnly(root);

    expect(result.configPath).toBe(configPath(root));
    const written = JSON.parse(await readFile(result.configPath, "utf8"));
    expect(written.mode).toBe("markdown-only");
    expect(written.hooks.sessionStart).toBe(false);
    expect(written.mcp).toBe(false);

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
