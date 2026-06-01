import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const obsoleteHitl = `slice:${"hitl"}`;
const obsoleteAfk = `slice:${"afk"}`;
const obsoleteGlob = `slice:${"*"}`;
const manualImplRequires = `requires human ${"implementation"}`;
const manualImplNeeds = `needs human ${"implementation"}`;

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("label vocabulary docs", () => {
  it("does not teach obsolete slice-routing labels", async () => {
    const docs = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md"),
      readRepoFile("plugins/dev/skills/engineering/hitl/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/to-issues/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/triage/SKILL.md"),
      readRepoFile(".red/agents/triage-labels.md"),
      readRepoFile("README.md"),
    ]);

    for (const doc of docs) {
      expect(doc).not.toContain(obsoleteHitl);
      expect(doc).not.toContain(obsoleteAfk);
      expect(doc).not.toContain(obsoleteGlob);
    }
  });

  it("defines ready-for-human as human decision or resolution", async () => {
    const canonical = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md");

    expect(canonical).toContain(
      "The issue requires human decision or resolution before it can proceed or be delegated.",
    );
    expect(canonical).not.toContain(manualImplRequires);
    expect(canonical).not.toContain(manualImplNeeds);
  });
});
