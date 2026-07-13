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
    expect(markdown).toContain("Large `rsp git diff` and `rsp git log` output is threshold-gated");
    expect(markdown).toContain("call `rsp exec -- \"<command line>\"` directly");
    expect(markdown).toContain("Bytes inside pipes remain untouched");
    expect(markdown).toContain("If an rsp wrapper is disabled, lacks its store, or fails, it passes through to the raw command");
    expect(markdown).toContain("`rsp show el:<id>` writes the original bytes verbatim to stdout");
  });

  it("renders runner-specific guidance without claiming interception for Codex", () => {
    const codex = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES, { runner: "codex" });
    const claude = renderAmbientSkill(RSP_WRAPPER_CAPABILITIES, { runner: "claude" });

    expect(codex).toContain("Codex lane");
    expect(codex.toLowerCase()).not.toContain("interception");
    expect(claude).toContain("Claude lane");
    expect(claude).toContain("pre-execution interception is available");
  });

  it("committed artifact matches the generator output (drift check)", () => {
    const committed = readFileSync(join(packageRoot, AMBIENT_SKILL_RELATIVE_PATH), "utf8");
    expect(committed).toEqual(renderAmbientSkill(RSP_WRAPPER_CAPABILITIES));
  });
});
