import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readReviewAdrsSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/review-adrs/SKILL.md"), "utf8");
}

describe("review-adrs docs contract", () => {
  it("requires linting fetched origin default branch instead of the working tree", async () => {
    const skill = await readReviewAdrsSkill();

    expect(skill).toContain("git fetch origin");
    expect(skill).toContain("origin/<default-branch>");
    expect(skill).toContain("git ls-tree");
    expect(skill).toContain("git show");
    expect(skill).toContain("do **not** inspect `.red/adr/` from the working tree");
    expect(skill).toContain("Use local `HEAD` only when no `origin` remote/ref exists");
  });
});
