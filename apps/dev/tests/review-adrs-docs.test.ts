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

  it("runs ADR triage and scopes only the presented buckets with the optional subject filter", async () => {
    const skill = await readReviewAdrsSkill();

    expect(skill).toContain("apps/dev/src/core/adr-triage.ts");
    expect(skill).toContain("`triageAdrs`");
    expect(skill).toContain('`numbers`');
    expect(skill).toContain('`text`');
    expect(skill).toContain('`index-section`');
    expect(skill).toContain("Classification still uses the whole ADR tree");
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
  });

  it("gates every mechanical apply helper behind an explicit in-session confirmation", async () => {
    const skill = await readReviewAdrsSkill();
    const gate = skill.indexOf("Explicit confirmation gate");

    expect(gate).toBeGreaterThan(-1);
    for (const helper of [
      "applyArchiveMove",
      "applyStatusAndSuccessor",
      "applyIndexArchive",
      "applyStalePathFix",
    ]) {
      expect(skill.indexOf(`\`${helper}\``)).toBeGreaterThan(gate);
    }
    expect(skill).toContain("Anything except an explicit confirmation keeps the run read-only");
    expect(skill).toContain("apply the confirmed mechanical operations in-session");
  });

  it("keeps detection read-only by default and routes judgment operations to a Spec", async () => {
    const skill = await readReviewAdrsSkill();

    expect(skill).toContain("Read-only is the default");
    expect(skill).toContain("No confirmation means no write");
    expect(skill).toContain("Judgment route: interview → Spec → `/afk`");
  });

  it("keeps the router and engineering index aligned with gated mechanical apply", async () => {
    const askRed = await readSkill("plugins/dev/skills/engineering/ask-red/SKILL.md");
    const engineering = await readSkill("plugins/dev/skills/engineering/README.md");

    for (const summary of [askRed, engineering]) {
      expect(summary).toContain("read-only triage");
      expect(summary).toContain("confirmed mechanical cleanup");
      expect(summary).toContain("judgment findings");
      expect(summary).toContain("`/to-spec`");
    }
  });
});
