import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readReviewAdrsSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/review-adrs/SKILL.md"), "utf8");
}

async function readSkill(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
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

  it("triages a subject-scoped run and gates every mechanical apply", async () => {
    const skill = await readReviewAdrsSkill();

    expect(skill).toContain("triageAdrs");
    expect(skill).toContain("optional subject filter");
    for (const bucket of [
      "keep",
      "stale-reference",
      "missing-supersession",
      "merge-candidate",
      "split-candidate",
      "archive-candidate",
    ]) {
      expect(skill).toContain(`\`${bucket}\``);
    }

    for (const helper of [
      "planArchiveMove",
      "applyArchiveMove",
      "planStatusAndSuccessor",
      "applyStatusAndSuccessor",
      "planIndexArchive",
      "applyIndexArchive",
      "planStalePathFix",
      "applyStalePathFix",
    ]) {
      expect(skill).toContain(`\`${helper}\``);
    }

    expect(skill).toContain("Explicit confirmation gate");
    expect(skill).toContain("No confirmation means no writes");
    expect(skill).toContain("Merge and split remain judgment operations");
  });

  it("points doc-writing skills at the shared doc-landing finalizer", async () => {
    const start = await readSkill("plugins/dev/skills/engineering/start/SKILL.md");
    const reviewAdrs = await readSkill("plugins/dev/skills/engineering/review-adrs/SKILL.md");
    const context = await readSkill("plugins/dev/skills/engineering/context/SKILL.md");
    const reflect = await readSkill("plugins/dev/skills/productivity/reflect/SKILL.md");

    for (const skill of [start, reviewAdrs, context, reflect]) {
      expect(skill).toContain("shared end-of-session doc-landing finalizer");
      expect(skill).toContain("DOC-LANDING-FINALIZER.md");
    }
  });
});
