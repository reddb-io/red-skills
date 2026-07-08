import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readTddSkill(): Promise<string> {
  return readFile(
    join(ROOT, "plugins/dev/skills/engineering/tdd/SKILL.md"),
    "utf8"
  );
}

async function readTddTests(): Promise<string> {
  return readFile(
    join(ROOT, "plugins/dev/skills/engineering/tdd/tests.md"),
    "utf8"
  );
}

describe("tdd docs contract — reference-only reshape", () => {
  it("carries the red-before-green rule and seams-pre-agreed constraint", async () => {
    const skill = await readTddSkill();

    expect(skill).toContain("red before green");
    expect(skill).toContain("pre-agreed seam");
  });

  it("does not contain prescriptive step headings", async () => {
    const skill = await readTddSkill();

    expect(skill).not.toContain("### Step 1");
    expect(skill).not.toContain("### Step 2");
    expect(skill).not.toContain("### Step 3");
  });
});

describe("tdd docs contract — tautological-test anti-pattern", () => {
  it("names the tautological-test anti-pattern in the hard rules", async () => {
    const skill = await readTddSkill();

    expect(skill).toContain("tautological");
    expect(skill).toContain("independent source of truth");
  });

  it("carries the tautological-test gate in the per-cycle checklist", async () => {
    const skill = await readTddSkill();

    // The checklist must include a gate for independent expected values
    expect(skill).toContain("Expected values");
    expect(skill).toContain("literal");
  });

  it("describes tautological tests in the philosophy section as a peer anti-pattern", async () => {
    const skill = await readTddSkill();

    expect(skill).toContain("passes by construction");
    expect(skill).toContain("Tautological tests");
  });

  it("provides a BAD/GOOD example pair for tautological tests in tests.md", async () => {
    const tests = await readTddTests();

    expect(tests).toContain("tautological");
    expect(tests).toContain("a + b");
  });
});
