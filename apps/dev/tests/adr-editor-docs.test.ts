import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readSkill(path = "plugins/dev/skills/engineering/adr-editor/SKILL.md"): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("adr-editor reverse-grill contract", () => {
  it("ranks active clusters, recommends where to start, and processes one cluster per PR", async () => {
    const skill = await readSkill();

    expect(skill).toContain("name: adr-editor");
    expect(skill).toContain("proposal-driven reverse grill");
    expect(skill).toContain("rankAdrClusters");
    expect(skill).toContain("recommend where to start");
    expect(skill).toContain("one cluster per PR");
    expect(skill).toContain("exclude `.red/adr/archive/` from future cluster analysis");
  });

  it("preserves all eleven operations with the maintainer as decider", async () => {
    const skill = await readSkill();

    expect(skill).toContain("The maintainer decides; the editor executes");
    for (const operation of [
      "list",
      "group",
      "surface inconsistencies",
      "add",
      "remove",
      "rewrite",
      "merge",
      "split",
      "archive",
      "renumber",
      "re-index",
    ]) {
      expect(skill, `adr-editor should retain ${operation}`).toContain(operation);
    }
    expect(skill).toContain("eleven operations");
  });

  it("presents one numbered proposal per turn with evidence and judgment left to the model", async () => {
    const skill = await readSkill();

    expect(skill).toContain("P01");
    expect(skill).toContain("one proposal per turn");
    for (const field of ["Evidence", "Exact operation", "Alternatives", "Recommendation"]) {
      expect(skill).toContain(field);
    }
    expect(skill).toContain("candidate evidence, not a disposition");
    expect(skill).toContain("explicit maintainer disposition");
    expect(skill).toContain("every active ADR in the cluster");
  });

  it("confronts active ADRs with current implementation evidence without changing product code", async () => {
    const skill = await readSkill();

    for (const evidence of ["current code", "tests", "documentation", "newer active ADRs"]) {
      expect(skill).toContain(evidence);
    }
    expect(skill).toContain("Do not change analyzed product code");
    expect(skill).toContain("Age or lack of links is never sufficient archival evidence");
  });

  it("distinguishes absorb from merge and routes absorb through the safe primitive", async () => {
    const skill = await readSkill();

    expect(skill).toContain("Absorb");
    expect(skill).toContain("rewrites one governing ADR");
    expect(skill).toContain("archives only the auxiliaries");
    expect(skill).toContain("Merge");
    expect(skill).toContain("mints a successor");
    expect(skill).toContain("archives all originals");
    expect(skill).toContain("planAbsorb");
    expect(skill).toContain("applyAbsorb");
  });

  it("annotates reviewed INDEX bullets and re-reviews only on new evidence", async () => {
    const skill = await readSkill();

    expect(skill).toContain("reviewed YYYY-MM-DD @ <short-base-sha>");
    expect(skill).toContain("visibly annotate every reviewed INDEX bullet");
    expect(skill).toContain("Prioritize re-review only when new evidence exists");
  });

  it("accumulates accepted proposals before one preview and destructive-batch confirmation", async () => {
    const skill = await readSkill();

    expect(skill).toContain("accumulate accepted proposals");
    expect(skill).toContain("show the complete resulting text and exact diff");
    expect(skill).toContain("Apply this destructive batch now?");
    expect(skill).toContain("one confirmation");
  });

  it("composes the deterministic helpers and preserves governance and landing safeguards", async () => {
    const skill = await readSkill();

    expect(skill).toContain("apps/dev/src/core/adr-triage.ts");
    for (const helper of [
      "triageAdrs",
      "groupAdrs",
      "detectAdrInconsistencies",
      "rankAdrClusters",
      "planArchiveMove",
      "applyArchiveMove",
      "planStatusAndSuccessor",
      "applyStatusAndSuccessor",
      "planIndexArchive",
      "applyIndexArchive",
      "planIndexReviewAnnotation",
      "planStalePathFix",
      "applyStalePathFix",
      "planRenumber",
      "applyRenumber",
      "planIndexEntry",
      "planSplit",
      "planMerge",
      "planAbsorb",
      "applyAbsorb",
      "applyComposite",
    ]) {
      expect(skill).toContain(`\`${helper}\``);
    }
    expect(skill).toContain("`.red/adr/INDEX.md` coherent after every mutation");
    expect(skill).toContain("Set(active ∪ archived numbers) === Set(INDEX numbers)");
    expect(skill).toContain("start/ADR-FORMAT.md");
    expect(skill).toContain("Branch, worktree, commit, PR");
    expect(skill).toContain("shared end-of-session doc-landing finalizer");
    expect(skill).toContain("DOC-LANDING-FINALIZER.md");
  });
});
