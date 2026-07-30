// Builds the canary harness's sandboxes: a scratch repo whose `dist/` holds
// REAL esbuild bundles with the SHIPPED file names, so `fleet_create` launches
// a supervisor from `castle-mcp.bundle.min.mjs` and that supervisor resolves
// its slot entry to the `dev.bundle.min.mjs` sitting beside it — the exact
// resolution #2677 got wrong.
//
// Two variants of the dev bundle exist. `healthy` routes `run`; `unroutable`
// refuses it. Everything else about the two sandboxes is identical, so a
// difference in the canary's verdict can only come from the slot entry.
//
// A sandbox also decides whether a `redskilled` daemon answers on its session
// socket (#2794). `daemon: "up"` starts the REAL daemon binary on a session key
// pinned to this sandbox; `daemon: "down"` pins a session key nothing is
// listening on. The two differ in one fact — whether the socket answers — which
// is exactly the boundary the canary's `daemon_reach` step must see.

import { build } from "esbuild";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { sendRedskilledRequest } from "@reddb-io/redskilled/protocol";

const here = dirname(fileURLToPath(import.meta.url));

export type CanaryLaneVariant = "healthy" | "unroutable";

/** Whether a daemon answers on this sandbox's session socket. */
export type CanaryDaemonState = "up" | "down";

export interface CanarySandbox {
  /** Repo root the workers are created in. */
  readonly root: string;
  /** The MCP bundle entry the canary launches. */
  readonly mcpEntry: string;
  readonly env: Record<string, string>;
}

interface BuiltBundles {
  readonly dir: string;
  readonly mcp: string;
  readonly redskilled: string;
  readonly dev: Record<CanaryLaneVariant, string>;
}

let bundles: Promise<BuiltBundles> | undefined;
const sandboxes: string[] = [];
const daemonPids: number[] = [];
let sessions = 0;

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

/** Build the harness bundles once per test process. */
export function buildCanaryBundles(): Promise<BuiltBundles> {
  bundles ??= (async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-canary-bundles-"));
    sandboxes.push(dir);
    const mcp = join(dir, "castle-mcp.bundle.min.mjs");
    const redskilled = join(dir, "redskilled.bundle.mjs");
    const healthy = join(dir, "dev-healthy.bundle.min.mjs");
    const unroutable = join(dir, "dev-unroutable.bundle.min.mjs");
    await Promise.all([
      bundleOne("mcp-entry.ts", mcp),
      bundleOne("redskilled-entry.ts", redskilled),
      bundleOne("dev-entry-healthy.ts", healthy),
      bundleOne("dev-entry-unroutable.ts", unroutable),
    ]);
    return { dir, mcp, redskilled, dev: { healthy, unroutable } };
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
  daemon: CanaryDaemonState = "up",
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

  // A session key nothing else on the host shares, so "no daemon" is a fact
  // about this sandbox rather than about whatever the developer happens to be
  // running, and an `up` sandbox can never be served by a stranger's daemon.
  sessions += 1;
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The harness runs many times in CI; a transient cgroup scope per launch
    // is neither available nor relevant to what is under test (#2697).
    RED_AFK_FLEET_SCOPE: "off",
    RED_AFK_TARGET: "1",
    REDSKILLED_SESSION: `mcp-canary-${process.pid}-${sessions}`,
  };
  if (daemon === "up") await startCanaryDaemon(built.redskilled, env);

  return { root, mcpEntry, env };
}

/** Start the real daemon on this sandbox's session socket and wait for it to
 * answer. A daemon that never answers fails HERE, so a canary red can only ever
 * mean the lane failed to reach one that was there. */
async function startCanaryDaemon(entry: string, env: Record<string, string>): Promise<void> {
  const paths = resolveRedskilledPaths({ env });
  await mkdir(dirname(paths.socketPath), { recursive: true, mode: 0o700 });
  const child = spawn(
    process.execPath,
    [
      entry,
      "serve",
      "--socket", paths.socketPath,
      "--lease", paths.leasePath,
      "--events", paths.eventLanePath,
      "--session-key-hash", paths.sessionKeyHash,
      "--machine-id-hash", paths.machineIdHash,
      // Longer than any canary walk: an idle exit mid-probe would read as a
      // broken socket boundary when it is only a bored daemon.
      "--idle-ms", "600000",
    ],
    { detached: true, stdio: "ignore", env: { ...env, REDSKILLED_DAEMON: "1" } },
  );
  child.unref();
  if (child.pid !== undefined) daemonPids.push(child.pid);

  const deadline = Date.now() + 15_000;
  for (;;) {
    if (await pings(paths.socketPath)) return;
    if (Date.now() >= deadline) {
      throw new Error(`canary daemon never answered on ${paths.socketPath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function pings(socketPath: string): Promise<boolean> {
  try {
    const response = await sendRedskilledRequest(
      { socketPath, timeoutMs: 250 },
      { id: `canary-ping-${process.pid}`, op: "ping" },
    );
    return response.ok;
  } catch {
    return false;
  }
}

export async function cleanupCanarySandboxes(): Promise<void> {
  bundles = undefined;
  for (const pid of daemonPids.splice(0)) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone; a daemon that exited on its own needs no help.
    }
  }
  await Promise.all(
    sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
