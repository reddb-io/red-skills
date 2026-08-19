import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const generator = join(ROOT, "scripts/generate-pi-manifests.mjs");

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Pi manifest generator", () => {
  it("projects a Claude-side plugin tree into per-plugin Pi packages with bucket paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-manifests-"));

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
      skills: ["./skills/core/init", "./skills/core/recall"],
    });

    await writeJson(join(root, "plugins/internal/.claude-plugin/plugin.json"), {
      name: "internal",
      version: "9.9.9",
      description: "Internal plugin — maintainer-only repository operations.",
      skills: ["./skills/core/bootstrap"],
    });

    await execFileAsync("node", [generator, "--root", root]);

    const devPackage = JSON.parse(await readFile(join(root, "plugins/dev/package.json"), "utf8"));
    expect(devPackage).toMatchObject({
      name: "@reddb-io/red-skills-dev",
      version: "9.9.9",
      private: true,
      license: "Apache-2.0",
      keywords: ["pi-package", "reddb-io", "red-skills"],
      pi: {
        skills: ["./skills/engineering/", "./skills/knowledge/"],
      },
    });

    const examplePackage = JSON.parse(
      await readFile(join(root, "plugins/example/package.json"), "utf8"),
    );
    // Dependencies propagate as `dep:<name>` keywords so pi users can search
    // for them, mirroring the Codex manifest convention.
    expect(examplePackage.keywords).toContain("dep:dev");

    const internalPackage = JSON.parse(
      await readFile(join(root, "plugins/internal/package.json"), "utf8"),
    );
    expect(internalPackage.pi.skills).toEqual(["./skills/core/"]);
  });

  it("fails --check when a committed Pi manifest drifts from the generator", async () => {
    const root = await mkdtemp(join(tmpdir(), "red-skills-pi-manifests-check-"));

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
    const manifestPath = join(root, "plugins/dev/package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.description = "hand edited";
    await writeJson(manifestPath, manifest);

    await expect(execFileAsync("node", [generator, "--root", root, "--check"])).rejects.toMatchObject(
      {
        stderr: expect.stringContaining("Pi manifests are stale"),
      },
    );
  });

  it("matches the generator output for the repo's committed plugin manifests", async () => {
    await execFileAsync("node", [generator, "--root", ROOT, "--check"]);
  });
});