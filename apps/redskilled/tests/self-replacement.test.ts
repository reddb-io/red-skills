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
//      answer travels beside the running one, never inside it;
//   5. the check is REACHABLE at all — the daemon is always on (ADR 0150 §4), so
//      there is no idle boundary left to ask at and the boot look and the
//      interval are the WHOLE upgrade path, both of which must fire and be seen
//      to have fired (#2975);
//   6. the daemon SAYS which happened — `checks` beside `hold_reason`, so "the
//      timer never fired" is never again investigated as "it fired and held".
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState } from "../src/client.js";
import { socketAnswers, startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { createRedskilledEventLane } from "../src/event-lane.js";
import type { RedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { sendRedskilledRequest } from "../src/protocol.js";
import {
  DEFAULT_REDSKILLED_REPLACE_CHECK_MS,
  isLocalRedskilledBuild,
  localRedskilledPublishedEvidence,
  planRedskilledMajorHold,
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
  for (const child of children.splice(0)) {
    child.kill("SIGKILL");
    // A signal is a request, not an exit. Removing the tree while the process is
    // still between two writes is how this suite intermittently died on
    // `ENOTEMPTY ... /state/deaths` — the directory the daemon was writing into
    // as the directory came out from under it.
    if (child.exitCode == null && child.signalCode == null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }
  }
  for (const root of roots.splice(0)) await removeWhenQuiet(root);
});

/**
 * Remove a session tree, retrying while something is still writing into it.
 *
 * The awaits above cover every process this file spawned — but not the SUCCESSOR,
 * which by design is spawned by the daemon under test and whose handle this suite
 * therefore never holds. It is asked to shut down over its socket, and a shutdown
 * answered is not a process exited, so its last writes can still land after the
 * teardown believes the host is quiet. Retrying is what can be done about a child
 * that is not ours; failing loudly at the end is what keeps a genuinely stuck
 * process from passing as a tidy one.
 */
async function removeWhenQuiet(root: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      if (attempt >= 40) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

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
    // HOME is scoped to the fixture: entry stabilization files bundles under
    // the env's home, and a test env reaching the REAL ~/.red/redskilled/
    // would poison the operator's stable-bundle directory with fake versions.
    env: {
      ...process.env,
      HOME: root,
      XDG_RUNTIME_DIR: root,
      REDSKILLED_SESSION: `test:${root}`,
      REDSKILLED_MACHINE_DIR: root,
      RED_SKILLS_CACHE_DIR: cacheDir,
    },
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

/**
 * #4047: an incumbent that has handed over now LEAVES, so every in-process
 * daemon in this file needs somewhere for that exit to go. Recording it keeps
 * the departure assertable instead of tearing the test runner down.
 */
const exitCodes: number[] = [];
const recordExit = (code: number): void => void exitCodes.push(code);

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

describe("a published major the daemon will not adopt", () => {
  it("names the gap, says the refusal is deliberate, and names the manual step", () => {
    const hold = planRedskilledMajorHold({ running: RUNNING_VERSION, newest: "2.0.0", supervised: false });

    expect(hold).not.toBeNull();
    expect(hold?.version).toBe("2.0.0");
    expect(hold?.running_major).toBe(1);
    expect(hold?.held_major).toBe(2);
    // A refusal that is stated is a decision; one that is silent is a bug.
    expect(hold?.reason).toContain("deliberately");
    expect(hold?.reason).toContain("2.0.0");
    expect(hold?.action).not.toBe("");
  });

  it("names a step whoever would revive this daemon can actually take", () => {
    const supervised = planRedskilledMajorHold({ running: RUNNING_VERSION, newest: "2.0.0", supervised: true });
    const alone = planRedskilledMajorHold({ running: RUNNING_VERSION, newest: "2.0.0", supervised: false });

    // Under a unit the ExecStart is what has to move, so the step says so;
    // without one, nothing revives this process and stopping it is the step.
    expect(supervised?.action).toContain("redskilled unit install");
    expect(supervised?.action).toContain("systemctl --user restart");
    expect(alone?.action).toContain("stop this daemon");
    expect(alone?.action).not.toContain("systemctl");
  });

  it("holds nothing for a daemon that is current, inside its major, or a local build", () => {
    const base = { running: RUNNING_VERSION, supervised: false } as const;

    // Genuinely current: nothing is being withheld, so nothing is reported.
    expect(planRedskilledMajorHold({ ...base, newest: RUNNING_VERSION })).toBeNull();
    // Inside the major the timer adopts it, so there is no hold to report.
    expect(planRedskilledMajorHold({ ...base, newest: PUBLISHED_VERSION })).toBeNull();
    expect(planRedskilledMajorHold({ ...base, newest: null })).toBeNull();
    expect(planRedskilledMajorHold({ ...base, newest: "not-a-version" })).toBeNull();
    // A source checkout is not a point on the published lane at all.
    expect(planRedskilledMajorHold({ running: "0.0.0-dev", newest: "9.9.9", supervised: false })).toBeNull();
  });

  it("reports the gap beside the running version, and still adopts inside the major", async () => {
    const { paths, env } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => ({ version: PUBLISHED_VERSION, newest: "2.0.0" }),
      replacementIO: { env, exit: recordExit },
    });
    running.push(daemon);

    // The major boundary changes nothing about in-major adoption.
    expect(await daemon.observePublishedVersion()).toMatchObject({ act: "replace", to: PUBLISHED_VERSION });

    const upgrade = daemon.hostState().upgrade;
    expect(upgrade.running_version).toBe(RUNNING_VERSION);
    expect(upgrade.published_version).toBe(PUBLISHED_VERSION);
    expect(upgrade.newest_published_version).toBe("2.0.0");
    expect(upgrade.major_held).toBe(1);
    expect(upgrade.major_hold?.held_major).toBe(2);
    expect(upgrade.major_hold?.version).toBe("2.0.0");
    expect(upgrade.major_hold?.action).toContain("stop this daemon");
  });

  it("reports no hold at all on a daemon that is genuinely current", async () => {
    const { paths, env } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => ({ version: RUNNING_VERSION, newest: RUNNING_VERSION }),
      replacementIO: { env, exit: recordExit },
    });
    running.push(daemon);

    expect(await daemon.observePublishedVersion()).toEqual({ act: "hold", reason: "no-newer-version" });

    const upgrade = daemon.hostState().upgrade;
    expect(upgrade.newest_published_version).toBe(RUNNING_VERSION);
    expect(upgrade.major_held).toBe(0);
    expect(upgrade.major_hold).toBeNull();
  });

  it("holds nothing it never resolved: an unreadable registry states no major gap", async () => {
    const { paths } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => {
        throw new Error("the registry is unreachable");
      },
      // A host holding no bundle either: an unreadable registry is then the whole
      // answer, rather than the cached evidence a read that resolves nothing gets.
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty") }, exit: recordExit },
    });
    running.push(daemon);

    expect(await daemon.observePublishedVersion()).toEqual({ act: "hold", reason: "published-unknown" });

    const upgrade = daemon.hostState().upgrade;
    expect(upgrade.newest_published_version).toBeNull();
    expect(upgrade.major_held).toBe(0);
    expect(upgrade.major_hold).toBeNull();
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
    // Never a bare `npx`: this command also lands in a systemd ExecStart, which
    // the manager resolves with ITS PATH — relative there is 203/EXEC (#3554).
    expect(isAbsolute(dispatch.command)).toBe(true);

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

  it("resolves the pinned dispatch to the npx beside its own node, through the process's view", async () => {
    const { env } = await session();
    const npx = "/fake/toolchain/node-lts/bin/npx";

    const dispatch = requireRedskilledReplacementEntry("2.7.0", {
      env: { ...env, RED_SKILLS_NPX: "npx", PATH: "/usr/bin:/bin" },
      callerEntry: "",
      execPath: "/fake/toolchain/node-lts/bin/node",
      exists: (path) => path === npx,
    });

    expect(dispatch.source).toBe("pinned-dispatch");
    expect(dispatch.command).toBe(npx);
  });

  it("honors an absolute RED_SKILLS_NPX exactly as stated", async () => {
    const { env } = await session();

    const dispatch = requireRedskilledReplacementEntry("2.7.0", {
      env: { ...env, RED_SKILLS_NPX: "/opt/tools/npx" },
      callerEntry: "",
      exists: () => false,
    });

    expect(dispatch.command).toBe("/opt/tools/npx");
  });

  it("refuses the pinned dispatch when no npx resolves to an absolute path — the upgrade waits, the unit is never poisoned", async () => {
    const { env } = await session();

    const error = (() => {
      try {
        requireRedskilledReplacementEntry("2.7.0", {
          env: { ...env, PATH: "/usr/bin:/bin" },
          callerEntry: "",
          execPath: "/fake/toolchain/node-lts/bin/node",
          exists: () => false,
        });
        return null;
      } catch (err) {
        return err;
      }
    })();

    expect(error).toBeInstanceOf(RedskilledReplacementEntryError);
    // The refusal names where it looked for npx, beside the bundle paths.
    expect((error as RedskilledReplacementEntryError).searched.join("\n")).toContain(
      join("/fake/toolchain/node-lts/bin", "npx"),
    );
    expect((error as RedskilledReplacementEntryError).searched.join("\n")).toContain(join("/usr/bin", "npx"));
  });
});

describe("a daemon that has observed a newer published version", () => {
  it("keeps serving and records the failed takeover when the successor exits at boot", async () => {
    const { paths, env } = await session();
    const lane = createRedskilledEventLane(paths.eventLanePath);
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      supervised: false,
      publishedVersion: async () => PUBLISHED_VERSION,
      eventLane: lane,
      replacementIO: {
        env,
        spawnSuccessor: async () => {
          throw new Error("deliberately broken successor exited 2");
        },
      },
    });
    running.push(daemon);

    await daemon.checkForReplacement();

    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(daemon.hostState().daemon_version).toBe(RUNNING_VERSION);
    expect(await lane.read()).toContainEqual(
      expect.objectContaining({
        event: "daemon-takeover-failed",
        detail: expect.stringContaining(PUBLISHED_VERSION),
      }),
    );
  });

  it("keeps reporting the version it is RUNNING while the replacement is pending", async () => {
    const { paths, env } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit },
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
    const { paths } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => {
        throw new Error("the registry is unreachable");
      },
      // Nothing cached either: unresolvable here means from anywhere, which is
      // the only state that must never be reported as a match.
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty") }, exit: recordExit },
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
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => "3.0.0",
      // No cache, no dispatch: the successor cannot be found at all.
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty"), RED_SKILLS_NO_PINNED_DISPATCH: "1" }, exit: recordExit },
    });
    running.push(daemon);

    await expect(daemon.checkForReplacement()).rejects.toBeInstanceOf(RedskilledReplacementEntryError);
    // The upgrade was lost; the machine was not. The daemon still answers, and
    // still answers as the version it runs.
    expect(await socketAnswers(paths.socketPath)).toBe(true);
    expect(daemon.hostState().daemon_version).toBe(RUNNING_VERSION);
  });

  it("hands over by exiting when a supervisor will revive it", async () => {
    const { paths, env, publishedBundle } = await session();
    const exits: number[] = [];
    const spawns: string[] = [];
    const repoints: string[] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      supervised: true,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: {
        env,
        resolveEntry: () => ({
          command: process.execPath,
          args: [publishedBundle],
          version: PUBLISHED_VERSION,
          source: "bundle-cache",
          searched: [publishedBundle],
        }),
        repointSupervisor: (entry) => repoints.push(entry.version),
        exit: (code) => exits.push(code),
        spawnSuccessor: (entry) => spawns.push(entry.command),
      },
    });
    running.push(daemon);

    expect(await daemon.checkForReplacement()).toMatchObject({ act: "replace", via: "supervisor-exit" });

    // The unit is repointed BEFORE the old daemon releases the socket. Only then
    // does `Restart=always` start the new process from the published entry.
    expect(repoints).toEqual([PUBLISHED_VERSION]);
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
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      liveness: (view) => alive(view.pid),
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit },
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
      replaceCheckMs: 0,
      daemonVersion: PUBLISHED_VERSION,
      liveness: (view) => alive(view.pid),
    });
    running.push(daemon);

    expect(daemon.reattached().map((view) => view.worker_id)).toEqual(["w-lane"]);
    expect(daemon.hostState().budget_accounting.worker_count).toBe(1);
  });
});

// The daemon is always on (ADR 0150 §4), so the boot look and the interval are
// the WHOLE upgrade path — there is no idle boundary left to ask at, which is
// what #2968 once leaned on. Both looks have to fire, replace, and be seen to
// have fired: a daemon reporting no published version says the same thing
// whether its check held or never ran, and that ambiguity is what #2975 was
// diagnosed through by hand.
describe("the working daemon, whose timer is the whole of the ask", () => {
  /** A standing registration — a host with work to do, which never leaves. */
  function hold(daemon: RedskilledDaemon, workspace: string): void {
    daemon.registerProject({
      project_label: "acme/widgets",
      selector: "is:open label:ready",
      argv: ["run", "the", "worker"],
      workspace_path: workspace,
      target: 1,
    });
  }

  it("adopts a newer version on the interval, with the registration still standing", async () => {
    const { paths, env, publishedBundle } = await session();
    const spawns: string[][] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      // Orders of magnitude past the interval: whatever fires here is not an idle
      // exit, and the boot look is off so it is not that either.
      replaceCheckMs: 25,
      replaceBootCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry, argv) => spawns.push([entry.command, ...argv]) },
    });
    running.push(daemon);
    hold(daemon, paths.runtimeDir);

    // The daemon is always on (ADR 0150 §4), so the replacement timer is the
    // whole of the upgrade path — there is no idle boundary to fall back on.
    expect(daemon.hostState().registrations ?? []).toHaveLength(1);
    expect(await until(async () => spawns.length > 0, 5_000)).toBe(true);

    // The successor may run the stable-home copy of the published bundle —
    // same bytes, the directory nothing prunes — so the pin is the VERSIONED
    // basename, which both locations share and no other version can wear.
    expect(spawns[0].join(" ")).toContain(basename(publishedBundle));
    expect(daemon.hostState().upgrade.replacement).toBe("in-progress");
    expect(daemon.hostState().upgrade.checks).toBeGreaterThan(0);
    // And it does let go of the session — but AFTER the successor is staged, not
    // before. A successor is started while the incumbent still holds the socket
    // precisely so a boot that fails is a takeover that never happened rather
    // than a machine left with no daemon at all; the handover commits only once
    // the successor has proven it can boot. So the spawn above is not the moment
    // the socket goes quiet, and waiting for it is the honest assertion.
    expect(await until(async () => !(await socketAnswers(paths.socketPath)), 5_000)).toBe(true);
  });

  it("takes its first look shortly after boot, not one whole interval later", async () => {
    const { paths, env, publishedBundle } = await session();
    const spawns: string[][] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      // The SHIPPED interval, which cannot fire inside this test: the look that
      // does is the boot one, and without it this daemon would serve a published
      // release past for fifteen minutes with `checks: 0`.
      replaceCheckMs: DEFAULT_REDSKILLED_REPLACE_CHECK_MS,
      replaceBootCheckMs: 25,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry, argv) => spawns.push([entry.command, ...argv]) },
    });
    running.push(daemon);
    hold(daemon, paths.runtimeDir);

    expect(await until(async () => spawns.length > 0, 5_000)).toBe(true);
    // The successor may run the stable-home copy of the published bundle —
    // same bytes, the directory nothing prunes — so the pin is the VERSIONED
    // basename, which both locations share and no other version can wear.
    expect(spawns[0].join(" ")).toContain(basename(publishedBundle));
  });

  it("owes a successor no boot look, so a mis-resolving one cannot spin", async () => {
    const { paths, env } = await session();
    let probes = 0;
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: DEFAULT_REDSKILLED_REPLACE_CHECK_MS,
      replaceBootCheckMs: 20,
      // Born BY a replacement seconds ago: the version question was just asked.
      bornByReplacement: true,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => {
        probes += 1;
        return PUBLISHED_VERSION;
      },
      replacementIO: { env, exit: recordExit },
    });
    running.push(daemon);
    hold(daemon, paths.runtimeDir);
    await new Promise((r) => setTimeout(r, 120));

    // It waits for the ordinary interval like any other tick.
    expect(probes).toBe(0);
    expect(daemon.hostState().upgrade.checks).toBe(0);
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });

  it("carries its live Worker through the interval route untouched", async () => {
    const { paths, env } = await session();
    const worker = longLivedWorker("w-busy-survivor");
    const spawns: string[][] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 25,
      replaceBootCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      liveness: (view) => alive(view.pid),
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry, argv) => spawns.push([entry.command, ...argv]) },
    });
    running.push(daemon);
    daemon.trackWorker(worker);
    hold(daemon, paths.runtimeDir);

    expect(await until(async () => spawns.length > 0, 5_000)).toBe(true);

    // A replacement is a restart, not an evacuation — on this route as well.
    expect(alive(worker.pid)).toBe(true);
  });

  it("never replaces a local build on this route either, and spends no read", async () => {
    const { paths, env } = await session();
    const spawns: string[] = [];
    let probes = 0;
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 25,
      replaceBootCheckMs: 15,
      daemonVersion: "0.0.0-dev",
      publishedVersion: async () => {
        probes += 1;
        return "9.9.9";
      },
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry) => spawns.push(entry.command) },
    });
    running.push(daemon);
    hold(daemon, paths.runtimeDir);
    await new Promise((r) => setTimeout(r, 150));

    // No release supersedes a source checkout, so the read is never spent — and
    // the developer's own daemon is never taken away mid-session.
    expect(probes).toBe(0);
    expect(spawns).toEqual([]);
    const upgrade = daemon.hostState().upgrade;
    // But the look DID fire, and says so: this is a decision, not a silence.
    expect(upgrade.checks).toBeGreaterThan(0);
    expect(upgrade.hold_reason).toBe("local-build");
    expect(await socketAnswers(paths.socketPath)).toBe(true);
  });
});

// The surface the whole investigation went without: a daemon reporting
// `published_version: null` said the same thing whether its check had fired and
// resolved nothing or had never fired at all, and those are different defects
// with different cures (#2975).
describe("a check that held and a check that never fired", () => {
  it("tells them apart from the daemon's own answer", async () => {
    const { paths, env } = await session();
    const silent = await startRedskilledDaemon({
      paths,
      // Armed, and nowhere near due: this daemon has never looked.
      replaceCheckMs: DEFAULT_REDSKILLED_REPLACE_CHECK_MS,
      replaceBootCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => RUNNING_VERSION,
      replacementIO: { env, exit: recordExit },
    });
    running.push(silent);

    const never = silent.hostState().upgrade;
    expect(never.checks).toBe(0);
    expect(never.checked_at).toBeNull();
    expect(never.hold_reason).toBeNull();
    // The field that used to be the only evidence, reading identically either way.
    expect(never.published_unknown).toBe(1);

    // The same daemon, one look later: the mechanism is alive and it decided.
    await silent.observePublishedVersion();
    const held = silent.hostState().upgrade;
    expect(held.checks).toBe(1);
    expect(held.checked_at).not.toBeNull();
    expect(held.hold_reason).toBe("no-newer-version");
  });

  it("names an unreachable registry as the reason, rather than leaving it to be guessed", async () => {
    const { paths } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => {
        throw new Error("the registry is unreachable");
      },
      // Nothing cached either, so nothing is resolvable from anywhere.
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty") }, exit: recordExit },
    });
    running.push(daemon);

    await daemon.observePublishedVersion();

    const upgrade = daemon.hostState().upgrade;
    expect(upgrade.checks).toBe(1);
    expect(upgrade.hold_reason).toBe("published-unknown");
  });
});

// A read that runs out of time and a read that throws are the same fact — the
// registry resolved nothing — and the shipped probe already answers the second
// from the bundle cache. Answering the first with `null` instead is how a host
// that HELD the newer bundle went on serving the older one (#2975).
describe("a read the registry never answers", () => {
  it("falls back to the bundle this host already holds", async () => {
    const { paths, env, publishedBundle } = await session();
    const spawns: string[][] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      publishedProbeTimeoutMs: 20,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: () => new Promise(() => undefined),
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry, argv) => spawns.push([entry.command, ...argv]) },
    });
    running.push(daemon);

    expect(await daemon.checkForReplacement()).toMatchObject({ act: "replace", to: PUBLISHED_VERSION });
    // The successor may run the stable-home copy of the published bundle —
    // same bytes, the directory nothing prunes — so the pin is the VERSIONED
    // basename, which both locations share and no other version can wear.
    expect(spawns[0].join(" ")).toContain(basename(publishedBundle));
  });

  // #4047: the incumbent must LEAVE once the endpoint is someone else's.
  it("leaves after handing over, so no socketless daemon holds the host slot", async () => {
    const { paths, env } = await session();
    const before = exitCodes.length;
    const spawns: string[][] = [];
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: async () => PUBLISHED_VERSION,
      replacementIO: { env, exit: recordExit, spawnSuccessor: (entry, argv) => spawns.push([entry.command, ...argv]) },
    });
    running.push(daemon);

    expect(await daemon.checkForReplacement()).toMatchObject({ act: "replace", to: PUBLISHED_VERSION });
    // A successor was started AND the incumbent asked to go: either half alone
    // is the failure — a successor with a live predecessor is the zombie that
    // left the host with no socket for 25 minutes.
    expect(spawns.length).toBeGreaterThan(0);
    expect(exitCodes.slice(before)).toContain(75);
  });

  it("stays unknown when the host holds nothing either", async () => {
    const { paths } = await session();
    const daemon = await startRedskilledDaemon({
      paths,
      replaceCheckMs: 0,
      publishedProbeTimeoutMs: 20,
      daemonVersion: RUNNING_VERSION,
      publishedVersion: () => new Promise(() => undefined),
      replacementIO: { env: { RED_SKILLS_CACHE_DIR: join(paths.runtimeDir, "empty") }, exit: recordExit },
    });
    running.push(daemon);

    expect(await daemon.observePublishedVersion()).toEqual({ act: "hold", reason: "published-unknown" });
    expect(daemon.hostState().upgrade.published_unknown).toBe(1);
  });

  it("reads the host alone as the same weaker evidence the throw path uses", async () => {
    const { cacheDir, env } = await session();
    await writeFile(join(cacheDir, "redskilled-2.0.0.bundle.min.mjs"), "", { mode: 0o755 });

    const evidence = localRedskilledPublishedEvidence(RUNNING_VERSION, env);

    // Capped at the running major for adoption, and honest about the horizon:
    // an unreachable registry must never be the reason a major is crossed.
    expect(evidence.version).toBe(PUBLISHED_VERSION);
    expect(evidence.newest).toBe("2.0.0");
  });
});
