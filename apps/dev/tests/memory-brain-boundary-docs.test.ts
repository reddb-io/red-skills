import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("Memory/Brain boundary docs", () => {
  it("routes Personal facts to Brain and keeps Memory operational", async () => {
    const readme = await readRepoFile("README.md");
    const memoryReadme = await readRepoFile("plugins/memory/README.md");
    const brainReadme = await readRepoFile("plugins/brain/README.md");

    expect(readme).toContain("Personal facts belong in Brain, not Memory.");
    expect(readme).toContain("Memory is not the Personal-fact store.");
    expect(memoryReadme).toContain("not a Personal-fact store");
    expect(memoryReadme).toContain("belong in Brain artifacts under `.red/brain/*`");
    expect(brainReadme).toContain("Brain owns Personal facts");
    expect(brainReadme).toContain("human-facing context");
  });

  it("documents the routing boundary where agents choose a context surface", async () => {
    const contextSkill = await readRepoFile("plugins/dev/skills/engineering/context/SKILL.md");
    const memoryStore = await readRepoFile("plugins/memory/skills/core/store/SKILL.md");
    const memoryExtract = await readRepoFile("plugins/memory/skills/core/extract/SKILL.md");
    const brainCapture = await readRepoFile("plugins/brain/skills/core/capture/SKILL.md");

    expect(contextSkill).toContain("Route human-facing context to Brain with `brain capture`.");
    expect(contextSkill).toContain("| Durable operational work fact | `/memory:store` |");
    expect(contextSkill).toContain("| Personal fact or human-facing context | `brain capture` / `/brain:capture` |");
    expect(memoryStore).toContain("Don't store Personal facts");
    expect(memoryStore).toContain("route to `brain capture` instead");
    expect(memoryExtract).toContain("Do not extract");
    expect(memoryExtract).toContain("Odysseus-style Personal facts");
    expect(brainCapture).toContain("Route personal facts, identity context, and human knowledge to Brain");
  });
});
