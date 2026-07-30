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
import { launchWorker, RedskilledWorkerSpecError, type RedskilledWorkerSpec } from "../src/worker-launch.js";
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
    expect(spawns[0]!.args.join(" ")).not.toMatch(/\.git|\.red|package\.json|worktree/);
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
      posix: { available: false, reason: expect.stringContaining("macOS backend") },
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
