import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("writer skill lane taxonomy docs", () => {
  it("routes research reports to the durable date-disambiguated home", async () => {
    const [skill, readme] = await Promise.all([
      readRepoFile("plugins/dev/skills/knowledge/research/SKILL.md"),
      readRepoFile("plugins/dev/skills/knowledge/README.md"),
    ]);

    expect(skill).toContain(".red/researches/<YYYY-MM-DD>-<slug>.md");
    expect(skill).toContain("date-disambiguated");
    expect(skill).not.toContain(".red/tmp/researches");
    expect(readme).toContain(".red/researches/<YYYY-MM-DD>-<slug>.md");
  });

  it("names the manual and docs worktree lanes explicitly", async () => {
    const [implement, retake, start] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/implement/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/retake/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/start/SKILL.md"),
    ]);

    expect(implement).toContain(".red/tmp/worktrees/manual/<slug>");
    expect(implement).toContain("git worktree add .red/tmp/worktrees/manual/<slug>");
    expect(retake).toContain(".red/tmp/worktrees/manual/<slug>");
    expect(retake).toContain("no-agent landing lane");
    expect(start).toContain(".red/tmp/worktrees/docs/<slug>");
    expect(start).toContain("docs-<YYYYMMDD>-<slug>");
  });

  it("points branch-lock docs at the state tier while noting legacy readers", async () => {
    const skill = await readRepoFile("plugins/dev/skills/misc/branch-lock/SKILL.md");

    expect(skill).toContain(".red/state/branch-lock.yaml");
    expect(skill).toContain("state tier");
    expect(skill).toContain("Legacy readers");
    expect(skill).not.toContain("./.red/tmp/branch-lock.yaml");
  });

  it("keeps red-setup self-ignore and shared-store wording on ADR 0098 paths", async () => {
    const [contract, doctor, apply] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md"),
      readRepoFile("plugins/dev/skills/engineering/red-doctor/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/red-doctor/APPLY.md"),
    ]);

    expect(contract).toContain(".red/state/red-skills.rdb");
    expect(contract).toContain("`tmp/`, `state/`, or `researches/`");
    expect(contract).toContain("researches/");
    expect(doctor).toContain("`tmp/`, `state/`, and `researches/`");
    expect(apply).toContain("`tmp/` + `state/` + `researches/`");
  });

  it("keeps AFK cleanup docs scoped to tmp janitor work and state-tier durability", async () => {
    const [skill, sweeps] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/afk/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/afk/docs/BOOT-SWEEPS.md"),
    ]);

    expect(skill).toContain(".red/state/afk/");
    expect(sweeps).toContain("state tier");
    expect(sweeps).toContain("lane janitor");
    expect(sweeps).toContain("pid-guarded and slug-sparing");
    expect(sweeps).toContain("Tmp lane cleanup never deletes `.red/state/`");
  });
});
