import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const builder = join(ROOT, "scripts/build-pi-packages.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Pi package builder", () => {
  it("stages per-plugin npm-ready packages with skills copied under packaging/pi/", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-build-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/engineering/afk"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/knowledge/wiki"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/in-progress/scratch"), { recursive: true });
    await mkdir(join(root, "plugins/memory/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/memory/skills/core/init"), { recursive: true });

    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [
        { name: "dev", source: "./plugins/dev", description: "Dev plugin." },
        { name: "memory", source: "./plugins/memory", description: "Memory plugin." },
      ],
    });

    await writeJson(join(root, "plugins/dev/.claude-plugin/plugin.json"), {
      name: "dev",
      version: "9.9.9",
      description: "Dev plugin.",
      skills: ["./skills/engineering/afk", "./skills/knowledge/wiki"],
    });

    await writeJson(join(root, "plugins/memory/.claude-plugin/plugin.json"), {
      name: "memory",
      version: "9.9.9",
      description: "Memory plugin.",
      skills: ["./skills/core/init"],
    });

    await writeFile(
      join(root, "plugins/dev/skills/engineering/afk/SKILL.md"),
      `---
name: afk
description: Test afk skill.
---

# AFK
`,
      "utf8",
    );
    await writeFile(
      join(root, "plugins/dev/skills/knowledge/wiki/SKILL.md"),
      `---
name: wiki
description: Test wiki skill.
---

# Wiki
`,
      "utf8",
    );
    await writeFile(
      join(root, "plugins/dev/skills/in-progress/scratch/SKILL.md"),
      `# Should be excluded — in-progress/`,
      "utf8",
    );
    await writeFile(
      join(root, "plugins/memory/skills/core/init/SKILL.md"),
      `---
name: init
description: Test init skill.
---

# Init
`,
      "utf8",
    );

    await execFileAsync("node", [builder, "--root", root]);

    // npm-ready package.json shape
    const devPkg = JSON.parse(
      await readFile(join(root, "packaging/pi/dev/package.json"), "utf8"),
    );
    expect(devPkg).toMatchObject({
      name: "@reddb-io/red-skills-dev",
      version: "9.9.9",
      publishConfig: { access: "public" },
      files: expect.arrayContaining(["skills/**/*", "package.json", "README.md"]),
    });
    // The build drops the local-only "private": true flag — the staged
    // package must be publishable. Verifying via negation: there is no
    // truthy `private` key.
    expect(devPkg.private).not.toBe(true);
    expect(devPkg.pi.skills).toEqual(["./skills/engineering/", "./skills/knowledge/"]);

    // Skills copied + in-progress/ excluded
    const afk = await readFile(
      join(root, "packaging/pi/dev/skills/engineering/afk/SKILL.md"),
      "utf8",
    );
    expect(afk).toContain("# AFK");
    const scratchExists = await readFile(
      join(root, "packaging/pi/dev/skills/in-progress/scratch/SKILL.md"),
      "utf8",
    ).then(
      () => true,
      () => false,
    );
    expect(scratchExists).toBe(false);

    // Memory mirrors the same shape with its core bucket
    const memoryPkg = JSON.parse(
      await readFile(join(root, "packaging/pi/memory/package.json"), "utf8"),
    );
    expect(memoryPkg.pi.skills).toEqual(["./skills/core/"]);
  });

  it("fails --check when a staged Pi package drifts from the source", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-build-check-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/engineering/afk"), { recursive: true });

    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [{ name: "dev", source: "./plugins/dev", description: "Dev." }],
    });
    await writeJson(join(root, "plugins/dev/.claude-plugin/plugin.json"), {
      name: "dev",
      version: "9.9.9",
      description: "Dev.",
      skills: ["./skills/engineering/afk"],
    });
    await writeFile(
      join(root, "plugins/dev/skills/engineering/afk/SKILL.md"),
      `---
name: afk
description: afk
---

# afk
`,
      "utf8",
    );

    await execFileAsync("node", [builder, "--root", root]);
    const staged = join(root, "packaging/pi/dev/package.json");
    const pkg = JSON.parse(await readFile(staged, "utf8"));
    pkg.description = "hand-edited drift";
    await writeJson(staged, pkg);

    await expect(
      execFileAsync("node", [builder, "--root", root, "--check"]),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Pi packages are stale"),
    });
  });

  it("matches the builder output for the repo's committed plugin manifests", async () => {
    await execFileAsync("node", [builder, "--root", ROOT, "--check"]);
  });
});