// Birth through the socket: a project asks, the daemon launches, and the host
// state tells the truth about what it got. The tracer bullet of ADR 0130.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readRedskilledHostState, startRedskilledWorker } from "../src/client.js";
import { startRedskilledDaemon, type RedskilledDaemon } from "../src/daemon.js";
import { isRedskilledWorkerView } from "../src/host-state.js";
import { resolveRedskilledPaths, type RedskilledPaths } from "../src/paths.js";
import { evaluateWorkerAdmission, UNBOUNDED_HOST_CEILING } from "../src/admission.js";
import {
  encodeHostWorkerId,
  launchWorker,
  mintHostWorkerId,
  RedskilledWorkerSpecError,
  type RedskilledWorkerSpec,
} from "../src/worker-launch.js";
import { detectWorkerPlacementProbes, type WorkerPlacementProbes } from "../src/worker-placement.js";

const running: RedskilledDaemon[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop().catch(() => undefined);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function scratch(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sessionPaths(): Promise<RedskilledPaths> {
  const root = await scratch("redskilled-birth-");
  return resolveRedskilledPaths({ env: { REDSKILLED_SESSION: `test:${root}`, REDSKILLED_MACHINE_DIR: root }, runtimeDir: root });
}

/** A Worker that writes proof it ran in the workspace it was handed, then exits. */
function proofSpec(workspacePath: string, overrides: Partial<RedskilledWorkerSpec> = {}): RedskilledWorkerSpec {
  return {
    project_label: "acme/widgets",
    workspace_path: workspacePath,
    command: process.execPath,
    args: ["-e", "require('node:fs').writeFileSync('proof.txt', process.cwd());"],
    budget: { memory_high: "512M" },
    ...overrides,
  };
}

describe("worker birth through the socket", () => {
  it("starts a Worker, and it appears in host state with its project label", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const started = await startRedskilledWorker(paths, proofSpec(workspace), { readyTimeoutMs: 5_000 });

    expect(isRedskilledWorkerView(started.worker)).toBe(true);
    expect(started.worker.project_label).toBe("acme/widgets");
    expect(started.worker.worker_id).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(started.worker.pid).toBeGreaterThan(0);
    expect(started.worker.workspace_path).toBe(workspace);

    const state = await readRedskilledHostState(paths, { readyTimeoutMs: 5_000 });
    expect(state.workers.map((worker) => worker.worker_id)).toContain(started.worker.worker_id);
    expect(state.projects).toEqual([{ project_label: "acme/widgets", worker_count: 1 }]);
  });

  it("runs the Worker in a transient unit of its own, or says why it could not", async () => {
    // The host decides which branch is reachable here; both are legitimate and
    // neither may be silent. That is the assertion.
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const started = await startRedskilledWorker(paths, proofSpec(workspace), { readyTimeoutMs: 5_000 });

    if (started.worker.isolated) {
      expect(started.worker.unit).toMatch(/^red-worker-acme-widgets-.*\.service$/);
      expect(started.warnings).toEqual([]);
    } else {
      expect(started.worker.unit).toBeUndefined();
      expect(started.warnings.length).toBeGreaterThan(0);
      expect(started.warnings.join(" ")).toMatch(/resource group/);
    }
    expect(started.worker.warnings).toEqual(started.warnings);
  });

  it("runs the Worker in the workspace it was handed, verbatim", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    await startRedskilledWorker(paths, proofSpec(workspace), { readyTimeoutMs: 5_000 });

    const proof = join(workspace, "proof.txt");
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        expect(await readFile(proof, "utf8")).toBe(workspace);
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
    throw new Error(`the Worker never wrote ${proof}`);
  });

  it("holds the daemon open while it believes the Worker is alive, and lets go on exit", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    await startRedskilledWorker(
      paths,
      proofSpec(workspace, { args: ["-e", "setTimeout(() => {}, 150);"] }),
      { readyTimeoutMs: 5_000 },
    );

    expect(daemon.workerCount()).toBe(1);
    expect(daemon.evaluateIdle()).toBe("held-by-workers");

    for (let attempt = 0; attempt < 100 && daemon.workerCount() > 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(daemon.workerCount()).toBe(0);
    expect(daemon.hostState().projects).toEqual([]);
  });

  it("refuses an unlaunchable spec instead of half-starting one", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    await expect(
      startRedskilledWorker(paths, { ...proofSpec(workspace), project_label: "" }, { readyTimeoutMs: 5_000 }),
    ).rejects.toThrow(/project_label/);
    expect(daemon.workerCount()).toBe(0);
  });

  it("keeps a project-minted Worker id distinguishable from a host fallback", async () => {
    const paths = await sessionPaths();
    const workspace = await scratch("redskilled-workspace-");
    const daemon = await startRedskilledDaemon({ paths, idleMs: 60_000 });
    running.push(daemon);

    const started = await startRedskilledWorker(
      paths,
      proofSpec(workspace, { worker_id: "wVWHA" }),
      { readyTimeoutMs: 5_000 },
    );

    expect(started.worker.worker_id).toBe("wVWHA");
  });
});

describe("host-minted Worker ids", () => {
  // ADR 0149 §3: the id IS the birth instant, so the order is readable from the
  // name and a prune is a prefix scan.
  const FIXED_WIDTH_BASE62 = /^[0-9A-Za-z]{7}$/;

  it("mints fixed-width base62 ids that sort lexicographically by birth", () => {
    const first = mintHostWorkerId([]);
    const second = mintHostWorkerId([first]);

    expect(first).toMatch(FIXED_WIDTH_BASE62);
    expect(second).toMatch(FIXED_WIDTH_BASE62);
    // Strictly less, not merely different: two Workers born inside one
    // millisecond still have to come out in the order they were born.
    expect(first < second).toBe(true);
  });

  it("walks the birth instant forward by 1 ms until the id is not a live one", () => {
    const bornAtMs = 1_770_000_000_000;
    const taken = [encodeHostWorkerId(bornAtMs), encodeHostWorkerId(bornAtMs + 1)];

    const workerId = mintHostWorkerId([...taken, "wVWHA"], () => bornAtMs);

    expect(workerId).toBe(encodeHostWorkerId(bornAtMs + 2));
    expect(taken).not.toContain(workerId);
    expect(workerId).toMatch(FIXED_WIDTH_BASE62);
  });

  it("never returns a live id however crowded the millisecond is", () => {
    const bornAtMs = 1_770_000_000_000;
    const live = new Set(
      Array.from({ length: 64 }, (_unused, offset) => encodeHostWorkerId(bornAtMs + offset)),
    );

    const workerId = mintHostWorkerId(live, () => bornAtMs);

    expect(live.has(workerId)).toBe(false);
    expect(workerId).toBe(encodeHostWorkerId(bornAtMs + 64));
  });

  it("encodes the birth epoch so a byte-order sort is a birth-order sort", () => {
    const instants = [0, 1, 61, 62, 3_843, 1_770_000_000_000, 1_770_000_000_001];
    const ids = instants.map(encodeHostWorkerId);

    expect(ids[0]).toBe("0000000");
    expect(ids[1]).toBe("0000001");
    expect(ids[2]).toBe("000000z");
    expect(ids[3]).toBe("0000010");
    expect(ids.every((id) => FIXED_WIDTH_BASE62.test(id))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
  });

  it("refuses a birth instant that does not fit the fixed width", () => {
    // 62^7 ms after the epoch — the first instant a 7-character id would have to
    // grow for, which would silently break the sort it exists to provide.
    expect(() => encodeHostWorkerId(62 ** 7)).toThrow(RedskilledWorkerSpecError);
    expect(() => encodeHostWorkerId(-1)).toThrow(RedskilledWorkerSpecError);
  });
});

describe("the daemon accepts the workspace path as given", () => {
  // Placement is what these cases are about, so admission is held constant: an
  // unbounded ceiling is the operator's own opt-out, not a test-only bypass.
  const ADMITTED = evaluateWorkerAdmission({ ceiling: UNBOUNDED_HOST_CEILING, workers: [] });
  const LINUX_WITH_SESSION: WorkerPlacementProbes = {
    platform: "linux",
    systemdRun: "/usr/bin/systemd-run",
    userSession: true,
    jobObjects: { available: false, reason: "not Windows" },
    posix: { available: false, reason: "not macOS" },
  };

  it("never reads a repository marker to decide where the Worker runs", () => {
    // A path with no repository under it at all — no .git, no .red, no package
    // manifest, not even an existing directory. The launch plan must be
    // identical in shape to one aimed at a real checkout.
    const spawns: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
    const launched = launchWorker({
      admission: ADMITTED,
      spec: {
        project_label: "opaque-label",
        workspace_path: "/definitely/not/a/checkout",
        command: "/bin/true",
      },
      probes: LINUX_WITH_SESSION,
      spawnFn: (command, args, options) => {
        spawns.push({ command, args, cwd: options.cwd as string | undefined });
        return { pid: 4242, once: () => undefined, unref: () => undefined } as never;
      },
    });

    expect(launched.worker.workspace_path).toBe("/definitely/not/a/checkout");
    expect(spawns).toHaveLength(1);
    expect(spawns[0]!.args).toContain("--working-directory=/definitely/not/a/checkout");
    // The inherited PATH is excluded from the marker sweep: it is the DAEMON's
    // own environment handed down (#3064), so whatever a developer's shell put
    // on it says nothing about what the daemon read from the client's path.
    const derived = spawns[0]!.args.filter((arg) => !arg.startsWith("--setenv=PATH="));
    expect(derived.join(" ")).not.toMatch(/\.git|\.red|package\.json|worktree/);
  });

  it("does not copy daemon or caller GitHub credentials into a Worker", () => {
    let spawnedEnv: NodeJS.ProcessEnv | undefined;
    let spawnedArgs: readonly string[] = [];
    launchWorker({
      admission: ADMITTED,
      env: {
        PATH: "/usr/bin",
        REDSKILLED_HOST_TOKEN: "daemon credential",
        GITHUB_TOKEN: "ambient credential",
        GH_TOKEN: "cli credential",
        RED_GITHUB_APP_ID: "app id",
        RED_GITHUB_APP_INSTALLATION: "installation id",
        RED_GITHUB_APP_KEY: "/credential/key",
      },
      spec: {
        project_label: "github:101",
        workspace_path: "/project-workspaces/widgets",
        command: "/bin/true",
        env: { GITHUB_TOKEN: "caller credential", SAFE_WORKER_FACT: "kept" },
      },
      probes: LINUX_WITH_SESSION,
      spawnFn: (_command, args, options) => {
        spawnedArgs = args;
        spawnedEnv = options.env;
        return { pid: 4242, once: () => undefined, unref: () => undefined } as never;
      },
    });

    for (const name of [
      "REDSKILLED_HOST_TOKEN",
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "RED_GITHUB_APP_ID",
      "RED_GITHUB_APP_INSTALLATION",
      "RED_GITHUB_APP_KEY",
    ]) {
      expect(spawnedEnv?.[name]).toBeUndefined();
      expect(spawnedArgs.some((arg) => arg.startsWith(`--setenv=${name}=`))).toBe(false);
    }
    expect(spawnedArgs).toContain("--setenv=SAFE_WORKER_FACT=kept");
  });

  it("derives nothing from the host either: probes are all it reads", () => {
    // `detectWorkerPlacementProbes` is the daemon's ONLY host read on the launch
    // path, and it looks at the platform, PATH and XDG_RUNTIME_DIR — never at a
    // directory a client named.
    const probes = detectWorkerPlacementProbes({ PATH: "", XDG_RUNTIME_DIR: "" }, "linux");

    expect(probes).toEqual({
      platform: "linux",
      systemdRun: null,
      userSession: false,
      jobObjects: { available: false, reason: expect.stringContaining("Windows backend") },
      // POSIX shell placement stopped being "the macOS backend" when it became
      // the fallback for a Linux host with no systemd, so it reports available
      // here. It stays inside this test's invariant: `/bin/sh` is an absolute
      // path the daemon was shipped knowing, and `nice` is null precisely
      // BECAUSE the handed PATH is empty — both answers derive from the probe
      // arguments, never from a directory a client named.
      posix: { available: true, shell: "/bin/sh", nice: null },
    });
  });

  it("rejects a spec with no workspace at all rather than inventing one", () => {
    expect(() =>
      launchWorker({
        admission: ADMITTED,
        spec: { project_label: "opaque", workspace_path: "  ", command: "/bin/true" },
        probes: LINUX_WITH_SESSION,
        spawnFn: () => ({ pid: 1, once: () => undefined, unref: () => undefined }) as never,
      }),
    ).toThrow(RedskilledWorkerSpecError);
  });
});
