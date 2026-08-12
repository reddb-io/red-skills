import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import yaml from "js-yaml";

const TOON_PACKAGE_NAME = "@reddb-io/toon";
const SEMVER = /^\d+\.\d+\.\d+$/;

/** pnpm rewrites this specifier from the catalog at install and publish time. */
const CATALOG_SPECIFIER = "catalog:";

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

export interface CatalogToonVersion {
  readonly packageName: typeof TOON_PACKAGE_NAME;
  readonly version: string;
  readonly tag: string;
}

export type ToonPinForm = "version" | "tag";

export interface ToonPinSite {
  readonly name: string;
  readonly path: string;
  readonly form: ToonPinForm;
  readonly pattern: RegExp;
}

export const TOON_PIN_SITES: readonly ToonPinSite[] = [
  {
    name: "red-doctor.runtime.host-toolchain-pin",
    path: "apps/dev/src/core/host-toolchain-doctor.ts",
    form: "version",
    pattern: /TQ_PINNED_VERSION = "(\d+\.\d+\.\d+)"/,
  },
  {
    name: "workflow.red-workspace-ci.tq-install-version",
    path: ".github/workflows/red-workspace-ci.yml",
    form: "tag",
    pattern: /TQ_VERSION:\s+(v\d+\.\d+\.\d+)/,
  },
  {
    name: "workflow.red-rsp-benchmark-ci.tq-install-version",
    path: ".github/workflows/red-rsp-benchmark-ci.yml",
    form: "tag",
    pattern: /TQ_VERSION:\s+(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.interview.tq-install-version",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "version",
    pattern: /cargo install reddb-io-tq --version (\d+\.\d+\.\d+) --locked --force/,
  },
  {
    name: "red-setup.interview.installed-version",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "version",
    pattern: /The installed version must be at least `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.reference.host-binary-install-floor",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "version",
    pattern: /install `tq` at or above `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.reference.host-binary-check",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "version",
    // The number is still derived from the catalog; only the words around it
    // changed when the check became a floor rather than an equality.
    pattern: /the `(\d+\.\d+\.\d+)` floor/,
  },
  {
    name: "red-setup.write-contract.host-binary-record",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /host_binaries\.tq\.version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.write-contract.tq-install-version",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /cargo install reddb-io-tq --version (\d+\.\d+\.\d+) --locked --force/,
  },
  {
    name: "red-setup.write-contract.verify-version",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /`tq --version` reports `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.write-contract.config-record",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /\n\s+version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.config-template.host-binary-record",
    path: "plugins/dev/skills/engineering/red-setup/config-template.yaml",
    form: "version",
    pattern: /\n\s+version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-doctor.skill.host-binary-pin",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "version",
    pattern: /host_binaries\.tq\.version` \(floor `(\d+\.\d+\.\d+)`\)/,
  },
  {
    name: "red-doctor.skill.remediation-version",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "version",
    pattern: /cargo install reddb-io-tq --version (\d+\.\d+\.\d+) --locked --force/,
  },
];

interface WorkspaceCatalog {
  readonly catalog?: Record<string, unknown>;
  readonly packages?: readonly string[];
}

export function findWorkspaceRoot(start = process.cwd()): string {
  let dir = start;
  while (true) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir || parse(dir).root === dir) {
      throw new Error(`could not find pnpm-workspace.yaml from ${start}`);
    }
    dir = parent;
  }
}

export function deriveToonVersionFromWorkspaceYaml(input: string): CatalogToonVersion {
  const doc = yaml.load(input) as WorkspaceCatalog | null;
  const version = doc?.catalog?.[TOON_PACKAGE_NAME];
  if (typeof version !== "string" || !SEMVER.test(version)) {
    throw new Error(`pnpm catalog entry ${TOON_PACKAGE_NAME} must be an x.y.z version`);
  }

  return {
    packageName: TOON_PACKAGE_NAME,
    version,
    tag: `v${version}`,
  };
}

export function readCatalogToonVersion(root = findWorkspaceRoot()): CatalogToonVersion {
  return deriveToonVersionFromWorkspaceYaml(readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"));
}

export async function readToonPinSite(root: string, site: ToonPinSite): Promise<string> {
  const text = await readFile(join(root, site.path), "utf8");
  const match = site.pattern.exec(text);
  if (!match?.[1]) {
    throw new Error(`toon pin site ${site.name} did not match ${site.path}`);
  }
  return match[1];
}

/**
 * Every workspace package defers its toon version to the catalog (ADR 0097: "No RedSkills surface
 * owns an independent `tq` or `@reddb-io/toon` version"). A literal specifier is drift even when it
 * looks current, because a caret range on a `0.x` line is minor-locked and silently stops tracking
 * the catalog the first time the catalog crosses a minor.
 */
export async function collectToonSpecifierDrift(root: string): Promise<string[]> {
  const failures: string[] = [];
  for (const dir of await workspacePackageDirs(root)) {
    const manifestPath = join(dir, "package.json");
    if (!existsSync(join(root, manifestPath))) continue;

    const manifest = JSON.parse(await readFile(join(root, manifestPath), "utf8")) as Record<string, unknown>;
    for (const field of DEPENDENCY_FIELDS) {
      const deps = manifest[field];
      if (typeof deps !== "object" || deps === null) continue;
      const specifier = (deps as Record<string, unknown>)[TOON_PACKAGE_NAME];
      if (specifier === undefined) continue;
      if (specifier !== CATALOG_SPECIFIER) {
        failures.push(`${manifestPath} (${field}): expected ${CATALOG_SPECIFIER}, found ${String(specifier)}`);
      }
    }
  }
  return failures.sort();
}

/** Resolves the single-level `apps/*`-style globs pnpm workspaces use here. */
async function workspacePackageDirs(root: string): Promise<string[]> {
  const doc = yaml.load(await readFile(join(root, "pnpm-workspace.yaml"), "utf8")) as WorkspaceCatalog | null;
  const dirs: string[] = [];
  for (const glob of doc?.packages ?? []) {
    if (!glob.endsWith("/*")) {
      dirs.push(glob);
      continue;
    }
    const parent = glob.slice(0, -2);
    const entries = await readdir(join(root, parent), { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isDirectory()) dirs.push(`${parent}/${entry.name}`);
    }
  }
  return dirs.sort();
}

export async function collectToonPinDrift(root: string, version: CatalogToonVersion): Promise<string[]> {
  const failures: string[] = [];
  for (const site of TOON_PIN_SITES) {
    const expected = site.form === "tag" ? version.tag : version.version;
    const actual = await readToonPinSite(root, site);
    if (actual !== expected) {
      failures.push(`${site.name}: expected ${expected}, found ${actual}`);
    }
  }
  return failures;
}
