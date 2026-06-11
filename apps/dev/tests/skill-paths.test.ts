import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { skillDirFromModule } from "../src/platform/skill-paths.js";

describe("skill-paths — skillDirFromModule", () => {
  it("locates the skill root from a nested bundle path via defaults/", async () => {
    // The shipped layout: <skill>/bin/afk.mjs alongside <skill>/defaults/*.sh.
    const root = await mkdtemp(join(tmpdir(), "afk-skill-"));
    await mkdir(join(root, "defaults"), { recursive: true });
    await writeFile(join(root, "defaults", "cargo-pre-worktree.sh"), "#!/usr/bin/env bash\n", "utf8");

    const bundleModule = pathToFileURL(join(root, "bin", "afk.mjs")).href;
    expect(skillDirFromModule(bundleModule)).toBe(root);
  });

  it("throws when no defaults/ ancestor exists (source-tree run)", () => {
    const orphan = pathToFileURL(join(tmpdir(), "no-skill-here", "x.js")).href;
    expect(() => skillDirFromModule(orphan)).toThrow(/could not locate/i);
  });
});
