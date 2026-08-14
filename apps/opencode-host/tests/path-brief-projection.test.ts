import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { planPluginHooks } from "../src/hooks-to-events.js";

const REPO = new URL("../../..", import.meta.url).pathname;
const PLUGINS_ROOT = `${REPO}plugins`;

describe("path brief host projection", () => {
  it("projects the edit hook through Codex and OpenCode from the shipped manifests", () => {
    const codexManifest = JSON.parse(
      readFileSync(`${PLUGINS_ROOT}/dev/hooks/codex.hooks.json`, "utf8"),
    ) as {
      hooks: { PostToolUse: Array<{ matcher?: string; hooks: Array<{ command: string }> }> };
    };
    const codexPathBriefs = codexManifest.hooks.PostToolUse
      .filter((group) => group.hooks.some((hook) => hook.command.includes(" path-brief ")))
      .map((group) => ({
        matcher: group.matcher,
        pluginRoot: group.hooks[0]?.command.includes("CODEX_PLUGIN_ROOT") ? "CODEX_PLUGIN_ROOT" : "missing",
        invocation: group.hooks[0]?.command.includes('run dev path-brief --plugin-root "$root"')
          ? 'run dev path-brief --plugin-root "$root"'
          : "missing",
      }));

    const openCodePostTool = planPluginHooks(PLUGINS_ROOT, "dev")
      .find((plan) => plan.sourceEvent === "PostToolUse")!;
    const openCodePathBrief = {
      sourceEvent: openCodePostTool.sourceEvent,
      opencodeEvent: openCodePostTool.opencodeEvent,
      target: openCodePostTool.target,
      applyPatchMatcher: openCodePostTool.source.includes("/^(apply_patch)$/i.test(input.tool)"),
      editWriteMatcher: openCodePostTool.source.includes("/^(Edit|Write)$/i.test(input.tool)"),
      projectedCommands: openCodePostTool.source.match(/run dev path-brief/g)?.length ?? 0,
      injectsContext: openCodePostTool.source.includes(
        'output.output = [__ctx, output.output].filter(Boolean).join("\\n\\n")',
      ),
    };

    expect({ codexPathBriefs, openCodePathBrief }).toMatchInlineSnapshot(`
      {
        "codexPathBriefs": [
          {
            "invocation": "run dev path-brief --plugin-root \"$root\"",
            "matcher": "apply_patch",
            "pluginRoot": "CODEX_PLUGIN_ROOT",
          },
        ],
        "openCodePathBrief": {
          "applyPatchMatcher": true,
          "editWriteMatcher": true,
          "injectsContext": true,
          "opencodeEvent": "tool.execute.after",
          "projectedCommands": 2,
          "sourceEvent": "PostToolUse",
          "target": "plugin/post-tool-use.ts",
        },
      }
    `);
  });
});
