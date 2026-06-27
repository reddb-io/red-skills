/**
 * Tests for `hooks-to-events.ts` — the pure planner for the
 * claude/codex.hooks.json → opencode plugin TS module mapping
 * (ADR 0077).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listHookFiles,
  matcherToRegex,
  planPluginHooks,
  rewritePluginRoot,
} from "../src/hooks-to-events.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-host-hooks-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeHookFile(name: string, body: object): void {
  const dir = join(root, "dev", "hooks");
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), JSON.stringify(body), "utf8");
}

describe("listHookFiles", () => {
  it("returns only the hook files that exist on disk, in priority order", () => {
    writeHookFile("claude.hooks.json", { hooks: {} });
    const only = listHookFiles(root, "dev").map((p) => p.split("/").pop());
    expect(only).toEqual(["claude.hooks.json"]);

    writeHookFile("codex.hooks.json", { hooks: {} });
    const both = listHookFiles(root, "dev").map((p) => p.split("/").pop());
    expect(both).toEqual(["codex.hooks.json", "claude.hooks.json"]);
  });
});

describe("rewritePluginRoot (ADR 0077 §3)", () => {
  it("rewrites ${CODEX_PLUGIN_ROOT} to a __pluginRoot template", () => {
    const cmd = `sh -c 'cat ${"$"}{CODEX_PLUGIN_ROOT}/hooks/red-fetch.mjs'`;
    expect(rewritePluginRoot(cmd, "dev")).toBe(
      `sh -c 'cat ${"$"}{__pluginRoot}/hooks/red-fetch.mjs'`,
    );
  });
  it("rewrites ${CLAUDE_PLUGIN_ROOT} too", () => {
    const cmd = `sh -c 'cat ${"$"}{CLAUDE_PLUGIN_ROOT}/hooks/red-fetch.mjs'`;
    expect(rewritePluginRoot(cmd, "dev")).toBe(
      `sh -c 'cat ${"$"}{__pluginRoot}/hooks/red-fetch.mjs'`,
    );
  });
  it("leaves absolute paths alone", () => {
    const cmd = `sh -c 'cat /opt/red-fetch.mjs'`;
    expect(rewritePluginRoot(cmd, "dev")).toBe(cmd);
  });
});

describe("planPluginHooks (real claude.hooks.json shape)", () => {
  it("emits one config-event module for SessionStart", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "sh -c 'red-fetch.mjs dev'" },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const session = plans.find((p) => p.opencodeEvent === "config");
    expect(session).toBeDefined();
    expect(session!.sourceEvent).toBe("SessionStart");
    expect(session!.target).toBe("plugin/session-start.ts");
    expect(session!.source).toMatch(/config/);
    expect(session!.source).toMatch(/@opencode-ai\/plugin/);
  });

  it("emits one tool.execute.before module for PreToolUse, branching on input.tool", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "sh -c 'branch-lock.sh'" }],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before");
    expect(pre).toBeDefined();
    expect(pre!.source).toMatch(/input\.tool/);
    expect(pre!.source).toMatch(/Bash/);
  });

  it("emits the route-model-tier branch when the Task|Agent matcher is also present", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "sh -c 'branch-lock.sh'" }],
          },
          {
            matcher: "Task|Agent",
            hooks: [{ type: "command", command: "sh -c 'red-fetch.mjs route-model-tier'" }],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    expect(pre.source).toMatch(/Task\|Agent/);
  });

  it("emits both modules when both events are present", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        SessionStart: [
          { hooks: [{ type: "command", command: "sh -c 'red-fetch.mjs dev'" }] },
        ],
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [{ type: "command", command: "sh -c 'branch-lock.sh'" }],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    expect(plans.map((p) => p.opencodeEvent).sort()).toEqual(["config", "tool.execute.before"]);
  });

  it("warns (and continues) for an unknown event class", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "sh -c 'echo hi'" }] },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    // No module emitted, but the warning is captured
    expect(plans).toEqual([]);
  });

  it("returns no plans when no hook files exist", () => {
    expect(planPluginHooks(root, "dev")).toEqual([]);
  });
});

describe("matcherToRegex (Claude/Codex matcher → JS regex)", () => {
  it("anchors a single-name matcher", () => {
    expect(matcherToRegex("Bash")).toBe("/^(Bash)$/");
  });
  it("translates a | -separated list into a regex alternation", () => {
    expect(matcherToRegex("Task|Agent")).toBe("/^(Task|Agent)$/");
  });
  it("escapes regex metachars in alternation", () => {
    expect(matcherToRegex("foo.bar")).toBe("/^(foo\\.bar)$/");
  });
  it("treats * and empty as wildcard", () => {
    expect(matcherToRegex("*")).toBe("/.*/");
    expect(matcherToRegex("")).toBe("/.*/");
  });
});
