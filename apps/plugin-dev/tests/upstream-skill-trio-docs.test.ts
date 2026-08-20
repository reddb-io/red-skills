import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("upstream skill trio docs contract", () => {
  it("registers what, wizard, and to-questionnaire on every public surface", async () => {
    const [manifestRaw, rootReadme, engineeringReadme, productivityReadme, askRed] = await Promise.all([
      readRepoFile("plugins/dev/.claude-plugin/plugin.json"),
      readRepoFile("README.md"),
      readRepoFile("plugins/dev/skills/engineering/README.md"),
      readRepoFile("plugins/dev/skills/productivity/README.md"),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
    ]);
    const manifest = JSON.parse(manifestRaw) as { skills: string[] };

    for (const skillPath of [
      "./skills/productivity/what",
      "./skills/engineering/wizard",
      "./skills/productivity/to-questionnaire",
    ]) {
      const name = basename(skillPath);
      expect(manifest.skills).toContain(skillPath);
      expect(rootReadme).toContain(`[\`${name}\`](./plugins/dev/${skillPath.slice(2)}/SKILL.md)`);
      expect(askRed).toContain(`/${name}`);
    }

    expect(engineeringReadme).toContain("**[wizard](./wizard/SKILL.md)**");
    expect(productivityReadme).toContain("**[what](./what/SKILL.md)**");
    expect(productivityReadme).toContain("**[to-questionnaire](./to-questionnaire/SKILL.md)**");
  });

  it("keeps the two explicit escape hatches user-invoked and wizard model-invocable", async () => {
    const [what, wizard, questionnaire] = await Promise.all([
      readRepoFile("plugins/dev/skills/productivity/what/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/wizard/SKILL.md"),
      readRepoFile("plugins/dev/skills/productivity/to-questionnaire/SKILL.md"),
    ]);

    expect(what).toContain("disable-model-invocation: true");
    expect(questionnaire).toContain("disable-model-invocation: true");
    expect(wizard).not.toContain("disable-model-invocation: true");
  });

  it("ports each behavior into RedSkills vocabulary", async () => {
    const [what, wizard, questionnaire] = await Promise.all([
      readRepoFile("plugins/dev/skills/productivity/what/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/wizard/SKILL.md"),
      readRepoFile("plugins/dev/skills/productivity/to-questionnaire/SKILL.md"),
    ]);

    expect(what).toContain("ASD-STE100 Simplified Technical English");
    expect(what).toContain(".red/CONTEXT-MAP.md");
    expect(what).toContain(".red/contexts/<name>/CONTEXT.md");
    expect(wizard).toContain("<what-to-do>");
    expect(wizard).toContain("<supporting-info>");
    expect(wizard).toContain("template.sh");
    expect(questionnaire).toContain("<what-to-do>");
    expect(questionnaire).toContain("<supporting-info>");
    expect(questionnaire).toContain("Grill the send, not the subject");
  });

  it("ships generated Codex sidecars and a syntactically valid wizard template", async () => {
    const sidecars = await Promise.all([
      readRepoFile("plugins/dev/skills/productivity/what/agents/openai.yaml"),
      readRepoFile("plugins/dev/skills/engineering/wizard/agents/openai.yaml"),
      readRepoFile("plugins/dev/skills/productivity/to-questionnaire/agents/openai.yaml"),
    ]);

    expect(sidecars[0]).toContain("allow_implicit_invocation: false");
    expect(sidecars[1]).not.toContain("allow_implicit_invocation: false");
    expect(sidecars[2]).toContain("allow_implicit_invocation: false");

    await expect(
      execFileAsync("bash", ["-n", join(ROOT, "plugins/dev/skills/engineering/wizard/template.sh")]),
    ).resolves.toMatchObject({ stderr: "" });
  });
});
