/**
 * End-to-end smoke: real `plugins/dev/skills/engineering/afk/SKILL.md`
 * + the real `plugins/dev/hooks/claude.hooks.json` flow through the
 * planner and produce a non-empty, structurally valid dist plan.
 *
 * No filesystem writes happen here — the test exercises the pure
 * plan path against the actual source tree the user ships. The
 * `writeEmit` smoke is in `slice-2-cli.test.ts` (subprocess).
 */
import { describe, expect, it } from "vitest";
import { listPluginDirs } from "../src/plugin-discovery.js";
import { planEmit } from "../src/emit.js";
import { planPluginSkills } from "../src/skills-to-opencode.js";
import { planPluginHooks } from "../src/hooks-to-events.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const PLUGINS_ROOT = `${REPO}plugins`;

describe("end-to-end against the real source tree", () => {
  it("discovers dev, memory, brain under plugins/", () => {
    const plugins = listPluginDirs(PLUGINS_ROOT).map((p) => p.name);
    expect(plugins).toContain("dev");
    expect(plugins).toContain("memory");
    expect(plugins).toContain("brain");
  });

  it("plans the dev plugin's skills (afk, retake, triage all present)", () => {
    const result = planPluginSkills(PLUGINS_ROOT, "dev");
    const names = result.plans.map((p) => p.name);
    // afk, retake, triage are the most-used dev skills, all in the
    // engineering bucket
    for (const expected of ["afk", "retake", "triage"]) {
      expect(names).toContain(expected);
    }
    // in-progress skills are skipped (writing-beats, writing-fragments,
    // writing-shape are all in-progress only)
    for (const skipped of ["writing-beats", "writing-fragments", "writing-shape"]) {
      expect(names).not.toContain(skipped);
    }
    // No errors on the curated set
    expect(result.errors).toEqual([]);
  });

  // #4031 deleted the `path-brief` command with the dev CLI, and its PostToolUse
  // hook went with it — a hook whose command no longer exists is a hook that
  // fails on every tool call. Two events remain.
  it("plans the dev plugin's hooks (SessionStart + PreToolUse)", () => {
    const plans = planPluginHooks(PLUGINS_ROOT, "dev");
    const events = plans.map((p) => p.opencodeEvent).sort();
    expect(events).toEqual(["config", "tool.execute.before"]);
  });

  it("emits a full plan with skills and hooks for every plugin", () => {
    const plan = planEmit({
      pluginsRoot: PLUGINS_ROOT,
      plugins: ["dev", "memory", "brain"],
      configText: "plugins:\n  dev:\n    enabled: true\n",
      env: { OPENROUTER_API_KEY: "sk-or-test" },
    });
    expect(plan.byPlugin.length).toBe(3);
    const dev = plan.byPlugin.find((p) => p.plugin === "dev")!;
    const memory = plan.byPlugin.find((p) => p.plugin === "memory")!;
    expect(dev.skills.plans.length).toBeGreaterThan(30);
    // Two, not three, since #4031: the PostToolUse path-brief hook went with
    // the CLI command it invoked.
    expect(dev.hooks.length).toBe(2);
    expect(memory.hooks.map((p) => p.opencodeEvent).sort()).toEqual([
      "config",
      "experimental.session.compacting",
      "session.idle",
      "tool.execute.after",
    ]);
    expect(dev.provider.model).toBe("openrouter/anthropic/claude-3.5-sonnet");
    expect(dev.provider.provider.openrouter).toBeDefined();
  });
});
