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

  it("routes corpus knowledge-graph requests to Memory surfaces", async () => {
    const askRedSkill = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRedSkill).toContain("corpus-to-knowledge-graph");
    expect(askRedSkill).toContain("/memory:ingest");
    expect(askRedSkill).toContain("/memory:view");
    expect(askRedSkill).toContain("/memory:export");
    expect(askRedSkill).toContain("memory communities");
    expect(askRedSkill).toContain("memory docs reference-graph");
    expect(askRedSkill).toContain("memory capabilities");
  });

  it("routes host toolchain drift through red-doctor", async () => {
    const askRedSkill = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRedSkill).toContain("host toolchain");
    expect(askRedSkill).toContain("gh >= 2.47.0");
    expect(askRedSkill).toContain("pinned `tq`");
    expect(askRedSkill).toContain("/red-doctor --fix");
  });

  it("routes executable ticket readiness through triage and the read-only doctor check", async () => {
    const askRedSkill = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRedSkill).toContain("executable ticket readiness");
    expect(askRedSkill).toContain("acceptance-criteria lint");
    expect(askRedSkill).toContain("/triage");
    expect(askRedSkill).toContain("/red-doctor");
  });

  it("routes standing drain policy to the AFK config and MCP contracts", async () => {
    const [askRed, config, mcp, template] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/docs/CONFIG.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/MCP.md"),
      readRepoFile("plugins/dev/skills/engineering/red-setup/config-template.yaml"),
    ]);

    for (const document of [askRed, config, mcp, template]) {
      expect(document).toContain("standing");
      expect(document).toContain("runner");
      expect(document).toContain("target");
    }
    expect(askRed).toContain("afk/docs/CONFIG.md");
    expect(askRed).toContain("afk/MCP.md");
  });

  it("routes ADR curation through the proposal-driven reverse grill", async () => {
    const askRedSkill = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRedSkill).toContain("proposal-driven reverse grill");
    expect(askRedSkill).toContain("ranks active ADR clusters");
    expect(askRedSkill).toContain("one cluster per PR");
    expect(askRedSkill).toContain("P01");
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
