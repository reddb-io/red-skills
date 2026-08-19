import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

const TROUBLESHOOTING_DOCS = [
  {
    command: "/afk",
    skill: "plugins/dev/skills/engineering/afk/SKILL.md",
    troubleshooting: "plugins/dev/skills/engineering/afk/TROUBLESHOOTING.md",
    headings: [
      "## Gate census when ready-for-agent is empty",
      "## False main-red verification",
      "## Scout and worker salvage after crashed or no-sentinel runs",
      "## Park-resolution contract",
      "## Base-stale decision procedure",
      "## Requeue escalation map",
      "## Release-pipeline playbook",
      "## Fleet stop and takeover verification",
    ],
  },
  {
    command: "/go",
    skill: "plugins/dev/skills/engineering/go/SKILL.md",
    troubleshooting: "plugins/dev/skills/engineering/go/TROUBLESHOOTING.md",
    headings: ["## Crashed-scout salvage", "## Engine-exit-0-but-parked reading"],
  },
  {
    command: "/hitl",
    skill: "plugins/dev/skills/engineering/hitl/SKILL.md",
    troubleshooting: "plugins/dev/skills/engineering/hitl/TROUBLESHOOTING.md",
    headings: ["## Verify-before-trusting", "## HITL card verb sets"],
  },
  {
    command: "rsp",
    skill: "plugins/dev/skills/engineering/red-gains/SKILL.md",
    troubleshooting: "apps/rsp/docs/TROUBLESHOOTING.md",
    headings: ["## Hook silence", "## Resident/store split", "## Store growth"],
  },
];

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("TROUBLESHOOTING playbook contract (#1867)", () => {
  it("documents the fixed playbook and docs-contract conventions once", async () => {
    const skill = await readRepoFile("plugins/dev/skills/productivity/writing-for-agents/SKILL.md");

    expect(skill).toContain("Symptom -> Confirm -> Recover -> Root fix");
    expect(skill).toContain("Docs-contract tests for TROUBLESHOOTING references");
    expect(skill).toContain("assert file existence, the SKILL.md link, and stable load-bearing headings");
    expect(skill).toContain("do not assert prose wording");
  });

  it("registers each TROUBLESHOOTING reference in ask-red inventory and routes", async () => {
    const askRed = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    for (const { command, troubleshooting } of TROUBLESHOOTING_DOCS) {
      expect(askRed).toContain(command);
      expect(askRed).toContain(troubleshooting);
    }
  });

  it("keeps each TROUBLESHOOTING reference discoverable and structurally pinned", async () => {
    for (const { skill, troubleshooting, headings } of TROUBLESHOOTING_DOCS) {
      await expect(access(join(ROOT, troubleshooting))).resolves.toBeUndefined();

      const skillDoc = await readRepoFile(skill);
      const troubleshootingDoc = await readRepoFile(troubleshooting);

      expect(skillDoc).toContain("TROUBLESHOOTING.md");
      expect(troubleshootingDoc).toContain("Symptom -> Confirm -> Recover -> Root fix");
      expect(troubleshootingDoc).toContain("writing-for-agents");

      for (const heading of ["### Symptom", "### Confirm", "### Recover", "### Root fix"]) {
        expect(troubleshootingDoc).toContain(heading);
      }

      for (const heading of headings) {
        expect(troubleshootingDoc).toContain(heading);
      }
    }
  });
});
