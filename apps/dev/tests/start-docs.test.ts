import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readStartSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/start/SKILL.md"), "utf8");
}

describe("start docs contract", () => {
  it("requires the end-of-session doc-landing finalizer", async () => {
    const skill = await readStartSkill();

    expect(skill).toContain("end-of-session doc-landing finalizer");
    expect(skill).toContain("Stop when the user says stop");
    expect(skill).toContain(".red/CONTEXT-MAP.md");
    expect(skill).toContain(".red/contexts/**");
    expect(skill).toContain(".red/adr/**");
    expect(skill).toContain("Announce the file list");
    expect(skill).toContain("ADR numbers");
    expect(skill).toContain("decline leaves the docs unlanded");
    expect(skill).toContain("base resolved lock > pin > main");
    expect(skill).toContain("worktree under `.red/tmp/`");
    expect(skill).toContain("docs:");
    expect(skill).toContain("one batch PR per session");
    expect(skill).toContain("no doc changes skips the finalizer silently");
  });

  it("keeps the primary-checkout safety prohibitions explicit", async () => {
    const skill = await readStartSkill();

    expect(skill).toContain("never commit in the primary checkout");
    expect(skill).toContain("never switch its branch");
    expect(skill).toContain("never stash");
    expect(skill).toContain("never reset");
  });

  it("carries the facts-vs-decisions distinction in the hard rules", async () => {
    const skill = await readStartSkill();

    // answering decisions yourself is prohibited
    expect(skill).toContain("broken the interview");
    // positive: look facts up via codebase exploration
    expect(skill).toContain("look up facts in the codebase");
    // positive: put decisions to the human
    expect(skill).toContain("decisions belong to the human");
  });
});
