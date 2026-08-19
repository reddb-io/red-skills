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

  it("leaves the previous name nowhere in the tree", () => {
    // The rename was recorded in the commit, not in a ledger: `CHANGES.md` was
    // retired for describing what git already describes. So the old name must
    // survive in NO tracked file — `git grep` exiting 1 is the pass.
    let hits: string[] = [];
    try {
      // `.changeset/` is exempt: a release note explaining a rename must NAME
      // what was renamed. That is a record of history, like an ADR describing a
      // removed surface — not a pointer some reader could still follow.
      hits = execFileSync("git", ["grep", "-l", PREVIOUS_NAME, "--", ".", ":(exclude).changeset"], {
        cwd: ROOT,
        encoding: "utf8",
      })
        .trim()
        .split("\n")
        .filter(Boolean);
    } catch {
      // `git grep` exits non-zero when nothing matches — the state we want.
    }
    expect(hits).toEqual([]);
  });
});
