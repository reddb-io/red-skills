// A daemon on a superseded bundle replaces itself with the published one, and
// the Workers do not notice.
//
// Nothing in the daemon used to resolve the published version or replace itself,
// so a release left the host-scoped singleton serving old code indefinitely —
// the failure that killed 21 Workers in 20 minutes one layer up (#2808), with a
// wider blast radius here because every project on the machine shares this one
// process. These checks pin the four facts that make the upgrade safe:
//
//   1. the DECISION is honest — a local build, an unresolved answer and an older
//      published version all hold, and only a newer one replaces;
//   2. the successor runs EXACTLY the published version, or the attempt refuses
//      loudly rather than landing on whatever is newest locally;
//   3. the swap is a RESTART, not an evacuation: the live Worker survives it and
//      the new process re-adopts it;
//   4. the daemon never reports a version it is not running — the published
//      answer travels beside the running one, never inside it.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState } from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import {
  isLocalRedskilledBuild,
  planRedskilledReplacement,
  REDSKILLED_REPLACE_EXIT_CODE,
  RedskilledReplacementEntryError,
  requireRedskilledReplacementEntry,
} from "../src/self-replace.js";

const require_ = createRequire(import.meta.url);
const tsxLoader = require_.resolve("tsx");
const cliEntry = resolve(__dirname, "..", "src", "cli.ts");

const RUNNING_VERSION = "1.4.0";
const PUBLISHED_VERSION = "1.5.0";

const running: RedskilledDaemon[] = [];
const children: ChildProcess[] = [];
const roots: string[] = [];
const started: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const socketPath of started.splice(0)) {
    await sendRedskilledRequest({ socketPath }, { id: `shutdown-${socketPath.length}`, op: "shutdown" }).catch(
      () => undefined,
    );
  }
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

interface Session {
  readonly paths: RedskilledPaths;
  /** A bundle cache holding exactly one published version. */
  readonly cacheDir: string;
  readonly publishedBundle: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * A session whose cache holds the published bundle, faked rather than built.
 *
 * The fixture re-execs the real CLI and states `--daemon-version` from the
 * version baked HERE, which is what lets the successor's own answer prove whose
 * code is serving.
 */
async function session(): Promise<Session> {
  const root = await scratch("redskilled-replace-");
  const cacheDir = join(root, "cache");
  await mkdir(cacheDir, { recursive: true });
  const publishedBundle = join(cacheDir, `redskilled-${PUBLISHED_VERSION}.bundle.min.mjs`);
  await writeFile(
    publishedBundle,
    `import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["--import", ${JSON.stringify(tsxLoader)}, ${JSON.stringify(cliEntry)}, ...process.argv.slice(2), "--daemon-version", ${JSON.stringify(PUBLISHED_VERSION)}], { stdio: "ignore" });
child.on("exit", (code) => process.exit(code ?? 0));
`,
    { mode: 0o755 },
  );
  return {
    paths: resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root }),
    cacheDir,
    publishedBundle,
    env: { ...process.env, RED_SKILLS_CACHE_DIR: cacheDir },
  };
}

/** A Worker process the test owns outright, so its liveness is a pid and nothing else. */
function longLivedWorker(workerId: string): RedskilledWorkerView {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000);"], { stdio: "ignore" });
  children.push(child);
  return {
    worker_id: workerId,
    project_label: "acme/widgets",
    pid: child.pid!,
    started_at: "2026-07-30T00:00:00.000Z",
    workspace_path: "/tmp/workspace",
    // Unisolated on purpose: the successor's default probe then asks the pid,
    // which answers identically on a host with no systemd user session.
    isolated: false,
    budget: { memory_high: "512M" },
    warnings: [],
  };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(condition: () => Promise<boolean>, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("the replacement decision", () => {
  it("replaces only for a newer published version, and names why when it holds", () => {
    const base = { running: RUNNING_VERSION, supervised: false } as const;

    expect(planRedskilledReplacement({ ...base, published: PUBLISHED_VERSION })).toEqual({
      act: "replace",
      to: PUBLISHED_VERSION,
      via: "self-spawn",
    });
    // A supervisor is standing by, so the handover is an exit it will revive.
    expect(planRedskilledReplacement({ ...base, published: PUBLISHED_VERSION, supervised: true })).toEqual({
      act: "replace",
      to: PUBLISHED_VERSION,
      via: "supervisor-exit",
    });
    expect(planRedskilledReplacement({ ...base, published: RUNNING_VERSION })).toEqual({
      act: "hold",
      reason: "no-newer-version",
    });
    expect(planRedskilledReplacement({ ...base, published: "1.3.9" })).toEqual({
      act: "hold",
      reason: "no-newer-version",
    });
    // Unknown stays unknown: substituting the running version is what makes a
    // stale daemon look current.
    expect(planRedskilledReplacement({ ...base, published: null })).toEqual({
      act: "hold",
      reason: "published-unknown",
    });
    // A source checkout is not a point on the published lane; taking a
    // developer's own daemon away mid-session is never an upgrade.
    expect(planRedskilledReplacement({ running: "0.0.0-dev", published: "9.9.9", supervised: false })).toEqual({
      act: "hold",
      reason: "local-build",
    });
    expect(isLocalRedskilledBuild("2.0.0-rc.1")).toBe(true);
    expect(isLocalRedskilledBuild("2.0.0")).toBe(false);
  });
});

describe("the successor entry", () => {
  it("runs the published version itself, never merely the newest bundle on the host", async () => {
    const { cacheDir, publishedBundle, env } = await session();
    await writeFile(join(cacheDir, "redskilled-9.9.9.bundle.min.mjs"), "", { mode: 0o755 });

    const entry = requireRedskilledReplacementEntry(PUBLISHED_VERSION, { env });

    expect(entry.args).toEqual([publishedBundle]);
    expect(entry.version).toBe(PUBLISHED_VERSION);
    expect(entry.source).toBe("bundle-cache");
  });

  it("falls back to a version-pinned dispatch, and refuses loudly when that is off", async () => {
    const { env } = await session();
    const missing = { ...env, RED_SKILLS_NPX: "npx" };

    const dispatch = requireRedskilledReplacementEntry("2.7.0", { env: missing, callerEntry: "" });
    expect(dispatch.source).toBe("pinned-dispatch");
    expect(dispatch.args).toEqual(["-y", "-p", "@reddb-io/red-skills@2.7.0", "red-skills-redskilled"]);

    const error = (() => {
      try {
        requireRedskilledReplacementEntry("2.7.0", {
          env: { ...missing, RED_SKILLS_NO_PINNED_DISPATCH: "1" },
          callerEntry: "",
        });
        return null;
      } catch (err) {
        return err;
      }
    })();
    expect(error).toBeInstanceOf(RedskilledReplacementEntryError);
    expect((error as RedskilledReplacementEntryError).code).toBe("redskilled-replacement-entry-unresolved");
    expect((error as RedskilledReplacementEntryError).searched.join("\n")).toContain(
      "redskilled-2.7.0.bundle.min.mjs",
    );
  });
});

describe("a daemon that has observed a newer published version", () => {
  it("keeps reporting the version it is RUNNING while the replacement is pending", async () => {
    const { paths, env } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env },
    });
    running.push(daemon);

    const decision = await daemon.observePublishedVersion();
    expect(decision).toMatchObject({ act: "replace", to: PUBLISHED_VERSION });

    const state = daemon.hostState();
    // The one fact this whole module exists to protect.
    expect(state.daemon_version).toBe(RUNNING_VERSION);
    expect(state.upgrade.running_version).toBe(RUNNING_VERSION);
    expect(state.upgrade.published_version).toBe(PUBLISHED_VERSION);
    expect(state.upgrade.newer_published).toBe(1);
    expect(state.upgrade.published_unknown).toBe(0);
    expect(state.upgrade.replacement).toBe("pending");
    expect(state.upgrade.checked_at).not.toBeNull();
  });

  it("reports an unresolvable published answer as unknown, never as a match", async () => {
    const { paths, env } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => {
        throw new Error("the registry is unreachable");
      },
      replacementIO: { env },
    });
    running.push(daemon);

    expect(await daemon.observePublishedVersion()).toEqual({ act: "hold", reason: "published-unknown" });
    const upgrade = daemon.hostState().upgrade;
    expect(upgrade.published_version).toBeNull();
    expect(upgrade.published_unknown).toBe(1);
    expect(upgrade.newer_published).toBe(0);
    expect(upgrade.replacement).toBe("none");
    expect(upgrade.running_version).toBe(RUNNING_VERSION);
  });

  it("keeps serving when the published bundle exists on no reachable path", async () => {
    const { paths } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => "3.0.0",
      // No cache, no dispatch: the successor cannot be found at all.
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty"), RED_SKILLS_NO_PINNED_DISPATCH: "1" } },
    });
    running.push(daemon);

    await expect(daemon.checkForReplacement()).rejects.toBeInstanceOf(RedskilledReplacementEntryError);
    // The upgrade was lost; the machine was not. The daemon still answers, and
    // still answers as the version it runs.
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(daemon.hostState().daemon_version).toBe(RUNNING_VERSION);
  });

  it("hands over by exiting when a supervisor will revive it", async () => {
    const { paths, env } = await session();
    const exits: number[] = [];
    const spawns: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      supervised: true,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: (code) => exits.push(code), spawnSuccessor: (entry) => spawns.push(entry.command) },
    });
    running.push(daemon);

    expect(await daemon.checkForReplacement()).toMatchObject({ act: "replace", via: "supervisor-exit" });

    // Nothing is started here: the unit's `Restart=on-failure` starts the new
    // process, which is why the exit is non-zero.
    expect(spawns).toEqual([]);
    expect(exits).toEqual([REDSKILLED_REPLACE_EXIT_CODE]);
    // And it let go first: the socket is free for the successor to bind.
    expect(await socketAnswers(paths.socketPath)).toBe(false);
  });
});

describe("an unsupervised daemon replaces itself", () => {
  it("comes back at the new version, with its live Worker still running and re-adopted", async () => {
    const { paths, env } = await session();
    const worker = longLivedWorker("w-survivor");

    const first = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      liveness: (view) => alive(view.pid),
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env },
    });
    running.push(first);
    first.trackWorker(worker);
    await first.flushEvents();
    const firstPid = first.hostState().pid;
    started.push(paths.socketPath);

    expect(await first.checkForReplacement()).toMatchObject({ act: "replace", to: PUBLISHED_VERSION });

    // The successor takes the session over — a restart, not an evacuation.
    expect(await until(() => socketAnswers(paths.socketPath))).toBe(true);
    const state = await readRedskilledHostState(paths, { readyTimeoutMs: 30_000 });

    expect(state.daemon_version).toBe(PUBLISHED_VERSION);
    expect(state.upgrade.running_version).toBe(PUBLISHED_VERSION);
    expect(state.pid).not.toBe(firstPid);
    // The Worker never noticed: same process, adopted by the new daemon.
    expect(alive(worker.pid)).toBe(true);
    expect(state.workers.map((view) => view.worker_id)).toEqual(["w-survivor"]);
    expect(state.workers[0]!.pid).toBe(worker.pid);
    expect(state.workers[0]!.project_label).toBe("acme/widgets");
  }, 90_000);

  it("hands over a Worker set the lane carries, not one the old process held in memory", async () => {
    // The successor is a different process: everything it re-adopts came off the
    // append-only lane, which is why the handover survives a crash as well as a
    // planned replacement.
    const { paths } = await session();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    const worker = longLivedWorker("w-lane");
    await lane.record({ event: "worker-birth", worker, ts: "2026-07-30T00:00:00.000Z" });

    const daemon = await startRedskilledDaemon({
      paths,
      idleMs: 60_000,
      replaceCheckMs: 0,
      daemonVersion: PUBLISHED_VERSION,
      liveness: (view) => alive(view.pid),
    });
    running.push(daemon);

    expect(daemon.reattached().map((view) => view.worker_id)).toEqual(["w-lane"]);
    expect(daemon.hostState().budget_accounting.worker_count).toBe(1);
  });
});
