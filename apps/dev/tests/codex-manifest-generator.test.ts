import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const generator = join(ROOT, "scripts/generate-codex-manifests.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Codex manifest generator", () => {
  it("projects a Claude-side plugin addition into Codex marketplace entries and plugin manifests", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-codex-manifests-"));

    await mkdir(join(root, ".claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/dev/.claude-plugin"), { recursive: true });
    await mkdir(join(root, "plugins/example/.claude-plugin"), { recursive: true });

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
});
