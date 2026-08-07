/**
 * Tests for `skills-to-opencode.ts` — the pure planner for the SKILL.md
 * → opencode skill directory mapping (ADR 0076).
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listSkillFiles,
  parseFrontmatter,
  planPluginSkills,
  planSkill,
  skillRelativeParts,
} from "../src/skills-to-opencode.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "oc-host-skills-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeSkill(name: string, body: string, bucket = "engineering"): void {
  const dir = join(root, "dev", "skills", bucket, name);
  require("node:fs").mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body, "utf8");
}

describe("parseFrontmatter", () => {
  it("returns the name and description from a valid frontmatter", () => {
    const text = `---
name: foo
description: A foo skill
---
# body`;
    expect(parseFrontmatter(text)).toEqual({ name: "foo", description: "A foo skill" });
  });
  it("returns empty when there is no frontmatter", () => {
    expect(parseFrontmatter("# body")).toEqual({});
  });
  it("strips surrounding quotes from values", () => {
    const text = `---
name: "foo-bar"
description: 'A quoted description'
---
`;
    expect(parseFrontmatter(text)).toEqual({ name: "foo-bar", description: "A quoted description" });
  });
  it("ignores unknown frontmatter fields", () => {
    const text = `---
name: foo
description: d
argument-hint: --flag
license: MIT
---
`;
    expect(parseFrontmatter(text)).toEqual({ name: "foo", description: "d" });
  });
});

describe("listSkillFiles", () => {
  it("returns every SKILL.md under skills/, recursively, skipping in-progress", () => {
    writeSkill("afk", "---\nname: afk\ndescription: AFK skill\n---\n");
    writeSkill("ship", "---\nname: ship\ndescription: Ship skill\n---\n");
    writeSkill("wiki", "---\nname: wiki\ndescription: Wiki skill\n---\n", "knowledge");
    writeSkill("draft", "---\nname: draft\ndescription: Draft skill\n---\n", "in-progress");
    const files = listSkillFiles(root, "dev");
    const names = files.map((f) => f.split("/").slice(-2)[0]).sort();
    expect(names).toEqual(["afk", "ship", "wiki"]);
  });
  it("returns [] when the skills/ dir is absent", () => {
    expect(listSkillFiles(root, "dev")).toEqual([]);
  });
});

describe("planSkill (ADR 0076 §1 name validation)", () => {
  it("accepts the path separators emitted by both POSIX and Windows", () => {
    expect(skillRelativeParts("engineering/afk/SKILL.md")).toEqual([
      "engineering",
      "afk",
      "SKILL.md",
    ]);
    expect(skillRelativeParts("engineering\\afk\\SKILL.md")).toEqual([
      "engineering",
      "afk",
      "SKILL.md",
    ]);
  });

  it("accepts a valid lowercase-hyphenated name", () => {
    writeSkill("afk", "---\nname: afk\ndescription: x\n---\n");
    const files = listSkillFiles(root, "dev");
    const { plan, errors } = planSkill(files[0]!, root, "dev");
    expect(errors).toEqual([]);
    expect(plan).toBeDefined();
    expect(plan!.target).toBe("skills/afk/SKILL.md");
    expect(plan!.bucket).toBe("engineering");
  });
  it("rejects a name with an underscore", () => {
    writeSkill("My_Skill", "---\nname: My_Skill\ndescription: x\n---\n");
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("name-not-valid");
  });
  it("rejects a name with consecutive hyphens", () => {
    writeSkill("foo--bar", "---\nname: foo--bar\ndescription: x\n---\n");
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("name-not-valid");
  });
  it("rejects a name that exceeds 64 chars", () => {
    const long = "a".repeat(65);
    writeSkill(long, `---\nname: ${long}\ndescription: x\n---\n`);
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("name-not-valid");
  });
  it("rejects a name where the frontmatter name does not match the directory", () => {
    writeSkill("afk", "---\nname: ship\ndescription: x\n---\n");
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("name-not-equal-to-dir");
  });
  it("rejects a missing frontmatter name", () => {
    writeSkill("afk", "---\ndescription: x\n---\n");
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("name-missing");
  });
  it("rejects a description that exceeds the 1024-char budget", () => {
    const long = "x".repeat(1025);
    writeSkill("afk", `---\nname: afk\ndescription: ${long}\n---\n`);
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors[0]!.code).toBe("description-missing-or-too-long");
  });
  it("accepts a description at exactly the 1024-char budget", () => {
    const exact = "x".repeat(1024);
    writeSkill("afk", `---\nname: afk\ndescription: ${exact}\n---\n`);
    const files = listSkillFiles(root, "dev");
    const { errors } = planSkill(files[0]!, root, "dev");
    expect(errors).toEqual([]);
  });
});

describe("planPluginSkills", () => {
  it("plans every valid skill and returns errors for invalid ones", () => {
    writeSkill("afk", "---\nname: afk\ndescription: x\n---\n");
    writeSkill("Bad_Name", "---\nname: Bad_Name\ndescription: x\n---\n");
    writeSkill("ship", "---\nname: ship\ndescription: x\n---\n");
    const result = planPluginSkills(root, "dev");
    expect(result.plans.map((p) => p.name).sort()).toEqual(["afk", "ship"]);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]!.code).toBe("name-not-valid");
  });
});
