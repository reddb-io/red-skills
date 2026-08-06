import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SKILL = "writing-for-agents";
const PREVIOUS_NAME = ["write", "a", "skill"].join("-");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("writing-for-agents docs contract (#3433)", () => {
  it("registers the renamed skill in every public and generated surface", async () => {
    const [manifest, rootReadme, bucketReadme, router, claude, sidecar, packaged] = await Promise.all([
      readRepoFile("plugins/dev/.claude-plugin/plugin.json"),
      readRepoFile("README.md"),
      readRepoFile("plugins/dev/skills/productivity/README.md"),
      readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md"),
      readRepoFile("CLAUDE.md"),
      readRepoFile(`plugins/dev/skills/productivity/${SKILL}/agents/openai.yaml`),
      readRepoFile(`packaging/pi/dev/skills/productivity/${SKILL}/SKILL.md`),
    ]);

    for (const surface of [manifest, rootReadme, bucketReadme, router, claude, packaged]) {
      expect(surface).toContain(SKILL);
    }
    expect(sidecar).toContain('display_name: "Writing For Agents"');
    expect(sidecar).toContain("AGENTS.md");
    expect(sidecar).toContain("CLAUDE.md");
  });

  it("claims agent-read documents and defines the shared information-design vocabulary", async () => {
    const skill = await readRepoFile(`plugins/dev/skills/productivity/${SKILL}/SKILL.md`);

    expect(skill).toContain("AGENTS.md");
    expect(skill).toContain("CLAUDE.md");
    expect(skill).toContain("Context pointer");
    expect(skill).toContain("context load");
    expect(skill).toContain("cognitive load");
    expect(skill).toContain("Information hierarchy");
    expect(skill).toContain("in-file step");
    expect(skill).toContain("in-file reference");
    expect(skill).toContain("disclosed reference");
    expect(skill).toContain("Completion criteria");
    expect(skill).toContain("clarity");
    expect(skill).toContain("demand");
    expect(skill).toContain("Leading words");
    expect(skill).toContain("Negation");
    expect(skill).toContain("Pruning");
    expect(skill).toContain("single source of truth");
    expect(skill).toContain("environment as a source of truth");
    expect(skill).toContain("sediment");
    expect(skill).toContain("no-op test");
    expect(skill).toContain("[WRITING-STYLE.md](WRITING-STYLE.md)");
  });

  it("leaves the previous name only in the required rename status", async () => {
    const changes = await readRepoFile("CHANGES.md");
    expect(changes).toContain(`status**: renamed-from-${PREVIOUS_NAME}`);
    expect(changes).toContain("upstream**: `8b36d4f`");

    const hits = execFileSync("git", ["grep", "-l", PREVIOUS_NAME, "--", "."], {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);
    expect(hits).toEqual(["CHANGES.md"]);
  });
});
