import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, parse } from "node:path";

const require = createRequire(import.meta.url);
const yaml = require("js-yaml") as { load(input: string): unknown };

const TOON_PACKAGE_NAME = "@reddb-io/toon";
const SEMVER = /^\d+\.\d+\.\d+$/;

export interface CatalogToonVersion {
  readonly packageName: typeof TOON_PACKAGE_NAME;
  readonly version: string;
  readonly tag: string;
}

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
