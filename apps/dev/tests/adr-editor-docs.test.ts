import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readAdrEditorSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/adr-editor/SKILL.md"), "utf8");
}

async function readSkill(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("adr-editor docs contract", () => {
  it("declares the totipotent charter with the maintainer as the decider", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("name: adr-editor");
    expect(skill).toContain("The maintainer decides; the editor executes");
    expect(skill).toContain("there is no read-only default");
    expect(skill).toContain(".red/adr/archive/");
  });

  it("enables all eleven operations in-session", async () => {
    const skill = await readAdrEditorSkill();

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
      expect(skill, `adr-editor should enable ${operation}`).toContain(operation);
    }
    expect(skill).toContain("eleven operations");
    expect(skill).toContain("applied here, not");
  });

  it("opens with a subject interview built from the collection's real groups", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("Ask first, sweep second");
    expect(skill).toContain("Phase 0 — Interview for the subject");
    expect(skill).toContain("offer them as numbered choices with their record counts");
    expect(skill).toContain("Which subject should I work on?");
    expect(skill).toContain("one question per turn, each narrowing the last");
    expect(skill).toContain("Skip the question when the invocation already names the subject");

    // The whole-collection sweep that pushed the maintainer out of the loop is gone.
    expect(skill).not.toContain("all ADRs by default");
  });

  it("reports the chosen subject only, with everything as an explicit choice", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("Phase 1 — Answer about the chosen subject");
    expect(skill).toContain("never a silent default");
    expect(skill).toContain("nothing outside it");
  });

  it("keeps exactly one gate — the destructive-or-wide batch confirmation", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("Confirm once before a destructive or wide batch mutation");
    expect(skill).toContain("Apply these N operations now?");
    expect(skill).toContain("needs no gate at all");

    // The retired read-only / Spec-routing framing must not come back.
    expect(skill).not.toContain("Read-only is the default");
    expect(skill).not.toContain("never applied in-session");
    expect(skill).not.toContain("Merge and split remain judgment operations");
    expect(skill).not.toContain("Spec work item");
  });

  it("offers /to-spec as an escape hatch instead of a routing gate", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("Escape hatch");
    expect(skill).toContain("`/to-spec` is never a gate and");
    expect(skill).toContain("The maintainer chooses.");
  });

  it("backs grouping and inconsistency detection with the shipped classifier", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("apps/dev/src/core/adr-triage.ts");
    for (const entryPoint of ["triageAdrs", "groupAdrs", "detectAdrInconsistencies"]) {
      expect(skill).toContain(`\`${entryPoint}\``);
    }
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
    for (const kind of [
      "numbering-collision",
      "dangling-supersede",
      "supersession-cycle",
      "index-drift",
      "stale-path",
      "subject-overlap",
    ]) {
      expect(skill).toContain(`\`${kind}\``);
    }
  });

  it("routes every mutation through a shipped planner and apply helper", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("apps/dev/src/core/adr-operations.ts");
    for (const helper of [
      "planArchiveMove",
      "applyArchiveMove",
      "planStatusAndSuccessor",
      "applyStatusAndSuccessor",
      "planIndexArchive",
      "applyIndexArchive",
      "planStalePathFix",
      "applyStalePathFix",
      "planRenumber",
      "applyRenumber",
      "planIndexEntry",
      "planSplit",
      "planMerge",
      "applyComposite",
    ]) {
      expect(skill).toContain(`\`${helper}\``);
    }
  });

  it("keeps the INDEX, ADR format, and git-flow safeties", async () => {
    const skill = await readAdrEditorSkill();

    expect(skill).toContain("`.red/adr/INDEX.md` coherent after every mutation");
    expect(skill).toContain("Set(active ∪ archived numbers) === Set(INDEX numbers)");
    expect(skill).toContain("start/ADR-FORMAT.md");
    expect(skill).toContain("Branch, worktree, commit, PR");
  });

  it("points doc-writing skills at the shared doc-landing finalizer", async () => {
    const start = await readSkill("plugins/dev/skills/engineering/start/SKILL.md");
    const adrEditor = await readSkill("plugins/dev/skills/engineering/adr-editor/SKILL.md");
    const context = await readSkill("plugins/dev/skills/engineering/context/SKILL.md");
    const reflect = await readSkill("plugins/dev/skills/productivity/reflect/SKILL.md");

    for (const skill of [start, adrEditor, context, reflect]) {
      expect(skill).toContain("shared end-of-session doc-landing finalizer");
      expect(skill).toContain("DOC-LANDING-FINALIZER.md");
    }
  });
});
