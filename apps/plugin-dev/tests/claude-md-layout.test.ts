// The layout block in CLAUDE.md names directories that exist (#3101).
//
// CLAUDE.md is loaded into every agent session as project instructions, so a
// path that has drifted sends every agent to a directory that is not there.
// `apps/herdr-plugin/` outlived its rename by #3011 and cost real time before
// anyone noticed the block was describing a repo that no longer existed.
//
// A documented tree that drifts from the real one is the cheapest possible test.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");

/**
 * The `apps/` and `packages/` entries the layout block names. PURE.
 *
 * Deliberately those two sections only. They are the runtime directories an
 * agent is sent to, and `apps/herdr-plugin/` is the entry that outlived its
 * rename. The deeper `plugins/` tree is skill layout rather than a place code
 * lives, and folding it in would trade a precise guarantee for a vague one.
 */
function layoutPaths(markdown: string): readonly string[] {
  const start = markdown.indexOf("red-skills/");
  const block = markdown.slice(start, markdown.indexOf("```", start));
  const out: string[] = [];
  let section: string | null = null;
  for (const line of block.split("\n")) {
    const gloss = (line.split("←")[0] ?? "").trimEnd();
    const entry = gloss.match(/^(\s*(?:│\s*)*)[├└]──\s+(.*)$/);
    if (entry === null) continue;
    const nested = entry[1]!.includes("│");
    const names = [...entry[2]!.matchAll(/(?:^|[\s,])([a-z0-9][a-z0-9-]*)\//g)].map((m) => m[1]!);
    if (names.length === 0) continue;
    if (!nested) {
      section = names[0] === "apps" || names[0] === "packages" ? names[0]! : null;
      continue;
    }
    if (section === null) continue;
    for (const name of names) out.push(`${section}/${name}`);
  }
  return [...new Set(out)];
}

describe("CLAUDE.md layout block", () => {
  const markdown = readFileSync(join(REPO_ROOT, "CLAUDE.md"), "utf8");

  it("names at least the runtimes an agent is told to look for", () => {
    const paths = layoutPaths(markdown);
    expect(paths).toContain("apps/plugin-dev");
    expect(paths).toContain("apps/redskilled");
    expect(paths.length).toBeGreaterThan(10);
  });

  it("every directory it names exists", () => {
    const missing = layoutPaths(markdown).filter((p) => !existsSync(join(REPO_ROOT, p)));
    expect(missing, `CLAUDE.md names directories that do not exist: ${missing.join(", ")}`).toEqual([]);
  });

  it("does not name the pre-#3011 herdr path", () => {
    // The specific drift this test was written for; kept as a named case so a
    // revert is refused by name rather than by a generic existence check.
    expect(markdown).not.toContain("herdr-plugin/ ");
    expect(markdown).toContain("herdr-plugin-red-skills/");
  });
});
