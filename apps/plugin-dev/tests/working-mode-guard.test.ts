import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";
import {
  auditSkillWorkingModes,
  declaredWorkingModes,
  describeWorkingModeFindings,
  inspectSkillWorkingMode,
  sweptSkillFiles,
  WORKING_MODES,
} from "../src/core/working-mode-guard.js";

const ROOT = join(import.meta.dirname, "..", "..", "..");

/** A SKILL.md body with the frontmatter lines the caller asks for. */
function skill(...frontmatter: string[]): string {
  return ["---", "name: fixture", ...frontmatter, "description: A fixture skill.", "---", "", "# Fixture", ""].join(
    "\n",
  );
}

/** Writes one skill into a throwaway plugin tree and returns its root. */
async function fixtureTree(body: string, path = "plugins/example/skills/core/fixture"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "red-skills-working-mode-"));
  await mkdir(join(root, path), { recursive: true });
  await writeFile(join(root, path, "SKILL.md"), body);
  return root;
}

describe("Working mode declaration guard (ADR 0150 §2, #4012)", () => {
  it("names exactly the four modes ADR 0150 declares", () => {
    expect([...WORKING_MODES]).toEqual(["interactive", "spec-driven", "ad-hoc", "ADR-editing"]);
  });

  it.each(WORKING_MODES)("accepts a skill declaring %s", (mode) => {
    expect(inspectSkillWorkingMode("fixture/SKILL.md", skill(`working-mode: ${mode}`))).toBeNull();
  });

  it("reads the declaration out of the frontmatter only", () => {
    const body = [skill("working-mode: interactive"), "working-mode: ad-hoc", ""].join("\n");

    expect(declaredWorkingModes(body)).toEqual(["interactive"]);
  });

  it("tolerates a quoted declaration", () => {
    expect(declaredWorkingModes(skill('working-mode: "spec-driven"'))).toEqual(["spec-driven"]);
  });

  it("flags a skill that declares no mode", () => {
    const finding = inspectSkillWorkingMode("fixture/SKILL.md", skill());

    expect(finding).toMatchObject({ file: "fixture/SKILL.md", defect: "missing", declared: [] });
    expect(finding?.reason).toContain("interactive");
  });

  it("flags a skill that declares an unknown mode", () => {
    const finding = inspectSkillWorkingMode("fixture/SKILL.md", skill("working-mode: manual"));

    expect(finding).toMatchObject({ defect: "unknown", declared: ["manual"] });
    expect(finding?.reason).toContain("manual");
  });

  it("flags a skill that declares two modes", () => {
    const finding = inspectSkillWorkingMode(
      "fixture/SKILL.md",
      skill("working-mode: interactive", "working-mode: ad-hoc"),
    );

    expect(finding).toMatchObject({ defect: "repeated", declared: ["interactive", "ad-hoc"] });
  });

  it("flags a SKILL.md with no frontmatter at all", () => {
    expect(inspectSkillWorkingMode("fixture/SKILL.md", "# Fixture\n")).toMatchObject({
      defect: "no-frontmatter",
    });
  });

  it("fails on a fixture skill with no mode, naming its repo-relative path", async () => {
    const root = await fixtureTree(skill());

    const findings = auditSkillWorkingModes(root);

    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe("plugins/example/skills/core/fixture/SKILL.md");
    expect(describeWorkingModeFindings(findings)).toContain("plugins/example/skills/core/fixture/SKILL.md");
  });

  it("passes on the same fixture skill once it declares a mode", async () => {
    const root = await fixtureTree(skill("working-mode: interactive"));

    expect(auditSkillWorkingModes(root)).toEqual([]);
  });

  it("yields no findings for a tree with no plugins at all", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-working-mode-empty-"));

    expect(sweptSkillFiles(root)).toEqual([]);
    expect(auditSkillWorkingModes(root)).toEqual([]);
  });

  it("holds every shipped SKILL.md to exactly one of the four modes", () => {
    const files = sweptSkillFiles(ROOT);
    expect(files.length).toBeGreaterThan(0);

    const findings = auditSkillWorkingModes(ROOT);

    expect(findings, describeWorkingModeFindings(findings)).toEqual([]);
  });

  it("runs in every cone-scoped gate run", () => {
    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain("invariants:working-mode");
  });
});
