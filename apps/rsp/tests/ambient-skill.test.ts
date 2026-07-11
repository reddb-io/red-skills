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

  it("committed artifact matches the generator output (drift check)", () => {
    const committed = readFileSync(join(packageRoot, AMBIENT_SKILL_RELATIVE_PATH), "utf8");
    expect(committed).toEqual(renderAmbientSkill(RSP_WRAPPER_CAPABILITIES));
  });
});
