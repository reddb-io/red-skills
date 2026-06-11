import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readCodexManifest(): Promise<{ skills: string[] }> {
  const raw = await readFile(join(ROOT, "plugins/dev/.codex-plugin/plugin.json"), "utf8");
  return JSON.parse(raw) as { skills: string[] };
}

describe("dev plugin manifest + frontmatter hygiene", () => {
  it("model-tier-policy SKILL.md carries a name: frontmatter field", async () => {
    const skill = await readFile(
      join(ROOT, "plugins/dev/skills/engineering/model-tier-policy/SKILL.md"),
      "utf8",
    );

    const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatter, "SKILL.md must open with a YAML frontmatter block").not.toBeNull();
    expect(frontmatter![1]).toMatch(/^name:\s*model-tier-policy\s*$/m);
  });

  it("Codex dev manifest enumerates only published buckets (no in-progress/)", async () => {
    const manifest = await readCodexManifest();

    // The skills field must enumerate buckets explicitly so drafts under
    // in-progress/ never ship — the whole-tree "./skills/" glob would expose them
    // and violate CLAUDE.md rule 1.
    expect(Array.isArray(manifest.skills)).toBe(true);
    expect(manifest.skills).not.toContain("./skills/");
    expect(manifest.skills.some((s) => /in-progress/.test(s))).toBe(false);

    // Every published bucket must be present; in-progress/ must be absent.
    const buckets = manifest.skills.map((s) => s.replace(/^\.\/skills\//, "").replace(/\/$/, ""));
    expect(buckets.sort()).toEqual(["engineering", "knowledge", "misc", "productivity"]);
  });
});
