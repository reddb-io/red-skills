import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { buildPiPackages } from "../../../scripts/build-pi-packages.mjs";
import {
  jsonBytes,
  normalizeSkillEntry,
  normalizeText,
  parseArgs,
  titleCaseName,
} from "../../../scripts/lib/manifest-core.mjs";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const builder = join(ROOT, "scripts/build-pi-packages.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("manifest-core helpers", () => {
  it("parseArgs returns defaults with no argv", () => {
    const args = parseArgs([]);
    expect(args).toEqual({ root: process.cwd(), check: false });
  });

  it("parseArgs parses --root and --check", () => {
    expect(parseArgs(["--root", "/tmp/x", "--check"])).toEqual({ root: "/tmp/x", check: true });
    expect(parseArgs(["--check", "--root", "/tmp/y"])).toEqual({ root: "/tmp/y", check: true });
  });

  it("parseArgs throws on unknown argument", () => {
    expect(() => parseArgs(["--unknown"])).toThrow("unknown argument: --unknown");
  });

  it("parseArgs throws when --root has no value", () => {
    expect(() => parseArgs(["--root"])).toThrow("--root requires a path");
  });

  it("titleCaseName capitalizes hyphen-separated words", () => {
    expect(titleCaseName("dev")).toBe("Dev");
    expect(titleCaseName("red-skills")).toBe("Red Skills");
    expect(titleCaseName("build-info")).toBe("Build Info");
  });

  it("normalizeSkillEntry strips trailing slashes", () => {
    expect(normalizeSkillEntry("./skills/engineering/")).toBe("./skills/engineering");
    expect(normalizeSkillEntry("./skills/engineering//")).toBe("./skills/engineering");
    expect(normalizeSkillEntry("./skills/engineering")).toBe("./skills/engineering");
  });

  it("normalizeText sanitizes unicode punctuation", () => {
    // backtick and smart single quotes → removed
    expect(normalizeText("don’t")).toBe("dont");
    expect(normalizeText("`backtick`")).toBe("backtick");
    // smart double quotes → regular double quotes
    expect(normalizeText("“smart”")).toBe('"smart"');
    // en/em dashes → hyphen
    expect(normalizeText("a–b")).toBe("a-b");
    expect(normalizeText("a—b")).toBe("a-b");
    // ellipsis → ...
    expect(normalizeText("wait…")).toBe("wait...");
    // collapses whitespace
    expect(normalizeText("  too   many   spaces  ")).toBe("too many spaces");
    // null/undefined → empty string
    expect(normalizeText(null)).toBe("");
    expect(normalizeText(undefined)).toBe("");
  });

  it("jsonBytes serializes with two-space indent and trailing newline", () => {
    expect(jsonBytes({ a: 1 })).toBe('{\n  "a": 1\n}\n');
    expect(jsonBytes([1, 2])).toBe('[\n  1,\n  2\n]\n');
  });
});

describe("Pi package builder", () => {
  it("stages per-plugin npm-ready packages with skills copied under packaging/pi/ (module API)", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-build-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/engineering/afk"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/knowledge/wiki"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/in-progress/scratch"), { recursive: true });
    await mkdir(join(root, "plugins/memory/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/memory/skills/core/init"), { recursive: true });
    await mkdir(join(root, "dist"), { recursive: true });
    // The definition surface beyond skills: hooks, .mcp.json, and a
    // .gitignore that must NOT travel (it would hide dist/ from npm-packlist).
    await mkdir(join(root, "plugins/dev/hooks"), { recursive: true });
    await writeFile(join(root, "plugins/dev/hooks/claude.hooks.json"), '{"hooks":{}}\n', "utf8");
    await writeFile(join(root, "plugins/dev/.mcp.json"), '{"mcpServers":{}}\n', "utf8");
    await writeFile(join(root, "plugins/dev/.gitignore"), "dist/\n", "utf8");

    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [
        { name: "dev", source: "./plugins/dev", description: "Dev plugin." },
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
    await writeFile(join(root, "dist/dev.bundle.min.mjs"), "// dev runtime\n", "utf8");
    await writeFile(join(root, "dist/memory.bundle.min.mjs"), "// memory runtime\n", "utf8");
    await writeFile(join(root, "dist/memory-tokenizer.asset.cjs"), "// tokenizer ranks\n", "utf8");

    await buildPiPackages({ root });

    // npm-ready package.json shape
    const devPkg = JSON.parse(
      await readFile(join(root, "packaging/pi/dev/package.json"), "utf8"),
    );
    expect(devPkg).toMatchObject({
      name: "@reddb-io/red-skills-dev",
      version: "9.9.9",
      publishConfig: { access: "public" },
      files: expect.arrayContaining([
        "skills/**/*",
        "dist/**/*",
        ".claude-plugin/**/*",
        ".mcp.json",
        "hooks/**/*",
        "package.json",
        "README.md",
      ]),
    });
    // The package IS the plugin: manifests, hooks and .mcp.json ride along so
    // the OpenCode/RedCode generator and a local marketplace can consume it.
    expect(await readFile(join(root, "packaging/pi/dev/.claude-plugin/plugin.json"), "utf8"))
      .toContain('"name": "dev"');
    expect(await readFile(join(root, "packaging/pi/dev/hooks/claude.hooks.json"), "utf8"))
      .toBe('{"hooks":{}}\n');
    expect(await readFile(join(root, "packaging/pi/dev/.mcp.json"), "utf8"))
      .toBe('{"mcpServers":{}}\n');
    expect(devPkg.files).not.toContain(".gitignore");
    const gitignoreStaged = await readFile(join(root, "packaging/pi/dev/.gitignore"), "utf8").then(
      () => true,
      () => false,
    );
    expect(gitignoreStaged).toBe(false);
    // The build drops the local-only "private": true flag — the staged
    // package must be publishable. Verifying via negation: there is no
    // truthy `private` key.
    expect(devPkg.private).not.toBe(true);
    expect(devPkg.pi.skills).toEqual([
      "./skills/engineering/*/SKILL.md",
      "./skills/knowledge/*/SKILL.md",
    ]);

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
    expect(await readFile(join(root, "packaging/pi/dev/dist/dev.bundle.min.mjs"), "utf8"))
      .toBe("// dev runtime\n");

    // Memory is discovered from plugins/* even though it is absent from the
    // marketplace fixture, and mirrors the same shape with its own bundle.
    const memoryPkg = JSON.parse(
      await readFile(join(root, "packaging/pi/memory/package.json"), "utf8"),
    );
    expect(memoryPkg.pi.skills).toEqual(["./skills/core/*/SKILL.md"]);
    expect(await readFile(join(root, "packaging/pi/memory/dist/memory.bundle.min.mjs"), "utf8"))
      .toBe("// memory runtime\n");
    expect(await readFile(join(root, "packaging/pi/memory/dist/memory-tokenizer.asset.cjs"), "utf8"))
      .toBe("// tokenizer ranks\n");
  });

  it("fails --check when a staged Pi package drifts from the source (module API)", async () => {
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

    await buildPiPackages({ root });
    const staged = join(root, "packaging/pi/dev/package.json");
    const pkg = JSON.parse(await readFile(staged, "utf8"));
    pkg.description = "hand-edited drift";
    await writeJson(staged, pkg);

    await expect(buildPiPackages({ root, check: true })).rejects.toThrow("Pi packages are stale");
  });

  it("matches the builder output for the repo's committed plugin manifests (subprocess smoke)", async () => {
    // One subprocess call pins the main()-guard CLI contract: the script must
    // be directly executable as `node build-pi-packages.mjs` in addition to
    // being importable as a module.
    await execFileAsync("node", [builder, "--root", ROOT, "--check"]);
  });

  it("stamps RED_BUILD_VERSION over the plugin manifest version (module API)", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-ver-"));
    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/skills/engineering/afk"), {
      recursive: true,
    });
    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [
        { name: "dev", source: "./plugins/dev", description: "Dev plugin." },
      ],
    });
    await writeJson(join(root, "plugins/dev/.claude-plugin/plugin.json"), {
      name: "dev",
      version: "9.9.9", // stale committed manifest version at Pi-build time
      description: "Dev plugin.",
      skills: ["./skills/engineering/afk"],
    });
    await writeFile(
      join(root, "plugins/dev/skills/engineering/afk/SKILL.md"),
      `---
name: afk
description: Test afk skill.
---

# afk
`,
      "utf8",
    );

    const prev = process.env.RED_BUILD_VERSION;
    process.env.RED_BUILD_VERSION = "v1.2.3";
    try {
      await buildPiPackages({ root });
    } finally {
      if (prev === undefined) {
        delete process.env.RED_BUILD_VERSION;
      } else {
        process.env.RED_BUILD_VERSION = prev;
      }
    }

    const pkg = JSON.parse(
      await readFile(join(root, "packaging/pi/dev/package.json"), "utf8"),
    );
    // The resolved NEXT (RED_BUILD_VERSION) wins over the stale 9.9.9 manifest,
    // so the published package matches what the registry smoke expects.
    expect(pkg.version).toBe("1.2.3");
  });
});
