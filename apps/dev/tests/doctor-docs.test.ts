import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readDoctorSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/doctor/SKILL.md"), "utf8");
}

describe("doctor docs contract", () => {
  it("checks Development-workflow adoption read-only with setup-red-skills as the fix-home", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("AGENTS ≡ CLAUDE Development-workflow parity");
    expect(skill).toContain("`## Development workflow` block");
    expect(skill).toContain("Report `C/A` for presence");
    expect(skill).toContain("out-of-parity block as a finding tagged `→ /setup-red-skills`");
    expect(skill).toContain("do not run `inject-development-workflow`");
    expect(skill).toContain("do not create files");
    expect(skill).toContain("do not edit either agent rules file");
  });

  it("reports dev.lock-primary-branch as set or unset without mutating config", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Primary-branch guard flag");
    expect(skill).toContain("read `.red/config.yaml`");
    expect(skill).toContain("report whether `dev.lock-primary-branch` is set");
    expect(skill).toContain("Treat an absent config file");
    expect(skill).toContain("anything other than `true` as \"unset\"");
    expect(skill).toContain("recommend enabling it via `→ /setup-red-skills`");
    expect(skill).toContain("never write `.red/config.yaml`");
  });
});
