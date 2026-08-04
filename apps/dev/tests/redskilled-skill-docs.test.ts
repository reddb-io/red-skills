import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKILL_PATH = "plugins/dev/skills/engineering/redskilled/SKILL.md";
const CANONICAL = "npx -y -p @reddb-io/red-skills@<version> red-skills-redskilled";

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("redskilled operator skill (#3249)", () => {
  it("registers the per-machine skill in every source inventory", async () => {
    const [manifestText, rootReadme, bucketReadme, askRed] = await Promise.all([
      readRepoFile("plugins/dev/.claude-plugin/plugin.json"),
      readRepoFile("README.md"),
      readRepoFile("plugins/dev/skills/engineering/README.md"),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
    ]);
    const manifest = JSON.parse(manifestText) as { skills: string[] };

    expect(manifest.skills).toContain("./skills/engineering/redskilled");
    expect(rootReadme).toContain("[`redskilled`](./plugins/dev/skills/engineering/redskilled/SKILL.md)");
    expect(bucketReadme).toContain("**[redskilled](./redskilled/SKILL.md)**");
    expect(askRed).toContain("/redskilled");
  });

  it("covers status, provisioning, home policy, restart, and origin confirmation", async () => {
    const skill = await readRepoFile(SKILL_PATH);

    expect(skill).toContain("disable-model-invocation: true");
    expect(skill).toContain("<what-to-do>");
    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain(`${CANONICAL} provision --check`);
    expect(skill).toContain(`${CANONICAL} host-state`);
    expect(skill).toContain(`${CANONICAL} provision --workspace host`);
    expect(skill).toContain(`${CANONICAL} stop\n`);
    expect(skill).toContain("plugins.dev.redskilled");
    expect(skill).toContain("worker_ceiling");
    expect(skill).toContain("memory_ceiling");
    expect(skill).toContain("validation_ceiling");
    expect(skill).toContain("idle_ms");
    expect(skill).toContain("serve flag > environment > home config > derived default");
    expect(skill).toContain("home-config");
    expect(skill).toContain("restart, never an evacuation");
    expect(skill).toContain("/red-setup");
  });
});
