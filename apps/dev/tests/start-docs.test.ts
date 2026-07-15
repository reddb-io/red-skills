import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readStartSkill(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/start/SKILL.md"), "utf8");
}

async function readDocLandingProcedure(): Promise<string> {
  return readFile(join(ROOT, "plugins/dev/skills/engineering/start/DOC-LANDING-FINALIZER.md"), "utf8");
}

describe("start docs contract", () => {
  it("references the shared end-of-session doc-landing finalizer", async () => {
    const skill = await readStartSkill();

    expect(skill).toContain("end-of-session doc-landing finalizer");
    expect(skill).toContain("DOC-LANDING-FINALIZER.md");
    expect(skill).not.toContain("create one worktree under `.red/tmp/worktrees/docs/<slug>`");
  });

  it("keeps the shared end-of-session doc-landing finalizer contract", async () => {
    const procedure = await readDocLandingProcedure();

    expect(procedure).toContain("end-of-session doc-landing finalizer");
    expect(procedure).toContain("the user stops or every reachable branch is resolved");
    expect(procedure).toContain(".red/CONTEXT-MAP.md");
    expect(procedure).toContain(".red/contexts/**");
    expect(procedure).toContain(".red/adr/**");
    expect(procedure).toContain("Announce the file list");
    expect(procedure).toContain("ADR numbers");
    expect(procedure).toContain("decline leaves the docs unlanded");
    expect(procedure).toContain("base resolved lock > pin > main");
    expect(procedure).toContain("worktree under `.red/tmp/worktrees/docs/<slug>`");
    expect(procedure).toContain("docs-<YYYYMMDD>-<slug>");
    expect(procedure).toContain("docs:");
    expect(procedure).toContain("one batch PR per session");
    expect(procedure).toContain("no doc changes skips the finalizer silently");
  });

  it("keeps the primary-checkout safety prohibitions explicit", async () => {
    const procedure = await readDocLandingProcedure();

    expect(procedure).toContain("never commit in the primary checkout");
    expect(procedure).toContain("never switch its branch");
    expect(procedure).toContain("never stash");
    expect(procedure).toContain("never reset");
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
