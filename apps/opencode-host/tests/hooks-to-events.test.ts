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
  isRspRewriteHook,
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
    expect(session!.source).toMatch(/return \{\s+config: async/s);
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
    expect(pre!.source).toMatch(/JSON\.stringify/);
    expect(pre!.source).toMatch(/proc\.stdin\.getWriter/);
    expect(pre!.source).toMatch(/CLAUDE_PLUGIN_ROOT: __pluginRoot/);
    expect(pre!.source).toMatch(/Bash/);
  });

  it("preserves every PreToolUse command for the matched tool instead of reducing to hardcoded guards", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              { type: "command", command: "sh -c 'branch-lock.sh'" },
              { type: "command", command: "sh -c 'command-guard.sh'" },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    expect(pre.source).toMatch(/branch-lock\.sh/);
    expect(pre.source).toMatch(/command-guard\.sh/);
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

describe("isRspRewriteHook (ADR 0095 Decision 7)", () => {
  it("identifies hook claude-pre-exec invocations", () => {
    expect(isRspRewriteHook("node rsp.bundle.min.mjs hook claude-pre-exec")).toBe(true);
    expect(isRspRewriteHook("for f in ...; do node \"$f\" hook claude-pre-exec <\"$tmp\"; exit $?; done")).toBe(true);
  });

  it("does not classify other rsp subcommands as rewrite hooks", () => {
    expect(isRspRewriteHook("node rsp.bundle.min.mjs git status")).toBe(false);
    expect(isRspRewriteHook("bash branch-lock.sh")).toBe(false);
    expect(isRspRewriteHook("")).toBe(false);
  });
});

describe("planPluginHooks — rsp rewrite delegation (ADR 0095 Decision 7)", () => {
  it("generates a rewrite module when the hook invokes hook claude-pre-exec", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "sh -c 'node \"${CLAUDE_PLUGIN_ROOT}/../../dist/rsp.bundle.min.mjs\" hook claude-pre-exec'",
              },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    expect(pre).toBeDefined();
    // Must contain the rewrite helper — the module delegates, not copies.
    expect(pre.source).toContain("__runRspRewrite");
    expect(pre.source).toContain("hook claude-pre-exec");
    // Must apply the rewrite to output.args.command.
    expect(pre.source).toContain("output.args = { ...output.args, command: __rewritten }");
    // Must return null on passthrough (exit 1) — not block.
    expect(pre.source).toContain("if (result.exitCode !== 0) return null");
  });

  it("does NOT emit __runRspRewrite when there are no rsp-style hooks (no dead code)", () => {
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
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    expect(pre.source).not.toContain("__runRspRewrite");
  });

  it("contains no allowlist copy — the generated module delegates to rsp, not a local table", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "sh -c 'node \"${CLAUDE_PLUGIN_ROOT}/dist/rsp.bundle.min.mjs\" hook claude-pre-exec'",
              },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    // None of the rsp capability table entries may appear literally.
    expect(pre.source).not.toContain("RSP_WRAPPER_CAPABILITIES");
    expect(pre.source).not.toContain("git\\0status");
    expect(pre.source).not.toContain("rsp git status");
    expect(pre.source).not.toContain("gh pr list");
  });

  it("mixes rsp-rewrite and block-deny hooks in the same module correctly", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "sh -c 'node \"${CLAUDE_PLUGIN_ROOT}/dist/rsp.bundle.min.mjs\" hook claude-pre-exec'",
              },
              { type: "command", command: "sh -c 'branch-lock.sh'" },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const pre = plans.find((p) => p.opencodeEvent === "tool.execute.before")!;
    // Both helpers must be present.
    expect(pre.source).toContain("__runRspRewrite");
    expect(pre.source).toContain("__runHook");
    // Rsp hook uses rewrite path; block hook uses block path.
    expect(pre.source).toContain("__rewritten");
    expect(pre.source).toContain("__blocked");
    expect(pre.source).toContain("branch-lock.sh");
  });
});

describe("matcherToRegex (Claude/Codex matcher → JS regex)", () => {
  it("anchors a single-name matcher", () => {
    expect(matcherToRegex("Bash")).toBe("/^(Bash)$/i");
  });
  it("translates a | -separated list into a regex alternation", () => {
    expect(matcherToRegex("Task|Agent")).toBe("/^(Task|Agent)$/i");
  });
  it("escapes regex metachars in alternation", () => {
    expect(matcherToRegex("foo.bar")).toBe("/^(foo\\.bar)$/i");
  });
  it("treats * and empty as wildcard", () => {
    expect(matcherToRegex("*")).toBe("/.*/");
    expect(matcherToRegex("")).toBe("/.*/");
  });
});
