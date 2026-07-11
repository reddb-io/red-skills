import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

function readRepoFile(path: string) {
  return readFile(join(ROOT, path), "utf8");
}

describe("skill progressive-disclosure docs", () => {
  it("keeps red-statusline routing hot while preserving host recipes in HOST-NOTES", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/red-statusline/SKILL.md");
    const hostNotes = await readRepoFile("plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md");

    expect(skill).toContain("<what-to-do>");
    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[HOST-NOTES.md](HOST-NOTES.md)");
    expect(skill).not.toContain("Claude Code's `statusLine` renders multiple rows");
    expect(skill).not.toContain("red-skills-dev codex-statusline --fix");

    expect(hostNotes).toContain("Claude Code's `statusLine` renders multiple rows");
    expect(hostNotes).toContain("red-skills-dev codex-statusline --fix");
    expect(hostNotes).toContain("Every `k=v` key on this line is **exactly 3 letters**");
    expect(hostNotes).toContain("OpenCode is an AFK API-auth runner lane");
  });

  it("keeps wiki-init init loop hot while moving the bundled template inventory behind a link", async () => {
    const skill = await readRepoFile("plugins/memory/skills/core/wiki-init/SKILL.md");
    const templates = await readRepoFile("plugins/memory/skills/core/wiki-init/TEMPLATE-REFERENCE.md");

    expect(skill).toContain("<what-to-do>");
    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[TEMPLATE-REFERENCE.md](./TEMPLATE-REFERENCE.md)");
    expect(skill).toContain("[LLM Wiki](../wiki/REFERENCES.md)");
    expect(skill).not.toContain("## Bundled templates");

    for (const template of [
      "schema-template.md",
      "index-template.md",
      "page-template-entity.md",
      "page-template-concept.md",
      "page-template-source.md",
      "page-template-synthesis.md",
      "examples/research.md",
      "examples/book-reading.md",
    ]) {
      expect(templates).toContain(template);
    }
    expect(templates).toContain("[REFERENCES.md](../wiki/REFERENCES.md)");
  });
});
