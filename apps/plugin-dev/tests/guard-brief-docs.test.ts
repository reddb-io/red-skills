import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("repo invariant guard briefs", () => {
  it.each([
    {
      name: "guard-process-birth",
      path: "apps/plugin-dev/src/**/*.ts",
    },
    {
      name: "guard-serialization",
      path: "{apps,packages}/**/*.{js,cjs,mjs,ts,cts,mts,tsx}",
    },
  ])("ships $name with its governed path declaration", async ({ name, path }) => {
    const skill = await readRepoFile(`plugins/dev/skills/engineering/${name}/SKILL.md`);

    expect(skill).toContain(`name: ${name}`);
    expect(skill).toContain("paths:");
    expect(skill).toContain(`  - "${path}"`);
  });

  it("replaces root restatements with concise guard-brief pointers", async () => {
    const [agents, claude] = await Promise.all([
      readRepoFile("AGENTS.md"),
      readRepoFile("CLAUDE.md"),
    ]);

    for (const instructions of [agents, claude]) {
      expect(instructions).toContain("guard-process-birth/SKILL.md");
      expect(instructions).toContain("guard-serialization/SKILL.md");
    }
    expect(claude).not.toContain("A per-project module that can create a process fails");
    expect(claude).not.toContain("The decoder sniffs JSON-or-TOON and accepts both");
  });

  it("publishes both briefs through the manifest and skill indexes", async () => {
    const [manifestSource, rootReadme, bucketReadme, router] = await Promise.all([
      readRepoFile("plugins/dev/.claude-plugin/plugin.json"),
      readRepoFile("README.md"),
      readRepoFile("plugins/dev/skills/engineering/README.md"),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
    ]);
    const manifest = JSON.parse(manifestSource) as { skills: string[] };

    for (const name of ["guard-process-birth", "guard-serialization"]) {
      expect(manifest.skills).toContain(`./skills/engineering/${name}`);
      expect(rootReadme).toContain(`(${`./plugins/dev/skills/engineering/${name}/SKILL.md`})`);
      expect(bucketReadme).toContain(`(${`./${name}/SKILL.md`})`);
      expect(router).toContain(`/${name}`);
    }
  });
});
