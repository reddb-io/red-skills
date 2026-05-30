import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { legacyScriptPath, skillDirFromModule } from "../src/platform/legacy.js";

describe("legacy shell bridge", () => {
  it("locates the skill root from nested src/dist module paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "afk-skill-"));
    await mkdir(join(root, "scripts"), { recursive: true });
    await writeFile(join(root, "scripts", "afk.sh"), "#!/usr/bin/env bash\n", "utf8");

    const nestedModule = pathToFileURL(join(root, "dist", "platform", "legacy.js")).href;
    expect(skillDirFromModule(nestedModule)).toBe(root);
    expect(legacyScriptPath("monitor", root)).toBe(join(root, "scripts", "monitor.sh"));
  });
});
