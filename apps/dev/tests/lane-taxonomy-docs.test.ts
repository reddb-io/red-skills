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
    const [implement, retake, docLandingFinalizer] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/implement/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/retake/SKILL.md"),
      readRepoFile("plugins/dev/skills/engineering/start/DOC-LANDING-FINALIZER.md"),
    ]);

    expect(implement).toContain(".red/tmp/worktrees/manual/<slug>");
    expect(implement).toContain("git worktree add .red/tmp/worktrees/manual/<slug>");
    expect(retake).toContain(".red/tmp/worktrees/manual/<slug>");
    expect(retake).toContain("no-agent landing lane");
    expect(docLandingFinalizer).toContain(".red/tmp/worktrees/docs/<slug>");
    expect(docLandingFinalizer).toContain("docs-<YYYYMMDD>-<slug>");
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

    expect(skill).toContain(".red/state/castle/");
    expect(sweeps).toContain("state tier");
    expect(sweeps).toContain("lane janitor");
    expect(sweeps).toContain("pid-guarded and slug-sparing");
    expect(sweeps).toContain("Tmp lane cleanup never deletes `.red/state/`");
  });

  it("separates host-daemon, Worker, and dispatch log ownership", async () => {
    const [adr, index, claude] = await Promise.all([
      readRepoFile(".red/adr/0098-red-directory-lifecycle-taxonomy.md"),
      readRepoFile(".red/adr/INDEX.md"),
      readRepoFile("CLAUDE.md"),
    ]);

    expect(adr).toContain("Amendment 1 — log ownership has three layers");
    expect(adr).toContain("`provisionRedskilledHome`");
    expect(adr).toContain("`~/.red/redskilled/state/deaths/deaths.toonl`");
    expect(adr).toContain("must never contain daemon logs");
    expect(adr).toContain("`.red/tmp/workers/{id}/{issue}/worktree`");
    expect(adr).toContain("`.red/tmp/workers/{id}/worker.log.toonl`");
    expect(adr).toContain("`.red/tmp/logs/<yyyy-mm-dd>/dispatch-<ts>-<id>.log`");
    expect(adr).toContain("stdout and stderr");
    expect(adr).toContain("structured Worker lifecycle");
    expect(index).toContain("log ownership has three non-overlapping layers");
    expect(claude).toContain("A project's `.red/` never contains `redskilled` daemon logs");
    expect(claude).toContain("`.red/tmp/workers/{id}/worker.log.toonl`");
    expect(claude).toContain("`dispatch-<ts>-<id>.log`");
  });
});
