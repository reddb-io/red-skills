// Builds the canary harness's sandboxes: a scratch repo whose `dist/` holds
// REAL esbuild bundles with the SHIPPED file names, so `fleet_create` launches
// a supervisor from `redskilled-mcp.bundle.min.mjs` and that supervisor resolves
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
//
// That daemon lives in a runtime directory the SANDBOX owns (#2884). The session
// key alone made the socket unique but left it under the operator's real
// `XDG_RUNTIME_DIR`, so a day of canary runs deposited a thousand dead sessions
// in the directory the singleton's own arbitration reads from — litter
// indistinguishable from the one-daemon-per-project failure ADR 0130 exists to
// prevent. The sandbox therefore pins `XDG_RUNTIME_DIR` too: every process in
// the lane derives the same runtime dir, and it is a temp dir cleanup removes.
// Its HOME is pinned for the same reason: the durable event and death lanes and
// stable bundles belong below the sandbox's `~/.red/redskilled`, never below the
// operator's real home.

import { build } from "esbuild";
import { execFileSync, spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { terminatePid } from "@reddb-io/shared/resident-core.js";
import { resolveRedskilledPaths } from "@reddb-io/redskilled/paths";
import { stopRedskilledDaemon } from "@reddb-io/redskilled/client";
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
  /** The runtime root this sandbox owns — every socket, lease and lane is under it. */
  readonly runtimeRoot: string;
  readonly env: Record<string, string>;
  /** How many queries this sandbox's tracker answered; 0 when it has none. */
  trackerRequests(): number;
}

/**
 * The tracker this sandbox's daemon polls — a local HTTP endpoint, not a mock
 * inside the daemon.
 *
 * The transport under test is the shipped one, built from a token and pointed at
 * an endpoint, so the only thing standing in for GitHub is GitHub: the daemon
 * really issues its conditional REST list over a socket and really parses an
 * answer. The tracker returns an ETag and then 304 so the repeated-poll path must
 * retain the original queue depth rather than turning "unchanged" into empty.
 */
interface CanaryTracker {
  readonly endpoint: string;
  readonly requests: () => number;
  readonly close: () => Promise<void>;
}

/** How many items the stub tracker says every selector matches. One is enough to
 * justify exactly one Worker against a target of one. */
const CANARY_QUEUE_DEPTH = 1;

async function startCanaryTracker(): Promise<CanaryTracker> {
  let requests = 0;
  const queueEtag = '"canary-queue-v1"';
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    request.on("end", () => {
      requests += 1;
      const url = new URL(request.url ?? "/", "http://canary.invalid");
      if (request.method === "GET" && url.pathname === "/repos/acme/canary/issues") {
        if (request.headers["if-none-match"] === queueEtag) {
          response.writeHead(304, { etag: queueEtag });
          response.end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json", etag: queueEtag });
        response.end(JSON.stringify([{ number: 1 }]));
        return;
      }
      // One `issueCount` per alias the query asked for, answered from the query
      // itself: a stub that invented its own aliases would answer a question the
      // daemon never asked, and the parser would read every project as unreachable.
      const data: Record<string, unknown> = {
        rateLimit: { remaining: 5_000, resetAt: "2099-01-01T00:00:00Z" },
      };
      for (const [, alias] of body.matchAll(/\b(q\d+):\s*search\(/g)) {
        data[alias!] = { issueCount: CANARY_QUEUE_DEPTH };
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    endpoint: `http://127.0.0.1:${port}/graphql`,
    requests: () => requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
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
const daemonPaths: ReturnType<typeof resolveRedskilledPaths>[] = [];
const trackers: CanaryTracker[] = [];
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
    const mcp = join(dir, "redskilled-mcp.bundle.min.mjs");
    const redskilled = join(dir, "redskilled.bundle.min.mjs");
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
  // A real checkout with a real `origin`, because a registration names the
  // TRACKER its queue lives in (#2974): the query the daemon polls with is built
  // from this remote, so a sandbox without one is a project the host could never
  // count — which is exactly the failure the canary exists to catch, not one it
  // should stage. The origin is a LOCAL repo whose path ends in `acme/canary`,
  // so the slug parser still reads the project as `acme/canary` while the
  // daemon-owned trunk refresh (ADR 0138) has a `main` it can actually fetch —
  // a URL-shaped fake remote would refuse every birth as unreachable trunk.
  const upstreamRoot = await mkdtemp(join(tmpdir(), "mcp-canary-upstream-"));
  sandboxes.push(upstreamRoot);
  const upstream = join(upstreamRoot, "acme", "canary");
  await mkdir(upstream, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: upstream, stdio: "ignore" });
  execFileSync(
    "git",
    ["-c", "user.email=canary@acme.test", "-c", "user.name=canary", "commit", "-q", "--allow-empty", "-m", "seed"],
    { cwd: upstream, stdio: "ignore" },
  );
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", upstream], {
    cwd: root,
    stdio: "ignore",
  });
  const mcpEntry = join(dist, "redskilled-mcp.bundle.min.mjs");
  await copyFile(built.mcp, mcpEntry);
  const daemonSibling = join(dist, "redskilled.bundle.min.mjs");
  await copyFile(built.redskilled, daemonSibling);
  await copyFile(built.dev[variant], join(dist, "dev.bundle.min.mjs"));

  // A session key nothing else on the host shares, so "no daemon" is a fact
  // about this sandbox rather than about whatever the developer happens to be
  // running, and an `up` sandbox can never be served by a stranger's daemon.
  sessions += 1;
  // And a runtime root this sandbox owns, so that uniqueness lands in a
  // directory cleanup can take back rather than in the operator's live one.
  const runtimeRoot = await mkdtemp(join(tmpdir(), "mcp-canary-run-"));
  sandboxes.push(runtimeRoot);
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // The harness runs many times in CI; a transient cgroup scope per launch
    // is neither available nor relevant to what is under test (#2697).
    RED_AFK_FLEET_SCOPE: "off",
    RED_AFK_TARGET: "1",
    REDSKILLED_SESSION: `mcp-canary-${process.pid}-${sessions}`,
    // Every process in the lane derives its runtime dir from this one variable,
    // so pinning it here is what makes the isolation reach the daemon the MCP
    // bundle spawns rather than only the one this file starts. It also takes
    // systemd user-session placement out of the picture, which is the same
    // opt-out the scope line above already declares.
    XDG_RUNTIME_DIR: runtimeRoot,
    // The same isolation one level up: the sandbox poses as its own MACHINE, so
    // the machine-wide claim (ADR 0130 Amendment 3) that refuses a second daemon
    // on a real host cannot refuse the harness against the developer's own.
    REDSKILLED_MACHINE_DIR: join(root, "machine"),
    // Durable daemon state is independently home-scoped. A unique socket and
    // machine claim do not stop births and deaths crossing into the operator's
    // real lane unless the whole child-process family shares this scratch HOME.
    HOME: join(root, "home"),
  };

  // Loud, not hopeful: `runtimeSocketDir` silently falls back to `tmpdir()` when
  // the derived socket path would exceed `sun_path`, and a silent fallback is
  // exactly how this litter reached the operator's directory in the first place.
  const derived = resolveRedskilledPaths({ env }).runtimeDir;
  if (!derived.startsWith(`${runtimeRoot}/`)) {
    throw new Error(
      `canary sandbox runtime dir escaped its own root: ${derived} is not under ${runtimeRoot}`,
    );
  }

  // The tracker exists either way: a `down` sandbox must differ from an `up` one
  // in exactly one fact — whether the socket answers — and nothing else.
  const tracker = await startCanaryTracker();
  trackers.push(tracker);
  env.REDSKILLED_HOST_TOKEN = "canary-token";
  env.GITHUB_GRAPHQL_URL = tracker.endpoint;
  // The isolation pin points REDSKILLED_BIN at a named non-path so no operator
  // bundle can answer for the sandbox. The DOWN walk wants exactly that cold
  // start, so there — and only there — the pin is re-aimed at the sandbox's own
  // daemon, as an executable shim because the env override is spawned directly
  // as a command (#3652). The UP walk keeps the poison pin: its daemon is
  // already running, and a spawnable override would hand every transient socket
  // hiccup a second competing daemon.
  if (daemon === "down") {
    const daemonBin = join(dist, "redskilled-bin");
    await writeFile(daemonBin, `#!/bin/sh\nexec "${process.execPath}" "${daemonSibling}" "$@"\n`, {
      mode: 0o755,
    });
    env.REDSKILLED_BIN = daemonBin;
  }

  daemonPaths.push(resolveRedskilledPaths({ env }));

  if (daemon === "up") await startCanaryDaemon(built.redskilled, env, tracker);

  return { root, mcpEntry, runtimeRoot, env, trackerRequests: tracker.requests };
}

/** Start the real daemon on this sandbox's session socket and wait for it to
 * answer. A daemon that never answers fails HERE, so a canary red can only ever
 * mean the lane failed to reach one that was there. */
async function startCanaryDaemon(
  entry: string,
  env: Record<string, string>,
  tracker: CanaryTracker,
): Promise<void> {
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
      // The lane's own cadence, compressed. The production windows are fifteen
      // seconds apiece and a probe that waited two of them would time out on a
      // healthy host; what is under test is that the loop RUNS, not how slowly.
      "--queue-endpoint", tracker.endpoint,
      "--queue-ms", "300",
      "--demand-ms", "300",
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

/**
 * Take back everything a run created: the daemons, the scratch repos, and the
 * runtime roots those daemons wrote into.
 *
 * The daemons go FIRST and are waited on, because a daemon still alive when its
 * directory is removed writes the lease back and leaves the very corpse this
 * cleanup exists to prevent. Callers run it from `afterAll`, so a walk that
 * fails mid-way is cleaned up on exactly the same path as one that passes.
 */
export async function cleanupCanarySandboxes(): Promise<void> {
  bundles = undefined;
  await Promise.all(
    daemonPaths.splice(0).map((paths) =>
      stopRedskilledDaemon(paths, { settleTimeoutMs: 2_000 }).catch(() => undefined),
    ),
  );
  await Promise.all(daemonPids.splice(0).map((pid) => terminatePid(pid, 2_000)));
  // After the daemons: a tracker closed while one still polls it would answer a
  // live poller with a connection error, which is a fact about this cleanup
  // rather than about the lane.
  await Promise.all(trackers.splice(0).map((tracker) => tracker.close()));
  await Promise.all(
    sandboxes.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
}
