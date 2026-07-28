// Builds the canary harness's sandboxes: a scratch repo whose `dist/` holds
// REAL esbuild bundles with the SHIPPED file names, so `fleet_create` launches
// a supervisor from `castle-mcp.bundle.min.mjs` and that supervisor resolves
// its slot entry to the `dev.bundle.min.mjs` sitting beside it — the exact
// resolution #2677 got wrong.
//
// Two variants of the dev bundle exist. `healthy` routes `run`; `unroutable`
// refuses it. Everything else about the two sandboxes is identical, so a
// difference in the canary's verdict can only come from the slot entry.

import { build } from "esbuild";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export type CanaryLaneVariant = "healthy" | "unroutable";

export interface CanarySandbox {
  /** Repo root the fleet is created in. */
  readonly root: string;
  /** The MCP bundle entry the canary launches. */
  readonly mcpEntry: string;
  readonly env: Record<string, string>;
}

interface BuiltBundles {
  readonly dir: string;
  readonly mcp: string;
  readonly dev: Record<CanaryLaneVariant, string>;
}

let bundles: Promise<BuiltBundles> | undefined;
const sandboxes: string[] = [];

async function bundleOne(entry: string, outfile: string): Promise<void> {
  await build({
    entryPoints: [join(here, entry)],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    logLevel: "silent",
    banner: {
      js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
  });
}

/** Build the three harness bundles once per test process. */
export function buildCanaryBundles(): Promise<BuiltBundles> {
  bundles ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-canary-bundles-"));
    sandboxes.push(dir);
    const mcp = join(dir, "castle-mcp.bundle.min.mjs");
    const healthy = join(dir, "dev-healthy.bundle.min.mjs");
    const unroutable = join(dir, "dev-unroutable.bundle.min.mjs");
    await Promise.all([
      bundleOne("mcp-entry.ts", mcp),
      bundleOne("dev-entry-healthy.ts", healthy),
      bundleOne("dev-entry-unroutable.ts", unroutable),
    ]);
    return { dir, mcp, dev: { healthy, unroutable } };
  })();
  return bundles;
}

/**
 * Materialise one scratch repo wired to `variant`'s slot entry. The dev bundle
 * always lands as `dev.bundle.min.mjs` beside the MCP bundle, because that
 * sibling relationship IS what the production entry resolver looks for.
 */
export async function createCanarySandbox(
  variant: CanaryLaneVariant,
): Promise<CanarySandbox> {
  const built = await buildCanaryBundles();
  const root = await mkdtemp(join(tmpdir(), `mcp-canary-${variant}-`));
  sandboxes.push(root);
  const dist = join(root, "dist");
  await mkdir(dist, { recursive: true });
  await mkdir(join(root, ".red"), { recursive: true });
  await writeFile(join(root, ".red", "config.yaml"), "plugins:\n  dev:\n    enabled: true\n", "utf8");
  const mcpEntry = join(dist, "castle-mcp.bundle.min.mjs");
  await copyFile(built.mcp, mcpEntry);
  await copyFile(built.dev[variant], join(dist, "dev.bundle.min.mjs"));

  return {
    root,
    mcpEntry,
    env: {
      ...(process.env as Record<string, string>),
      // The harness runs many times in CI; a transient cgroup scope per launch
      // is neither available nor relevant to what is under test (#2697).
      RED_AFK_FLEET_SCOPE: "off",
      RED_AFK_TARGET: "1",
    },
  };
}

export async function cleanupCanarySandboxes(): Promise<void> {
  bundles = undefined;
  await Promise.all(
    sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
