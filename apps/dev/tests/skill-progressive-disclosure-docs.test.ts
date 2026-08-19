import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");

function readRepoFile(path: string) {
  return readFile(join(ROOT, path), "utf8");
}

describe("skill progressive-disclosure docs", () => {
  it("keeps /afk troubleshooting discoverable and pins operational playbooks", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/afk/SKILL.md");
    const troubleshooting = await readRepoFile("plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md");

    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)");

    for (const heading of [
      "# /afk Troubleshooting",
      "## Gate census when ready-for-agent is empty",
      "## False main-red verification",
      "## Scout and worker salvage after crashed or no-sentinel runs",
      "## Park-resolution contract",
      "## Base-stale decision procedure",
      "## Requeue escalation map",
      "## Release-pipeline playbook",
      "### Symptom",
      "### Confirm",
      "### Recover",
      "### Root fix",
    ]) {
      expect(troubleshooting).toContain(heading);
    }

    for (const issue of ["#1739", "#1695", "#1863"]) {
      expect(troubleshooting).toContain(issue);
    }
  });

  it("keeps /go troubleshooting discoverable and pins the stopgap playbooks", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/go/SKILL.md");
    const troubleshooting = await readRepoFile("plugins/dev/skills/engineering/go/TROUBLESHOOTING.md");

    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)");

    for (const heading of [
      "# /go Troubleshooting",
      "## Crashed-scout salvage",
      "### Symptom",
      "### Confirm",
      "### Recover",
      "### Root fix",
      "## Engine-exit-0-but-parked reading",
    ]) {
      expect(troubleshooting).toContain(heading);
    }

    expect(troubleshooting).toContain("#1695");
    expect(troubleshooting).toContain("#1864");
  });

  it("keeps red-statusline routing hot while preserving host recipes in HOST-NOTES", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/red-statusline/SKILL.md");
    const hostNotes = await readRepoFile("plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md");

    expect(skill).toContain("<what-to-do>");
    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[HOST-NOTES.md](HOST-NOTES.md)");
    expect(skill).not.toContain("Claude Code's `statusLine` renders multiple rows");
    // ADR 0147 rule 1 made the Codex fixer a tool rather than a CLI flag (#4030);
    // the split this pins is still the point — the recipe lives in HOST-NOTES.
    expect(skill).not.toContain("an explicit inspector, the `codex_statusline` read tool");

    expect(hostNotes).toContain("Claude Code's `statusLine` renders multiple rows");
    expect(hostNotes).toContain("an explicit inspector, the `codex_statusline` read tool");
    expect(hostNotes).toContain("Every `k=v` key on this line is **exactly 3 letters**");
    expect(hostNotes).toContain('"refreshInterval": 60');
    expect(hostNotes).not.toContain('"refreshInterval": 5');
    expect(hostNotes).toContain("60s matches the real rate of change of fleet/PR state");
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
