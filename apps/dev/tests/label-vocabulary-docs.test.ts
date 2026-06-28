import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const obsoleteHitl = `slice:${"hitl"}`;
const obsoleteAfk = `slice:${"afk"}`;
const obsoleteGlob = `slice:${"*"}`;
const manualImplRequires = `requires human ${"implementation"}`;
const manualImplNeeds = `needs human ${"implementation"}`;

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("label vocabulary docs", () => {
  it("does not teach obsolete slice-routing labels", async () => {
    const docs = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md"),
      readRepoFile("plugins/dev/skills/engineering/hitl/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/to-issues/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/triage/SKILL.md"),
      readRepoFile(".red/agents/triage-labels.md"),
      readRepoFile("README.md"),
    ]);

    for (const doc of docs) {
      expect(doc).not.toContain(obsoleteHitl);
      expect(doc).not.toContain(obsoleteAfk);
      expect(doc).not.toContain(obsoleteGlob);
    }
  });

  it("defines ready-for-human as human decision or resolution", async () => {
    const canonical = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/triage-labels.md");

    expect(canonical).toContain(
      "The issue requires human decision or resolution before it can proceed or be delegated.",
    );
    expect(canonical).not.toContain(manualImplRequires);
    expect(canonical).not.toContain(manualImplNeeds);
  });
});

describe("setup-red-skills docs", () => {
  it("documents Section H as the development-workflow activation on-ramp", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    const template = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/config-template.yaml");

    expect(skill).toContain("**Section H — Development workflow.**");
    expect(skill).toContain("dev.lock.primary-branch: true");
    expect(skill).toContain("inject-development-workflow --root");
    expect(skill).toContain("both `AGENTS.md` and `CLAUDE.md`");
    expect(skill).toContain("`/ship` as the landing command");
    // ADR 0067: the template now carries an active `plugins:` activation block
    // (dev enabled by default) with the dev lock example folded under it.
    expect(template).toContain("plugins:");
    expect(template).toContain("enabled: true");
    expect(template).toContain("#     primary-branch: true");
  });

  it("documents command guards as repo-owned proxy policy", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    const template = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/config-template.yaml");
    const readme = await readRepoFile("README.md");

    expect(skill).toContain("**Section G1 — Command guards");
    expect(skill).toContain("hooks are **proxy guarantees**, not the policy source");
    expect(skill).toContain("Examples are examples only");
    expect(skill).toContain("command_guard.global");
    expect(skill).toContain("command_guard.main");
    expect(skill).toContain("command_guard.worktree");
    expect(template).toContain("# command_guard:");
    expect(template).toContain("#   global:");
    expect(template).toContain("#   main:");
    expect(template).toContain("#   worktree:");
    expect(readme).toContain("Example policy, not a default:");
  });

  it("documents Section A0 plugin activation as the per-directory gate", async () => {
    const skill = await readRepoFile("plugins/dev/skills/engineering/setup-red-skills/SKILL.md");
    expect(skill).toContain("**Section A0 — Plugin activation");
    expect(skill).toContain("plugins.<name>.enabled: true");
    expect(skill).toContain("authorized to create `.red/`");
  });
});
