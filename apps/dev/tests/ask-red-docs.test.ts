import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

async function readDevManifest(): Promise<{ skills: string[] }> {
  const raw = await readRepoFile("plugins/dev/.claude-plugin/plugin.json");
  return JSON.parse(raw) as { skills: string[] };
}

describe("ask-red router docs contract", () => {
  it("is registered in the dev plugin manifest and the public skill maps", async () => {
    const [manifest, rootReadme, bucketReadme] = await Promise.all([
      readDevManifest(),
      readRepoFile("README.md"),
      readRepoFile("plugins/dev/skills/engineering/README.md"),
    ]);

    expect(manifest.skills).toContain("./skills/engineering/ask-red");
    expect(rootReadme).toContain("[`ask-red`](./plugins/dev/skills/engineering/ask-red/SKILL.md)");
    expect(bucketReadme).toContain("**[ask-red](./ask-red/SKILL.md)**");
  });

  it("routes every registered dev skill by slash-command name", async () => {
    const [manifest, askRedSkill] = await Promise.all([
      readDevManifest(),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
    ]);
    const skillNames = manifest.skills.map((path) => basename(path));

    for (const skillName of skillNames) {
      expect(askRedSkill, `ask-red should mention /${skillName}`).toContain(`/${skillName}`);
    }
  });

  it("documents the maintenance rule in both repo agent instruction files", async () => {
    const [claude, agents] = await Promise.all([readRepoFile("CLAUDE.md"), readRepoFile("AGENTS.md")]);

    for (const content of [claude, agents]) {
      expect(content).toContain("ask-red maintenance rule");
      expect(content).toContain("any skill add, rename, removal, or flow change");
      expect(content).toContain("re-check `plugins/dev/skills/engineering/ask-red/SKILL.md`");
    }
  });
});
