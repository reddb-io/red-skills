import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, parse } from "node:path";
import yaml from "js-yaml";

const TOON_PACKAGE_NAME = "@reddb-io/toon";
const SEMVER = /^\d+\.\d+\.\d+$/;

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
    name: "red-setup.interview.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.interview.tq-install-url",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
  },
  {
    name: "red-setup.interview.installed-version",
    path: "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
    form: "version",
    pattern: /The installed version must be `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.reference.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.reference.host-binary-check",
    path: "plugins/dev/skills/engineering/red-setup/REFERENCE.md",
    form: "version",
    pattern: /pinned to `(\d+\.\d+\.\d+)`/,
  },
  {
    name: "red-setup.write-contract.host-binary-record",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "version",
    pattern: /host_binaries\.tq\.version: (\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.write-contract.tq-install-env",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-setup.write-contract.tq-install-url",
    path: "plugins/dev/skills/engineering/red-setup/WRITE-CONTRACT.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
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
    pattern: /host_binaries\.tq\.version` \(pin `(\d+\.\d+\.\d+)`\)/,
  },
  {
    name: "red-doctor.skill.remediation-env",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "tag",
    pattern: /TQ_VERSION=(v\d+\.\d+\.\d+)/,
  },
  {
    name: "red-doctor.skill.remediation-url",
    path: "plugins/dev/skills/engineering/red-doctor/SKILL.md",
    form: "tag",
    pattern: /raw\.githubusercontent\.com\/reddb-io\/toon\/(v\d+\.\d+\.\d+)\/install\.sh/,
  },
];

interface WorkspaceCatalog {
  readonly catalog?: Record<string, unknown>;
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
