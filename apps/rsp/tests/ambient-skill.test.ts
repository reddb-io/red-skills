import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RSP_WRAPPER_CAPABILITIES } from "../src/intercept.js";
import { AMBIENT_SKILL_RELATIVE_PATH, renderAmbientSkill } from "../src/ambient-skill.js";

const packageRoot = join(import.meta.dirname, "..");

describe("rsp ambient skill generator", () => {
  it("renders one table row per wrapper capability from the single source", () => {
    const markdown = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES);
    for (const capability of RSP_WRAPPER_CAPABILITIES) {
      const command = capability.command.join(" ");
      const wrapper = ["rsp", ...capability.wrapper].join(" ");
      expect(markdown).toContain(`| \`${command}\` | \`${wrapper}\` |`);
    }
  });

  it("renders added fixture capabilities without changing the generator", () => {
    const markdown = renderAmbientSkill([
      ...RSP_WRAPPER_CAPABILITIES,
      { id: "fixture:doctor", command: ["doctor", "check"], wrapper: ["doctor", "check"] },
    ]);

    expect(markdown).toContain("| `doctor check` | `rsp doctor check` |");
    expect(markdown).toContain("prefer `rsp doctor check` when the summarized output is enough");
  });

  it("documents call forms, loss levels, retrieval, truncation, and passthrough behavior", () => {
    const markdown = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES);
    for (const capability of RSP_WRAPPER_CAPABILITIES) {
      const wrapper = ["rsp", ...capability.wrapper].join(" ");
      expect(markdown).toContain(`prefer \`${wrapper}\` when the summarized output is enough`);
    }
    expect(markdown).toContain("Use `--brief` for compact summaries");
    expect(markdown).toContain("Use `--terse` for large or repetitive output");
    expect(markdown).toContain("Use `--full` when exact inline output is required");
    expect(markdown).toContain("| `cat <file>` | `rsp cat <file>` |");
    expect(markdown).toContain("code files render an outline plus bounded content");
    expect(markdown).toContain("host pre-exec hook may rewrite bare `cat <file>`");
    expect(markdown).toContain("`rsp cat <file>`, large `rsp git diff`, and large `rsp git log` output may");
    expect(markdown).toContain("call `rsp exec -- \"<command line>\"`");
    expect(markdown).toContain("Bytes inside pipes remain untouched");
    expect(markdown).toContain("Bare `rsp` renders a live TOON dashboard");
    expect(markdown).toContain("Use `--help` after any subcommand for scoped flags, defaults, and examples.");
    expect(markdown).toContain("Outputs may include `next_steps` templates with placeholders");
    expect(markdown).toContain("If an rsp wrapper is disabled, lacks its store, or fails, it passes through to the raw command");
    expect(markdown).toContain("`rsp show el:<id>` writes the original bytes verbatim to stdout");
  });

  it("describes the synchronous data plane and lazy resident control plane", () => {
    const markdown = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES);

    expect(markdown).toContain("## Core model");
    expect(markdown).toContain("The command boundary is the synchronous data plane");
    expect(markdown).toContain("Unknown simple argv runs");
    expect(markdown).toContain("The resident is the lazy control plane");
    expect(markdown).toContain("create no rsp state");
    expect(markdown).toContain(
      "No surface is a privileged or canonical contact point",
    );
    expect(markdown).toContain("server connected is fully supported");
    expect(markdown).toContain(
      "An unreachable resident costs the elision, never the command",
    );
  });

  it("renders runner-specific guidance for Claude and Codex interception", () => {
    const codex = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES, { runner: "codex" });
    const claude = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES, { runner: "claude" });
    const opencode = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES, { runner: "opencode" });

    expect(codex).toContain("Codex lane");
    expect(codex).toContain("pre-execution rewrite hook is available");
    expect(codex).toContain("Codex PostToolUse cannot");
    expect(claude).toContain("Claude lane");
    expect(claude).toContain("pre-execution interception is available");
    expect(opencode).toContain("OpenCode lane");
    expect(opencode).toContain("opencode plugin surface");
  });

  it("committed artifact matches the generator output (drift check)", () => {
    const committed = readFileSync(join(packageRoot, AMBIENT_SKILL_RELATIVE_PATH), "utf8");
    expect(committed).toEqual(renderAmbientSkill(RSP_WRAPPER_CAPABILITIES));
  });
});
