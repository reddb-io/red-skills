import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const generator = join(ROOT, "scripts/build-gemini-extension.mjs");
const validator = join(ROOT, "scripts/validate-gemini-extension.mjs");
const installer = join(ROOT, "scripts/install.sh");
const temporaryRoots: string[] = [];

async function temporaryRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createPackageSet(root: string): Promise<void> {
  const pluginRoot = join(root, "plugins/dev");
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true });
  await mkdir(join(pluginRoot, "hooks"), { recursive: true });
  await mkdir(join(root, ".agents/plugins"), { recursive: true });
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });

  await writeJson(join(root, ".claude-plugin/marketplace.json"), { name: "fixture", plugins: [] });
  await writeJson(join(root, ".agents/plugins/marketplace.json"), { name: "fixture", plugins: [] });
  await writeJson(join(pluginRoot, ".claude-plugin/plugin.json"), {
    name: "dev",
    version: "9.9.9",
    description: "Development automation — local and complete.",
    skills: ["./skills/engineering/alpha", "./skills/misc/beta"],
  });
  await writeJson(join(pluginRoot, ".gemini-plugin/plugin.json"), {
    name: "dev",
    version: "9.9.9",
    hooks: "./hooks/gemini.hooks.json",
    mcpServers: "./.mcp.json",
    skills: ["./skills/engineering/"],
  });

  for (const [bucket, skill] of [
    ["engineering", "alpha"],
    ["misc", "beta"],
  ]) {
    const skillRoot = join(pluginRoot, "skills", bucket, skill);
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill} fixture\n---\n\n# ${skill}\n`,
    );
    await writeFile(join(skillRoot, "references/support.md"), `${skill} support\n`);
  }

  await writeFile(join(pluginRoot, "hooks/command-guard.sh"), "#!/bin/sh\nprintf '{}'");
  for (const bundle of [
    "code-nav-mcp.bundle.min.mjs",
    "redskilled-mcp.bundle.min.mjs",
    "rsp.bundle.min.mjs",
  ]) {
    await writeFile(join(root, "dist", bundle), `// ${bundle}\n`);
  }
  await writeFile(join(root, "scripts/build-gemini-extension.mjs"), await readFile(generator));
  await writeFile(join(root, "scripts/validate-gemini-extension.mjs"), await readFile(validator));
}

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = await stat(path);
      if (metadata.isDirectory()) await visit(path, relative);
      else entries.push(`${relative}\0${await readFile(path, "utf8")}`);
    }
  }
  await visit(root);
  return entries.join("\0");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Gemini dev extension projection", () => {
  it("reproduces the dangling generated-reference regression before projection", async () => {
    const root = await temporaryRoot("red-skills-gemini-dangling-");
    await createPackageSet(root);

    await expect(
      execFileAsync("node", [validator, "--extension", join(root, "plugins/dev")]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("gemini.hooks.json") });
  });

  it("generates a deterministic, self-contained native extension", async () => {
    const root = await temporaryRoot("red-skills-gemini-generate-");
    const output = join(root, "generated/dev");
    await createPackageSet(root);

    await execFileAsync("node", [generator, "--root", root, "--output", output]);
    await execFileAsync("node", [validator, "--extension", output]);

    const manifest = JSON.parse(await readFile(join(output, "gemini-extension.json"), "utf8"));
    expect(Object.keys(manifest).sort()).toEqual(["description", "mcpServers", "name", "version"]);
    expect(manifest).toMatchObject({
      name: "dev",
      version: "9.9.9",
      mcpServers: {
        redskilled: { args: ["${extensionPath}${/}dist${/}redskilled-mcp.bundle.min.mjs"] },
      },
    });
    // ADR 0147 §4 switched `navigator` and `rsp` off at the dev declaration, so
    // the extension projects exactly one server. `toMatchObject` above would
    // pass with either back, which is why the key set is pinned exactly and the
    // bundles they shipped are pinned absent from the extension entirely.
    expect(Object.keys(manifest.mcpServers)).toEqual(["redskilled"]);
    expect(await readdir(join(output, "dist"))).toEqual(["redskilled-mcp.bundle.min.mjs"]);
    expect(JSON.parse(await readFile(join(output, "hooks/hooks.json"), "utf8"))).toMatchObject({
      hooks: {
        BeforeTool: [
          {
            matcher: "run_shell_command",
            hooks: [
              {
                type: "command",
                command: "${extensionPath}${/}hooks${/}command-guard.sh",
              },
            ],
          },
        ],
      },
    });
    expect(await readFile(join(output, "skills/alpha/references/support.md"), "utf8")).toBe(
      "alpha support\n",
    );
    expect(await readFile(join(output, "skills/beta/references/support.md"), "utf8")).toBe(
      "beta support\n",
    );

    const first = await treeDigest(output);
    await execFileAsync("node", [generator, "--root", root, "--output", output]);
    expect(await treeDigest(output)).toBe(first);
  });

  it.each([
    ["hook", "hooks/command-guard.sh"],
    ["MCP", "dist/redskilled-mcp.bundle.min.mjs"],
    ["skill", "skills/alpha/SKILL.md"],
  ])("fails closed when a generated %s path disappears", async (_kind, missingPath) => {
    const root = await temporaryRoot("red-skills-gemini-invalid-");
    const output = join(root, "generated/dev");
    await createPackageSet(root);
    await execFileAsync("node", [generator, "--root", root, "--output", output]);
    await rm(join(output, missingPath));

    await expect(execFileAsync("node", [validator, "--extension", output])).rejects.toMatchObject({
      stderr: expect.stringContaining(missingPath),
    });
  });

  it("installs twice into a clean fake Gemini home without network access or drift", async () => {
    const root = await temporaryRoot("red-skills-gemini-install-");
    const source = join(root, "package-set");
    const fakeBin = join(root, "bin");
    const geminiHome = join(root, "gemini-home");
    await createPackageSet(source);
    await mkdir(fakeBin, { recursive: true });

    await writeFile(
      join(fakeBin, "gemini"),
      `#!/bin/sh\nset -eu\n` +
        `if [ "$1 $2" = "extensions uninstall" ]; then rm -rf "$GEMINI_HOME/extensions/$3"; exit 0; fi\n` +
        `if [ "$1 $2" = "extensions install" ]; then mkdir -p "$GEMINI_HOME/extensions"; cp -R "$3" "$GEMINI_HOME/extensions/dev"; exit 0; fi\n` +
        `exit 64\n`,
      { mode: 0o755 },
    );
    for (const command of ["npm", "npx", "curl", "gh", "git"]) {
      await writeFile(join(fakeBin, command), `#!/bin/sh\necho network-command:${command} >&2\nexit 97\n`, {
        mode: 0o755,
      });
    }

    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      GEMINI_HOME: geminiHome,
    };
    const args = [
      installer,
      "--source-dir",
      source,
      "--install-root",
      join(root, "install"),
      "--only",
      "gemini",
    ];
    await execFileAsync("bash", args, { env: environment });
    await execFileAsync("node", [validator, "--extension", join(geminiHome, "extensions/dev")]);
    const first = await treeDigest(join(geminiHome, "extensions/dev"));

    await execFileAsync("bash", args, { env: environment });
    expect(await treeDigest(join(geminiHome, "extensions/dev"))).toBe(first);
  });
});
