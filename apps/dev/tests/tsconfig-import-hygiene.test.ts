import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");
const BASE_CONFIG = join(ROOT, "tsconfig.base.json");
const OPTED_OUT_CONFIGS = [
  "apps/benchmark-memory/tsconfig.json",
  "apps/brain/tsconfig.json",
  "apps/dev/tsconfig.json",
  "apps/memory/tsconfig.json",
  "apps/rsp/tsconfig.json",
];

type TsConfig = {
  extends?: string;
  compilerOptions?: {
    noUnusedLocals?: boolean;
  };
};

async function listTsConfigs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const paths = await Promise.all(
    entries
      .filter((entry) => entry.name !== "node_modules" && entry.name !== "dist")
      .map(async (entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return listTsConfigs(path);
        return entry.isFile() && /^tsconfig(?:\..+)?\.json$/.test(entry.name) ? [path] : [];
      }),
  );
  return paths.flat().sort();
}

async function readTsConfig(path: string): Promise<TsConfig> {
  return JSON.parse(await readFile(path, "utf8")) as TsConfig;
}

async function resolvesToSharedBase(path: string): Promise<boolean> {
  if (path === BASE_CONFIG) return true;
  const config = await readTsConfig(path);
  if (!config.extends) return false;
  return resolvesToSharedBase(resolve(dirname(path), config.extends));
}

describe("workspace TypeScript import hygiene", () => {
  it("enables noUnusedLocals from one shared base with a bounded package opt-out list", async () => {
    const base = await readTsConfig(BASE_CONFIG);
    expect(base.compilerOptions?.noUnusedLocals).toBe(true);

    const configs = (
      await Promise.all([listTsConfigs(join(ROOT, "apps")), listTsConfigs(join(ROOT, "packages"))])
    ).flat();

    for (const path of configs) {
      expect(await resolvesToSharedBase(path), relative(ROOT, path)).toBe(true);
    }

    const optedOut = (
      await Promise.all(
        configs.map(async (path) => ({
          path: relative(ROOT, path),
          disabled: (await readTsConfig(path)).compilerOptions?.noUnusedLocals === false,
        })),
      )
    )
      .filter(({ disabled }) => disabled)
      .map(({ path }) => path)
      .sort();

    expect(optedOut).toEqual(OPTED_OUT_CONFIGS);
  });
});
