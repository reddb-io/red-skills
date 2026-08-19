/**
 * Tests for `hooks-to-events.ts` — the pure planner for the
 * claude/codex.hooks.json → opencode plugin TS module mapping
 * (ADR 0077).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
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

  it("preserves every SessionStart command and forwards hook output into chat system context", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: "command", command: "sh -c 'red-fetch.mjs dev'" },
              { type: "command", command: "sh -c 'red-fetch.mjs run dev rsp-instructions --runner claude --hook'" },
              { type: "command", command: "sh -c 'ensure-codex-statusline.mjs'" },
            ],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const session = plans.find((p) => p.opencodeEvent === "config")!;
    expect(session.source).toContain("red-fetch.mjs dev");
    expect(session.source).toContain("rsp-instructions");
    expect(session.source).toContain("--runner opencode --hook");
    expect(session.source).not.toContain("--runner claude --hook");
    expect(session.source).toContain("ensure-codex-statusline");
    expect(session.source).toContain('"experimental.chat.system.transform"');
    expect(session.source).toContain("hookSpecificOutput?.additionalContext");
    expect(session.source).toContain("systemMessage");
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

  it("maps PostToolUse to tool.execute.after with tool response payload", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PostToolUse: [
          {
            matcher: "Edit|Write",
            hooks: [{ type: "command", command: "sh -c 'post-tool.sh'" }],
          },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const post = plans.find((p) => p.opencodeEvent === "tool.execute.after")!;
    expect(post).toBeDefined();
    expect(post.sourceEvent).toBe("PostToolUse");
    expect(post.target).toBe("plugin/post-tool-use.ts");
    expect(post.source).toContain('"tool.execute.after"');
    expect(post.source).toContain('const __sourceEvent = "PostToolUse"');
    expect(post.source).toContain("hook_event_name: __sourceEvent");
    expect(post.source).toContain("tool_response");
    expect(post.source).toContain("Edit|Write");
  });

  it("maps Stop to session.idle and includes best-effort session transcript text", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        Stop: [
          { hooks: [{ type: "command", command: "sh -c 'memory-stop.sh'" }] },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const stop = plans.find((p) => p.opencodeEvent === "session.idle")!;
    expect(stop).toBeDefined();
    expect(stop.sourceEvent).toBe("Stop");
    expect(stop.target).toBe("plugin/stop.ts");
    expect(stop.source).toContain('"session.idle"');
    expect(stop.source).toContain('const __sourceEvent = "Stop"');
    expect(stop.source).toContain("hook_event_name: __sourceEvent");
    expect(stop.source).toContain("transcript_text");
    expect(stop.source).toContain("sessionApi.messages");
  });

  it("emits lexically valid Stop bindings for the Codex and Claude adapter commands", () => {
    writeHookFile("codex.hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `sh -c 'tmp="$(mktemp)"; trap "rm -f \\"$tmp\\"" EXIT; timeout "${"$"}{RED_SKILLS_HOOK_STDIN_TIMEOUT_S:-5s}" cat >"$tmp" 2>/dev/null || true; timeout "${"$"}{RED_SKILLS_HOOK_TIMEOUT_S:-3s}" node "${"$"}{CODEX_PLUGIN_ROOT}/scripts/bootstrap.mjs" hook Stop --runner codex <"$tmp" || printf "{}"'`,
              },
            ],
          },
        ],
      },
    });
    writeHookFile("claude.hooks.json", {
      hooks: {
        Stop: [
          {
            hooks: [
              {
                type: "command",
                command: `sh -c 'timeout "${"$"}{RED_SKILLS_HOOK_TIMEOUT_S:-3s}" node "${"$"}{CLAUDE_PLUGIN_ROOT}/scripts/bootstrap.mjs" hook Stop --runner claude || printf "{}"'`,
              },
            ],
          },
        ],
      },
    });

    const stop = planPluginHooks(root, "dev").find((plan) => plan.sourceEvent === "Stop")!;
    const compiled = ts.transpileModule(stop.source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    });

    expect(stop.source).toContain("--runner codex");
    expect(stop.source).toContain("--runner claude");
    expect(() => Function(compiled.outputText)).not.toThrow();
  });

  it("maps PreCompact to experimental.session.compacting", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreCompact: [
          { hooks: [{ type: "command", command: "sh -c 'memory-precompact.sh'" }] },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const preCompact = plans.find((p) => p.opencodeEvent === "experimental.session.compacting")!;
    expect(preCompact).toBeDefined();
    expect(preCompact.sourceEvent).toBe("PreCompact");
    expect(preCompact.target).toBe("plugin/pre-compact.ts");
    expect(preCompact.source).toContain('"experimental.session.compacting"');
    expect(preCompact.source).toContain('const __sourceEvent = "PreCompact"');
    expect(preCompact.source).toContain("hook_event_name: __sourceEvent");
  });

  it("maps UserPromptSubmit to chat.message when a hook file declares it", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: "command", command: "sh -c 'prompt-hook.sh'" }] },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    const prompt = plans.find((p) => p.opencodeEvent === "chat.message")!;
    expect(prompt).toBeDefined();
    expect(prompt.sourceEvent).toBe("UserPromptSubmit");
    expect(prompt.target).toBe("plugin/user-prompt-submit.ts");
    expect(prompt.source).toContain('"chat.message"');
    expect(prompt.source).toContain('const __sourceEvent = "UserPromptSubmit"');
    expect(prompt.source).toContain("hook_event_name: __sourceEvent");
  });

  it("warns (and continues) for an event class OpenCode cannot express", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        SubagentStop: [
          { hooks: [{ type: "command", command: "sh -c 'echo hi'" }] },
        ],
        PreToolUse: [
          { hooks: [{ type: "command", command: "sh -c 'branch-lock.sh'" }] },
        ],
      },
    });
    const plans = planPluginHooks(root, "dev");
    expect(plans.map((p) => p.opencodeEvent)).toEqual(["tool.execute.before"]);
    expect(plans[0]!.warnings.join("\n")).toContain("SubagentStop");
    expect(plans[0]!.warnings.join("\n")).toContain("OpenCode plugin event equivalent");
  });

  it("returns no plans when no hook files exist", () => {
    expect(planPluginHooks(root, "dev")).toEqual([]);
  });
});

describe("isRspRewriteHook (ADR 0095 Decision 7)", () => {
  it("identifies hook claude-pre-exec invocations", () => {
    expect(isRspRewriteHook("node rsp.bundle.min.mjs hook claude-pre-exec")).toBe(true);
    expect(isRspRewriteHook("for f in ...; do node \"$f\" hook claude-pre-exec <\"$tmp\"; exit $?; done")).toBe(true);
    expect(isRspRewriteHook('"${CLAUDE_PLUGIN_ROOT}/hooks/rsp-hook.sh" claude-pre-exec')).toBe(true);
  });

  it("does not classify other rsp subcommands as rewrite hooks", () => {
    expect(isRspRewriteHook("node rsp.bundle.min.mjs git status")).toBe(false);
    expect(isRspRewriteHook('"${CLAUDE_PLUGIN_ROOT}/hooks/rsp-hook.sh" claude-post-exec')).toBe(false);
    expect(isRspRewriteHook("bash branch-lock.sh")).toBe(false);
    expect(isRspRewriteHook("")).toBe(false);
  });
});

describe("planPluginHooks — rsp rewrite delegation (ADR 0095 Decision 7)", () => {
  it("generates a rewrite module when the hook invokes rsp-hook.sh claude-pre-exec", () => {
    writeHookFile("claude.hooks.json", {
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash",
            hooks: [
              {
                type: "command",
                command: "sh -c '\"${CLAUDE_PLUGIN_ROOT}/hooks/rsp-hook.sh\" claude-pre-exec'",
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
    expect(pre.source).toContain("rsp-hook.sh");
    expect(pre.source).toContain("claude-pre-exec");
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
