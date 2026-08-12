import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { parseCli } from "../src/cli.js";
import { toonBumpCommand } from "../src/commands/toon-bump.js";
import { collectToonPinDrift, TOON_PIN_SITES, type CatalogToonVersion } from "../src/core/toon-version.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const root = await mkdtemp(join(tmpdir(), "dev-toon-bump-"));
  roots.push(root);
  return root;
}

async function write(root: string, rel: string, body: string): Promise<void> {
  const path = join(root, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

async function read(root: string, rel: string): Promise<string> {
  return readFile(join(root, rel), "utf8");
}

async function writeFixture(root: string, version = "0.2.6"): Promise<void> {
  await write(
    root,
    "pnpm-workspace.yaml",
    `packages:
  - "apps/*"

catalog:
  "@reddb-io/toon": ${version}

minimumReleaseAgeExclude:
  - "@reddb-io/sdk"
  - '@reddb-io/toon@${version}'
`,
  );
  await write(
    root,
    "pnpm-lock.yaml",
    `lockfileVersion: '9.0'

catalogs:
  default:
    '@reddb-io/toon':
      specifier: ${version}
      version: ${version}

importers:
  apps/dev:
    dependencies:
      '@reddb-io/toon':
        specifier: 'catalog:'
        version: ${version}

packages:
  '@reddb-io/toon@${version}':
    resolution: {integrity: sha512-fixture}
    engines: {node: '>=18'}

snapshots:
  '@reddb-io/toon@${version}': {}
`,
  );
  await writeRegisteredSites(root, version);
}

async function writeRegisteredSites(root: string, version: string): Promise<void> {
  await write(
    root,
    "apps/dev/src/core/host-toolchain-doctor.ts",
    `export const TQ_PINNED_VERSION = "${version}";\n`,
  );
  await write(root, ".github/workflows/red-workspace-ci.yml", `env:\n  TQ_VERSION: v${version}\n`);
  await write(root, ".github/workflows/red-rsp-benchmark-ci.yml", `env:\n  TQ_VERSION: v${version}\n`);
  await write(
    root,
    "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    `cargo install reddb-io-tq --version ${version} --locked --force
The installed version must be at least \`${version}\`.
`,
  );
  await write(
    root,
    "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    `install \`tq\` at or above \`${version}\`
host binary is at or above the \`${version}\` floor.
`,
  );
  await write(
    root,
    "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    `host_binaries.tq.version: ${version}
cargo install reddb-io-tq --version ${version} --locked --force
\`tq --version\` reports \`${version}\`
host_binaries:
  tq:
    version: ${version}
`,
  );
  await write(
    root,
    "plugins/dev/skills/engineering/red-setup/config-template.yaml",
    `host_binaries:
  tq:
    version: ${version}
`,
  );
  await write(
    root,
    "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    `host_binaries.tq.version\` (floor \`${version}\`)
cargo install reddb-io-tq --version ${version} --locked --force
`,
  );
}

function target(version: string): CatalogToonVersion {
  return { packageName: "@reddb-io/toon", version, tag: `v${version}` };
}

describe("toon-bump dev command", () => {
  test("registers the runtime tq pin as a single-writer site", () => {
    expect(TOON_PIN_SITES).toContainEqual(expect.objectContaining({
      name: "red-doctor.runtime.host-toolchain-pin",
      path: "apps/dev/src/core/host-toolchain-doctor.ts",
      form: "version",
    }));
  });

  test("routes as a dedicated dev CLI verb", () => {
    expect(parseCli(["toon-bump", "0.3.0", "--root", "/repo", "--dry-run"])).toEqual({
      command: "toon-bump",
      args: ["0.3.0", "--root", "/repo", "--dry-run"],
    });
  });

  test("resolves the workspace root from a nested cwd, as the watcher invokes it", async () => {
    const root = await scratch();
    await writeFixture(root);
    await mkdir(join(root, "apps", "dev"), { recursive: true });
    const cwd = process.cwd();
    process.chdir(join(root, "apps", "dev"));

    try {
      // No --root: the watcher runs `pnpm -C apps/dev dev toon-bump`, which lands the cwd here.
      const code = await toonBumpCommand(["0.3.0"], {
        stdout: { write: () => true },
        stderr: { write: () => true },
      });

      expect(code).toBe(0);
      await expect(collectToonPinDrift(root, target("0.3.0"))).resolves.toEqual([]);
    } finally {
      process.chdir(cwd);
    }
  });

  test("bumps every S1 registered site and replaces stale lockfile entries", async () => {
    const root = await scratch();
    await writeFixture(root);
    let stdout = "";

    const code = await toonBumpCommand(["0.3.0", "--root", root], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("schema_version: red.dev.toon_bump.v1");
    await expect(collectToonPinDrift(root, target("0.3.0"))).resolves.toEqual([]);
    await expect(read(root, "pnpm-workspace.yaml")).resolves.toContain("'@reddb-io/toon@0.3.0'");
    const lockfile = await read(root, "pnpm-lock.yaml");
    expect(lockfile).toContain("specifier: 0.3.0");
    expect(lockfile).not.toContain("@reddb-io/toon@0.2.6");
    expect(lockfile).not.toMatch(/version: 0\.2\.6/);
  });

  test("drops the stale resolution instead of re-pointing its integrity at the new version", async () => {
    const root = await scratch();
    await writeFixture(root);

    const code = await toonBumpCommand(["0.3.0", "--root", root], {
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    const lockfile = await read(root, "pnpm-lock.yaml");
    // `sha512-fixture` is 0.2.6's tarball hash. Renaming the key onto 0.3.0 would claim the new
    // version resolves to the old bytes — an integrity `pnpm install` rejects and that a follow-up
    // `--lockfile-only` will not repair, because pnpm trusts an entry whose key already matches.
    expect(lockfile).not.toContain("sha512-fixture");
    expect(lockfile).not.toMatch(/'@reddb-io\/toon@0\.3\.0':\s*\n\s+resolution/);
    expect(lockfile).not.toContain("@reddb-io/toon@0.2.6");
  });

  test("dry-run prints the would-be plan without writing", async () => {
    const root = await scratch();
    await writeFixture(root);
    let stdout = "";

    const code = await toonBumpCommand(["0.3.0", "--root", root, "--dry-run"], {
      stdout: { write: (chunk: string) => { stdout += chunk; return true; } },
      stderr: { write: () => true },
    });

    expect(code).toBe(0);
    expect(stdout).toContain("mode: dry-run");
    expect(stdout).toContain(TOON_PIN_SITES[0]!.path);
    await expect(collectToonPinDrift(root, target("0.3.0"))).resolves.toHaveLength(TOON_PIN_SITES.length);
    await expect(read(root, "pnpm-lock.yaml")).resolves.toContain("@reddb-io/toon@0.2.6");
  });

  test("returns a distinct no-op code when already clean", async () => {
    const root = await scratch();
    await writeFixture(root, "0.3.0");

    const code = await toonBumpCommand(["0.3.0", "--root", root], {
      stdout: { write: () => true },
      stderr: { write: () => true },
    });

    expect(code).toBe(10);
  });
});
