/**
 * Tests for `statusline.ts` — the Slice 4 planner that emits
 * the `session-status.ts` opencode plugin module (ADR 0080).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { planPluginStatusline } from "../src/statusline.js";

const REAL_PLUGINS = new URL("../../..", import.meta.url).pathname + "plugins";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-host-statusline-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeFile(rel: string, body: string): void {
  const abs = join(root, rel);
  const dir = abs.substring(0, abs.lastIndexOf("/"));
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(abs, body, "utf8");
}

describe("planPluginStatusline (ADR 0080)", () => {
  it("returns no plan for non-dev plugins (memory and brain ship no statusline)", () => {
    expect(planPluginStatusline(root, "memory")).toEqual([]);
    expect(planPluginStatusline(root, "brain")).toEqual([]);
  });

  it("warns and emits a no-op module when the dev manifest carries no version", () => {
    const plans = planPluginStatusline(root, "dev");
    expect(plans.length).toBe(1);
    const [plan] = plans;
    expect(plan.target).toBe("plugin/session-status.ts");
    expect(plan.warnings.length).toBe(1);
    expect(plan.warnings[0]).toMatch(/no version in plugins\/dev\/\.claude-plugin\/plugin\.json/);
    // The module is still emitted; the spawn will fail at
    // runtime (no launcher at directory/skills/.../afk.mjs) and
    // the toast becomes a silent no-op. The build does not
    // fail-closed because the rest of the install is unaffected.
    expect(plan.source).toContain("REDSKILLED_VERSION");
  });

  it("emits a working module pinned to the manifest version", () => {
    writeFile(
      "dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", version: "9.9.9" }),
    );
    const plans = planPluginStatusline(root, "dev");
    expect(plans.length).toBe(1);
    const [plan] = plans;
    expect(plan.warnings).toEqual([]);
    // The module references the AFK_BIN constant (relative path)
    // and joins it against the opencode plugin context's
    // `directory` at runtime — the absolute path is resolved
    // by the user-side plugin loader, not baked in at build
    // time (unlike Slice 3's MCP passthrough, the AFK launcher
    // lives in the same checkout the user is running from).
    expect(plan.source).toContain("REDSKILLED_VERSION");
    expect(plan.source).toContain("red-skills-redskilled statusline");
  });
});

describe("session-status module shape", () => {
  it("subscribes to session.idle, session.error, session.created, and experimental.session.compacting", () => {
    writeFile(
      "dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", version: "9.9.9" }),
    );
    const [plan] = planPluginStatusline(root, "dev");
    expect(plan.source).toMatch(/"session\.idle"/);
    expect(plan.source).toMatch(/"session\.error"/);
    expect(plan.source).toMatch(/"session\.created"/);
    expect(plan.source).toMatch(/"experimental\.session\.compacting"/);
  });

  it("uses the opencode plugin API (tui.showToast, tui.appendPrompt, context push)", () => {
    writeFile(
      "dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", version: "9.9.9" }),
    );
    const [plan] = planPluginStatusline(root, "dev");
    expect(plan.source).toMatch(/tui\.showToast/);
    expect(plan.source).toMatch(/tui\.appendPrompt/);
    expect(plan.source).toMatch(/output\.context\.push/);
  });

  it("spawns the AFK statusline via Bun shell (slice 4 surface contract)", () => {
    writeFile(
      "dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", version: "9.9.9" }),
    );
    const [plan] = planPluginStatusline(root, "dev");
    expect(plan.source).toMatch(/Bun\.\$/);
    expect(plan.source).toMatch(/statusline/);
  });

  it("strips ANSI escape codes before surfacing the line to the toast", () => {
    writeFile(
      "dev/.claude-plugin/plugin.json",
      JSON.stringify({ name: "dev", version: "9.9.9" }),
    );
    const [plan] = planPluginStatusline(root, "dev");
    expect(plan.source).toMatch(/stripAnsi/);
    expect(plan.source).toMatch(/u001b/);
  });
});

describe("planPluginStatusline against the real source tree", () => {
  it("emits a working session-status module for the dev plugin", () => {
    const plans = planPluginStatusline(REAL_PLUGINS, "dev");
    expect(plans.length).toBe(1);
    expect(plans[0]!.warnings).toEqual([]);
    expect(plans[0]!.source).toContain("red-skills-redskilled statusline");
  });
});
