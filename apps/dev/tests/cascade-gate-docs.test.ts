import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readSkill(relPath: string): Promise<string> {
  return readFile(join(ROOT, relPath), "utf8");
}

describe("cascade gate docs contract — /to-spec", () => {
  it("contains the cascade-gate directive with origin-first comparison", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-spec/SKILL.md"
    );

    expect(skill).toContain("Cascade gate");
    expect(skill).toContain("git fetch origin");
    expect(skill).toContain("origin/{base}");
    expect(skill).toContain("origin-first comparison");
    expect(skill).toContain("AFK workers");
  });

  it("references the doc-landing procedure and ADR 0092 instead of restating the git sequence", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-spec/SKILL.md"
    );

    expect(skill).toContain("doc-landing procedure");
    expect(skill).toContain("ADR 0092");
    expect(skill).toContain("/start");
  });

  it("aborts loudly when landing is impossible and never publishes while docs are unlanded", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-spec/SKILL.md"
    );

    expect(skill).toContain("abort");
    expect(skill).toContain("never publish while docs are unlanded");
  });

  it("places the cascade gate before the publish step", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-spec/SKILL.md"
    );

    const gateIndex = skill.indexOf("Cascade gate");
    // "Labels on publish:" is a phrase unique to the publish-step body
    const publishIndex = skill.indexOf("Labels on publish:");
    expect(gateIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(gateIndex);
  });

  it("emits machine-checkable acceptance criteria for downstream tickets", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-spec/SKILL.md"
    );

    expect(skill).toContain("## Acceptance Criteria");
    expect(skill).toContain("machine-checkable");
    expect(skill).toContain("test, command, fixture, or pinned observable behavior");
  });
});

describe("cascade gate docs contract — /to-tickets", () => {
  it("contains the cascade-gate directive with origin-first comparison", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-tickets/SKILL.md"
    );

    expect(skill).toContain("Cascade gate");
    expect(skill).toContain("git fetch origin");
    expect(skill).toContain("origin/{base}");
    expect(skill).toContain("origin-first comparison");
    expect(skill).toContain("AFK workers");
  });

  it("references the doc-landing procedure and ADR 0092 instead of restating the git sequence", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-tickets/SKILL.md"
    );

    expect(skill).toContain("doc-landing procedure");
    expect(skill).toContain("ADR 0092");
    expect(skill).toContain("/start");
  });

  it("aborts loudly when landing is impossible and never publishes while docs are unlanded", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-tickets/SKILL.md"
    );

    expect(skill).toContain("abort");
    expect(skill).toContain("never publish while docs are unlanded");
  });

  it("places the cascade gate before the publish step", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-tickets/SKILL.md"
    );

    const gateIndex = skill.indexOf("Cascade gate");
    const publishIndex = skill.indexOf("Publish in dependency order");
    expect(gateIndex).toBeGreaterThan(0);
    expect(publishIndex).toBeGreaterThan(gateIndex);
  });

  it("uses issue-template acceptance criteria that pass executable lint", async () => {
    const skill = await readSkill(
      "plugins/dev/skills/engineering/to-tickets/SKILL.md"
    );

    expect(skill).toContain("Running `<focused command>` passes");
    expect(skill).toContain("The failing fixture or reproduction demonstrates");
    expect(skill).toContain("The pinned observable behavior");
    expect(skill).not.toContain("- [ ] Criterion 1");
  });
});
