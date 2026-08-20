import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(join(import.meta.dirname, "..", "src", "github-write.ts"), "utf8");

/**
 * The Project mirror's `origin` is the human checkout — a local path — so a
 * `git push origin` from the mirror delivered nowhere: the auth header was
 * meaningless, the refusal wrapped into a bare "Internal error", and every
 * publish on the machine died at this line (observed: four turns across
 * #4157/#4161, all `refused at publish: Internal error`). Source-pinned like
 * bounded-request: the push must name the canonical URL, and its failure must
 * carry git's own words.
 */
describe("the repository push reaches the canonical repository", () => {
  it("pushes to the canonical GitHub URL derived from the project label", () => {
    expect(SOURCE).toContain("`https://github.com/${input.project.projectLabel}.git`");
    expect(SOURCE).toContain('execFile("git", ["push", remote,');
    expect(SOURCE).not.toMatch(/execFile\("git", \["push", "origin"/);
  });

  it("names the remote and git's own words in the failure", () => {
    expect(SOURCE).toContain("redskilled repository push to ${remote} failed");
  });
});
