import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const HITL = "plugins/dev/skills/engineering/hitl";
const TROUBLESHOOTING = `${HITL}/TROUBLESHOOTING.md`;

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("hitl troubleshooting docs contract (#1865)", () => {
  it("ships the /hitl TROUBLESHOOTING reference", async () => {
    await expect(access(join(ROOT, TROUBLESHOOTING))).resolves.toBeUndefined();
  });

  it("links the troubleshooting reference from SKILL.md supporting-info", async () => {
    const skill = await readRepoFile(`${HITL}/SKILL.md`);

    expect(skill).toContain("<supporting-info>");
    expect(skill).toContain("[TROUBLESHOOTING.md](./TROUBLESHOOTING.md)");
  });

  it("carries the load-bearing playbook headings and root-fix references", async () => {
    const doc = await readRepoFile(TROUBLESHOOTING);

    expect(doc).toContain("## Verify-before-trusting");
    expect(doc).toContain("### Symptom");
    expect(doc).toContain("### Confirm");
    expect(doc).toContain("### Recover");
    expect(doc).toContain("### Root fix");
    expect(doc).toContain("gh pr checks");
    expect(doc).toContain("mergeable");

    expect(doc).toContain("## HITL card verb sets");
    expect(doc).toContain("/approve");
    expect(doc).toContain("/approve-ci");
    expect(doc).toContain("/reject");
    expect(doc).toContain("/requeue");
    expect(doc).toContain("blocked:*");

    expect(doc).toContain("#1741");
    expect(doc).toContain("#1863");
  });
});
