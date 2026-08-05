import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");

async function readRepoFile(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

describe("red-setup release standard docs (ADR 0139, #3372)", () => {
  it("interviews for the release contract immediately after Validation moments", async () => {
    const interview = await readRepoFile(
      "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    );
    const validation = interview.indexOf("**Validation moments");
    const release = interview.indexOf("**Release standard");
    const commandGuards = interview.indexOf("**Section G1 — Command guards");

    expect(validation).toBeGreaterThan(-1);
    expect(release).toBeGreaterThan(validation);
    expect(commandGuards).toBeGreaterThan(release);
    expect(interview).toContain("`semver` or `calver`");
    expect(interview).toContain("`YYYY.M.MICRO`");
    expect(interview).toContain("`version-pr` (default) or `auto`");
    expect(interview).toContain("pre-release");
    expect(interview).toContain("pinned npx");
    expect(interview).toContain("vendored");
    expect(interview).toContain("detect, propose, then confirm");
    expect(interview).toContain("`release.version_surfaces`");
    expect(interview).toContain("only after explicit confirmation");
  });

  it("ships the exact release config contract and write instructions", async () => {
    const [template, contract, reference, setup] = await Promise.all([
      readRepoFile("plugins/dev/skills/engineering/red-setup/config-template.yaml"),
      readRepoFile("plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md"),
      readRepoFile("plugins/dev/skills/engineering/red-setup/REFERENCE.md"),
      readRepoFile("plugins/dev/skills/engineering/red-setup/SKILL.md"),
    ]);

    for (const line of [
      "# release:",
      "#   scheme: semver",
      "#   trigger: version-pr",
      "#   prerelease: true",
      "#   execution: pinned",
      "#   version_surfaces:",
      "#     - path: package.json",
      "#       format: npm",
      "#   sync_command: node scripts/sync-release-carriers.mjs",
    ]) {
      expect(template).toContain(line);
    }
    expect(contract).toContain("exact confirmed `release.*` block");
    expect(contract).toContain("Never write detected Version surfaces without confirmation");
    expect(contract).toContain("fresh or existing `.red/config.yaml`");
    expect(reference).toContain("**Release standard**");
    expect(setup).toContain("Release standard");
  });

  it("keeps ask-red coverage routed to the release setup contract", async () => {
    const askRed = await readRepoFile("plugins/dev/skills/engineering/ask-red/SKILL.md");

    expect(askRed).toContain("`release.*` contract");
    expect(askRed).toContain("Version surfaces");
    expect(askRed).toContain("red-setup/INTERVIEW.md");
    expect(askRed).toContain("red-setup/config-template.yaml");
  });
});
