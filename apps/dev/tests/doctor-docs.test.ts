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

  it("reports the primary-branch guard + config namespacing without mutating config", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Config namespacing + primary-branch guard");
    expect(skill).toContain("read `.red/config.yaml`");
    expect(skill).toContain("canonical key is the namespaced `plugins.dev.lock.primary-branch`");
    expect(skill).toContain("any value other than `true` as \"unset\"");
    expect(skill).toContain("recommend `→ /setup-red-skills`");
    expect(skill).toContain("never write `.red/config.yaml`");
  });

  it("flags legacy top-level dev-plugin config as a namespacing migration", async () => {
    const skill = await readDoctorSkill();

    expect(skill).toContain("Namespacing conformance");
    expect(skill).toContain("dev-plugin settings belong under `plugins.dev.*`");
    expect(skill).toContain("hygiene, not breakage");
    // The `--fix` Apply table has the migration row.
    expect(skill).toContain("Legacy/top-level dev-plugin config");
  });
});
