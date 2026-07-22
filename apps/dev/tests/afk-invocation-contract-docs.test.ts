import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKILLS = join(ROOT, "plugins", "dev", "skills", "engineering");

async function readSkill(relativePath: string): Promise<string> {
  return readFile(join(SKILLS, relativePath), "utf8");
}

describe("AFK invocation contract docs (#1946)", () => {
  it("AFK documents runtime resolution, npm direct-run fallback, and valid subcommands", async () => {
    const skill = await readSkill("afk/SKILL.md");

    expect(skill).toContain("canonical\nform is the ADR 0091 npm direct-run");
    expect(skill).toContain("npx -y -p @reddb-io/red-skills@<version> red-skills-dev");
    expect(skill).toContain("The AFK queue-drain subcommand is `run`");
    expect(skill).toContain("There is no\n`red-skills-dev afk` subcommand");
  });

  it("shared report-runtime wrapper owns the binary precedence and missing-shim action", async () => {
    const wrapper = await readSkill("_report-runtime/WRAPPER.md");

    expect(wrapper).toContain("The npm direct-run form is the canonical invocation");
    expect(wrapper).toContain("warm-cache\noptimization");
    expect(wrapper).toContain("npx -y -p @reddb-io/red-skills@<version> red-skills-dev <subcommand> [args]");
    expect(wrapper).toContain("fall through to the npx form silently");
    expect(wrapper).toContain("There is no `red-skills-dev afk` subcommand");
  });

  it("sibling skills route through the same shared runtime contract", async () => {
    const go = await readSkill("go/SKILL.md");
    const retake = await readSkill("retake/SKILL.md");
    const dailyReview = await readSkill("daily-review/SKILL.md");
    const dashboard = await readSkill("dashboard/SKILL.md");

    for (const text of [go, retake, dailyReview, dashboard]) {
      expect(text).toContain("_report-runtime/WRAPPER.md");
    }
    expect(go).toContain("npx -y -p @reddb-io/red-skills@<version> red-skills-dev go");
    expect(retake).toContain("npx -y -p @reddb-io/red-skills@<version> red-skills-dev retake");
  });

  it("installed shim failure message names the npm fallback", async () => {
    const script = await readSkill("red-setup/scripts/install-runtime-shim.sh");

    expect(script).toContain("Fallback:");
    expect(script).toContain("npx -y -p @reddb-io/red-skills@<version> red-skills-dev");
    expect(script).toContain("npm direct-run fallback");
  });
});
