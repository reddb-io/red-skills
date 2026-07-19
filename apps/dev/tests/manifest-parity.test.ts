import { readdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(input: string): unknown };

async function readCodexManifest(): Promise<{ skills: string[] }> {
  const raw = await readFile(join(ROOT, "plugins/dev/.codex-plugin/plugin.json"), "utf8");
  return JSON.parse(raw) as { skills: string[] };
}

async function readPiManifest(): Promise<{ name: string; pi: { skills: string[] } }> {
  const raw = await readFile(join(ROOT, "plugins/dev/package.json"), "utf8");
  return JSON.parse(raw);
}

async function listSkillFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return listSkillFiles(path);
      return entry.isFile() && entry.name === "SKILL.md" ? [path] : [];
    }),
  );
  return files.flat().sort();
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

  it("published SKILL.md frontmatter parses as YAML", async () => {
    const manifest = await readCodexManifest();
    const skillRoots = manifest.skills.map((path) =>
      join(ROOT, "plugins/dev", path.replace(/^\.\//, "")),
    );
    const skillFiles = (await Promise.all(skillRoots.map(listSkillFiles))).flat();

    expect(skillFiles.length).toBeGreaterThan(0);

    for (const path of skillFiles) {
      const skill = await readFile(path, "utf8");
      const frontmatter = skill.match(/^---\n([\s\S]*?)\n---/);
      expect(frontmatter, `${path} must open with a YAML frontmatter block`).not.toBeNull();
      expect(() => yaml.load(frontmatter![1]), `${path} frontmatter must parse`).not.toThrow();
    }
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

  it("Pi dev package mirrors the Codex dev manifest bucket list", async () => {
    const codex = await readCodexManifest();
    const pi = await readPiManifest();

    // Same published buckets, with the leading `./skills/` prefix the Pi
    // package manifest requires because it lives at plugins/dev/package.json.
    expect(pi.name).toBe("@reddb-io/red-skills-dev");
    const codexBuckets = codex.skills
      .map((s) => s.replace(/^\.\/skills\//, "").replace(/\/$/, ""))
      .sort();
    const piBuckets = pi.pi.skills
      .map((s) => s.replace(/^\.\/skills\//, "").replace(/\/$/, ""))
      .sort();
    expect(piBuckets).toEqual(codexBuckets);
    expect(piBuckets).not.toContain("in-progress");
  });
});
