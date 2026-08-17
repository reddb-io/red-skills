import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..", "..", "..");
const installer = join(ROOT, "scripts/install.sh");
const hermesInstaller = join(ROOT, "scripts/install-hermes-skills.mjs");
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
  await mkdir(join(root, ".agents/plugins"), { recursive: true });
  await mkdir(join(root, ".claude-plugin"), { recursive: true });
  await mkdir(join(root, "scripts"), { recursive: true });

  await writeJson(join(root, ".claude-plugin/marketplace.json"), { name: "fixture", plugins: [] });
  await writeJson(join(root, ".agents/plugins/marketplace.json"), { name: "fixture", plugins: [] });
  await writeJson(join(pluginRoot, ".claude-plugin/plugin.json"), {
    name: "dev",
    version: "9.9.9",
    skills: ["./skills/engineering/alpha", "./skills/misc/beta"],
  });

  for (const [bucket, skill] of [
    ["engineering", "alpha"],
    ["misc", "beta"],
  ]) {
    const skillRoot = join(pluginRoot, "skills", bucket, skill);
    await mkdir(join(skillRoot, "references"), { recursive: true });
    await mkdir(join(skillRoot, "scripts"), { recursive: true });
    await writeFile(
      join(skillRoot, "SKILL.md"),
      `---\nname: ${skill}\ndescription: ${skill} fixture\n---\n\n# ${skill}\n`,
    );
    await writeFile(join(skillRoot, "references/support.md"), `${skill} support\n`);
    await writeFile(join(skillRoot, "scripts/helper.sh"), `#!/bin/sh\nprintf '${skill}\\n'\n`, { mode: 0o755 });
  }

  await writeFile(join(root, "scripts/install-hermes-skills.mjs"), await readFile(hermesInstaller), {
    mode: 0o755,
  });
}

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, prefix = ""): Promise<void> {
    for (const name of (await readdir(directory)).sort()) {
      const path = join(directory, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      const metadata = await stat(path);
      if (metadata.isDirectory()) await visit(path, relative);
      else entries.push(`${relative}\0${metadata.mode & 0o777}\0${await readFile(path, "utf8")}`);
    }
  }
  await visit(root);
  return entries.join("\0");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hermes dev skills local distribution", () => {
  it("installs, verifies, repeats, and uninstalls only its user-global owned state without network", async () => {
    const root = await temporaryRoot("red-skills-hermes-install-");
    const source = join(root, "package-set");
    const fakeBin = join(root, "bin");
    const hermesHome = join(root, "hermes-home");
    const installRoot = join(root, "install");
    const destination = join(hermesHome, "skills/redskills-dev");
    const ownedState = join(hermesHome, "redskills-dev-owned.txt");
    await createPackageSet(source);
    await mkdir(fakeBin, { recursive: true });

    for (const command of ["hermes", "npm", "npx", "curl", "gh", "git"]) {
      await writeFile(join(fakeBin, command), `#!/bin/sh\necho forbidden-command:${command} >&2\nexit 97\n`, {
        mode: 0o755,
      });
    }

    const environment = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      HERMES_HOME: hermesHome,
    };
    const args = [
      installer,
      "--source-dir",
      source,
      "--install-root",
      installRoot,
      "--only",
      "hermes",
    ];

    const firstInstall = await execFileAsync("bash", args, { env: environment });
    expect(firstInstall.stdout).toContain("Hermes readiness: skills=healthy");
    expect(firstInstall.stdout).toContain("Hermes limitation: hooks=unsupported");
    expect(firstInstall.stdout).toContain("Hermes limitation: mcp=unsupported");
    expect(firstInstall.stdout).toContain("Hermes limitation: agents=unsupported");
    expect(await readFile(join(destination, "alpha/references/support.md"), "utf8")).toBe("alpha support\n");
    expect(await readFile(join(destination, "beta/scripts/helper.sh"), "utf8")).toContain("beta");
    expect((await stat(join(destination, "beta/scripts/helper.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(ownedState, "utf8")).toBe(
      "redskills-hermes-owned-v1\nskills/redskills-dev\n",
    );
    expect(await readFile(join(destination, "CAPABILITIES.md"), "utf8")).toContain(
      "Skills | healthy",
    );

    const firstDigest = await treeDigest(hermesHome);
    const secondInstall = await execFileAsync("bash", args, { env: environment });
    expect(secondInstall.stdout).toContain("Hermes readiness: skills=healthy");
    expect(await treeDigest(hermesHome)).toBe(firstDigest);

    const personalSkill = join(hermesHome, "skills/personal/keep/SKILL.md");
    const config = join(hermesHome, "config.yaml");
    await mkdir(join(personalSkill, ".."), { recursive: true });
    await writeFile(personalSkill, "# Keep\n");
    await writeFile(config, "model:\n  default: keep\n");

    await execFileAsync("bash", [...args, "--uninstall"], { env: environment });
    await expect(stat(destination)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(ownedState)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(personalSkill, "utf8")).toBe("# Keep\n");
    expect(await readFile(config, "utf8")).toBe("model:\n  default: keep\n");
  });
});
