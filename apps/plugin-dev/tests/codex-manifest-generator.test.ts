import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { REPO_INVARIANT_SUITES } from "../src/core/repo-invariants.js";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const generator = join(ROOT, "scripts/generate-codex-manifests.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writeSkill(
  root: string,
  name: string,
  description: string,
  disableModelInvocation = false,
): Promise<string> {
  const skillRoot = join(root, "plugins/example/skills/core", name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    [
      "---",
      `name: ${name}`,
      `description: ${description}`,
      ...(disableModelInvocation ? ["disable-model-invocation: true"] : []),
      "---",
      "",
      `# ${name}`,
      "",
    ].join("\n"),
  );
  return skillRoot;
}

describe("Codex manifest generator", () => {
  it("projects a Claude-side plugin addition into Codex marketplace entries and plugin manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-codex-manifests-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/example/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/internal/.claude-plugin"), { recursive: true });

    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [
        {
          name: "dev",
          source: "./plugins/dev",
          description: "Development automation.",
        },
        {
          name: "example",
          source: "./plugins/example",
          description: "Example plugin — shows fixture generation.",
          dependencies: ["dev"],
        },
        {
          name: "internal",
          source: "./plugins/internal",
          description: "Internal plugin — maintainer-only repository operations.",
        },
      ],
    });

    await writeJson(join(root, "plugins/dev/.claude-plugin/plugin.json"), {
      name: "dev",
      version: "9.9.9",
      description: "Development automation.",
      skills: ["./skills/engineering/afk", "./skills/knowledge/wiki"],
    });

    await writeJson(join(root, "plugins/example/.claude-plugin/plugin.json"), {
      name: "example",
      version: "9.9.9",
      description: "Example plugin — shows fixture generation.",
      dependencies: ["dev"],
      hooks: "./hooks/claude.hooks.json",
      mcpServers: "./.mcp.json",
      skills: ["./skills/core/init", "./skills/core/recall"],
    });

    await writeJson(join(root, "plugins/internal/.claude-plugin/plugin.json"), {
      name: "internal",
      version: "9.9.9",
      description: "Internal plugin — maintainer-only repository operations.",
      skills: ["./skills/core/bootstrap"],
    });

    await execFileAsync("node", [generator, "--root", root]);

    const marketplace = JSON.parse(await readFile(join(root, ".agents/plugins/marketplace.json"), "utf8"));
    expect(marketplace.plugins).toContainEqual({
      name: "example",
      source: {
        source: "local",
        path: "./plugins/example",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      dependencies: ["dev"],
      description: "Example plugin - shows fixture generation.",
      category: "Developer Tools",
    });
    expect(marketplace.plugins).toContainEqual({
      name: "internal",
      source: {
        source: "local",
        path: "./plugins/internal",
      },
      policy: {
        installation: "AVAILABLE",
        authentication: "ON_USE",
      },
      description: "Internal plugin - maintainer-only repository operations.",
      category: "Developer Tools",
    });

    const plugin = JSON.parse(await readFile(join(root, "plugins/example/.codex-plugin/plugin.json"), "utf8"));
    expect(plugin).toMatchObject({
      name: "example",
      version: "9.9.9",
      description: "Example plugin - shows fixture generation.",
      dependencies: ["dev"],
      skills: ["./skills/core/"],
      hooks: "./hooks/codex.hooks.json",
      mcpServers: "./.mcp.json",
      interface: {
        displayName: "RedSkills Example",
        developerName: "reddb.io",
        category: "Developer Tools",
      },
    });
  });

  it("fails --check when a committed Codex manifest drifts from the generator", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-codex-manifests-check-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });

    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [
        {
          name: "dev",
          source: "./plugins/dev",
          description: "Development automation.",
        },
      ],
    });

    await writeJson(join(root, "plugins/dev/.claude-plugin/plugin.json"), {
      name: "dev",
      version: "9.9.9",
      description: "Development automation.",
      skills: ["./skills/engineering/afk"],
    });

    await execFileAsync("node", [generator, "--root", root]);
    const manifestPath = join(root, "plugins/dev/.codex-plugin/plugin.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.description = "hand edited";
    await writeJson(manifestPath, manifest);

    await expect(execFileAsync("node", [generator, "--root", root, "--check"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Codex manifests are stale"),
    });
  });

  it("generates a Codex sidecar from every skill's frontmatter", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-codex-sidecars-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/example/.claude-plugin"), { recursive: true });
    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [{ name: "example", source: "./plugins/example", description: "Example." }],
    });
    await writeJson(join(root, "plugins/example/.claude-plugin/plugin.json"), {
      name: "example",
      version: "9.9.9",
      description: "Example.",
      skills: ["./skills/core/visible"],
    });
    const visible = await writeSkill(root, "visible-skill", "A visible skill — with smart punctuation.");
    const userInvoked = await writeSkill(root, "user-invoked", "Run only when named.", true);

    await execFileAsync("node", [generator, "--root", root]);

    expect(await readFile(join(visible, "agents/openai.yaml"), "utf8")).toBe(
      'interface:\n  display_name: "Visible Skill"\n  short_description: "A visible skill - with smart punctuation."\n',
    );
    expect(await readFile(join(userInvoked, "agents/openai.yaml"), "utf8")).toBe(
      'interface:\n  display_name: "User Invoked"\n  short_description: "Run only when named."\npolicy:\n  allow_implicit_invocation: false\n',
    );
  });

  it.each([
    {
      defect: "missing",
      mutate: async (skillRoot: string) => rm(join(skillRoot, "agents/openai.yaml")),
    },
    {
      defect: "stale against frontmatter",
      mutate: async (skillRoot: string) => {
        await writeFile(
          join(skillRoot, "SKILL.md"),
          "---\nname: guarded-skill\ndescription: Changed at the source.\n---\n",
        );
      },
    },
    {
      defect: "hand-edited",
      mutate: async (skillRoot: string) => {
        await writeFile(join(skillRoot, "agents/openai.yaml"), "# hand edited\n");
      },
    },
  ])("fails --check, naming the skill, when a sidecar is $defect", async ({ mutate }) => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-codex-sidecar-check-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/example/.claude-plugin"), { recursive: true });
    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "red-skills",
      plugins: [{ name: "example", source: "./plugins/example", description: "Example." }],
    });
    await writeJson(join(root, "plugins/example/.claude-plugin/plugin.json"), {
      name: "example",
      version: "9.9.9",
      description: "Example.",
      skills: [],
    });
    const skillRoot = await writeSkill(root, "guarded-skill", "Original description.");
    await execFileAsync("node", [generator, "--root", root]);
    await mutate(skillRoot);

    await expect(execFileAsync("node", [generator, "--root", root, "--check"])).rejects.toMatchObject({
      stderr: expect.stringContaining("plugins/example/skills/core/guarded-skill/agents/openai.yaml"),
    });
  });

  it("keeps every live skill sidecar generated and runs its guard in every cone", async () => {
    await execFileAsync("node", [generator, "--root", ROOT, "--check"]);

    expect(REPO_INVARIANT_SUITES.map((suite) => suite.name)).toContain(
      "invariants:codex-skill-sidecars",
    );
  });
});
