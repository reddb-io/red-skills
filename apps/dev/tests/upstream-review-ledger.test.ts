import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const UPSTREAM_SHA = "8b36d4fb2635b3c21998dcd8144439c9e5ba7302";

describe("upstream v1.2.2 review ledger", () => {
  it("pins the reviewed 100-commit span and records every disposition", async () => {
    const [upstream, changes] = await Promise.all([
      readFile(join(ROOT, ".upstream"), "utf8"),
      readFile(join(ROOT, "CHANGES.md"), "utf8"),
    ]);

    expect(upstream).toBe(`repo=mattpocock/skills\nsha=${UPSTREAM_SHA}\n`);
    expect(changes).toContain(
      `Upstream base: \`mattpocock/skills@${UPSTREAM_SHA}\` (reviewed 100 commits after \`66898f6\`; see \`.upstream\`).`,
    );

    for (const adoptedIssue of ["#3431", "#3432", "#3433"]) {
      expect(changes).toContain(`issue ${adoptedIssue}`);
    }

    expect(changes).toContain("Composition deliberately NOT adopted");
    expect(changes).toContain("kept our enumerated `Branches:`");
    expect(changes).toContain("rather than upstream's subagent dispatch");
  });
});
