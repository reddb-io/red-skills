// Slot spawn argv — the worker entry must never be inferred from argv[1]
// (#2677). Under the MCP lane the supervisor IS the castle-mcp bundle, whose
// entry does not route `run`; spawning slots against it made every slot die on
// a singleton-lease error and the fleet drain nothing.
//
// Since the ADR 0130 cutover (#2851) the supervisor no longer spawns the slot
// itself — it hands the argv to the host daemon. So the argv under test is the
// one on the SPEC, and the assertion is the same assertion: what the daemon is
// asked to run must be the entry that routes `run`.
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildSupervisorDeps } from "../src/commands/supervise.js";
import { parseCli } from "../src/cli.js";
import { main as mcpMain } from "../src/mcp-server.js";
import type {
  RedskilledBirthPort,
  RedskilledHostEvent,
  RedskilledWorkerSpec,
} from "../src/runtime/redskilled-birth.js";

const roots: string[] = [];
/** Every spec this project asked the host for, in order. */
let asked: RedskilledWorkerSpec[] = [];

/** A host that grants every request and remembers what it was asked to run. */
function recordingHost(): RedskilledBirthPort {
  return {
    projectLabel: "reddb-io/red-skills",
    socketPath: "/nonexistent/redskilled.sock",
    reach: async () => undefined,
    start: async (spec) => {
      asked.push(spec);
      return { workerId: spec.worker_id ?? "wTEST", pid: 4242, warnings: [], admission: "admitted" };
    },
    stop: async () => true,
    register: async () => {
      throw new Error("no project registers itself in a slot-argv test");
    },
    renew: async () => {
      throw new Error("no project renews a registration in a slot-argv test");
    },
    deregister: async () => false,
    workerIds: async () => [],
    liveWorkers: async () => asked.length,
    drainEvents: async () => [],
  };
}

afterEach(async () => {
  asked = [];
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "supervise-slot-entry-"));
  roots.push(value);
  await mkdir(join(value, ".red", "tmp", "slot-logs"), { recursive: true });
  return value;
}

async function deps(cwd: string) {
  return buildSupervisorDeps(
    cwd,
    join(cwd, ".red", "tmp"),
    join(cwd, ".red", "tmp", "slot-logs"),
    join(cwd, ".red", "tmp", "firehose.toonl"),
    join(cwd, ".red", "tmp", "state.toon"),
    "s1234",
    "claude",
    300,
    { cwd, repo: "reddb-io/red-skills" },
    "main",
    [],
    [],
    recordingHost(),
  );
}

/** The argv the host was asked to run for the nth request. */
function askedArgs(index = 0): readonly string[] {
  const spec = asked[index];
  if (spec === undefined) throw new Error(`the host was never asked for worker ${index}`);
  return spec.args ?? [];
}

/** argv[1] shapes a supervisor can be re-exec'd under. */
const MCP_BUNDLE = "/opt/red/dist/castle-mcp.bundle.min.mjs";
const VERSIONED_MCP_BUNDLE = "/opt/red/dist/castle-mcp-2.90.0.bundle.min.mjs";

describe("spawnSlot worker entry (#2677)", () => {
  it("spawns the dev bundle — not the castle-mcp bundle — when the supervisor is the MCP entry", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect(asked).toHaveLength(1);
    const args = askedArgs();
    expect(basename(args[0]!)).toBe("dev.bundle.min.mjs");
    expect(args).not.toContain(MCP_BUNDLE);
    expect(args.slice(1, 3)).toEqual(["run", "--once"]);
  });

  it("resolves the versioned dev sibling for a versioned castle-mcp bundle", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([
      process.execPath,
      VERSIONED_MCP_BUNDLE,
      "__supervise",
    ]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect(basename(askedArgs()[0]!)).toBe("dev-2.90.0.bundle.min.mjs");
  });

  it("leaves the CLI lane untouched — a dev bundle argv[1] is spawned unchanged", async () => {
    const cwd = await root();
    const devBundle = "/opt/red/dist/dev.bundle.min.mjs";
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, devBundle, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);

    expect(askedArgs()[0]).toBe(devBundle);
  });

  it("spawns the dev bundle for reconcile workers too", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnReconcileWorker?.(1, { issue: 42 } as never);

    const args = askedArgs();
    expect(basename(args[0]!)).toBe("dev.bundle.min.mjs");
    expect(args).toContain("--reconcile-issue");
  });
});

describe("MCP-launched fleet regression: the slot boots a worker instead of dying (#2677)", () => {
  it("routes the produced slot argv through the dev entry as `run` (never the mcp entry)", async () => {
    const cwd = await root();
    vi.spyOn(process, "argv", "get").mockReturnValue([process.execPath, MCP_BUNDLE, "__supervise"]);

    const { proc } = await deps(cwd);
    await proc.spawnSlot(0, undefined);
    const [entry, ...slotArgv] = askedArgs();

    // The entry is the one that routes `run` — a real worker boots and writes
    // its worker directory, so the slot occupies its slot instead of dying.
    expect(basename(entry!)).toBe("dev.bundle.min.mjs");
    expect(parseCli(slotArgv).command).toBe("run");

    // And the pre-fix target can no longer swallow the same argv silently: the
    // castle-mcp entry refuses it by name rather than opening a second resident.
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    await expect(
      mcpMain(slotArgv, {
        supervise: async () => 0,
        startCurator: async () => expect.unreachable("curator must not start for `run`"),
        startMergeDriver: async () => expect.unreachable("merge driver must not start for `run`"),
        connect: async () => expect.unreachable("stdio transport must not open for `run`"),
      }),
    ).resolves.toBe(2);
    expect(stderr.mock.calls[0]![0]).toContain("unroutable subcommand");
  });
});

// The cutover itself (#2851, ADR 0130): the per-project runtime asks, and only
// the host launches. These assertions are about WHO births a Worker, which is
// the fact #2784 claimed and did not deliver.
describe("the host is the launcher", () => {
  it("asks the host for every Worker, carrying the workspace, the log and the project's own id", async () => {
    const cwd = await root();
    const { proc } = await deps(cwd);

    await proc.spawnSlot(0, undefined);

    const spec = asked[0]!;
    expect(spec.workspace_path).toBe(cwd);
    expect(spec.log_path).toContain("slot-logs");
    // The host's handle and the work's handle are one string, so a surface can
    // join a Worker's process verdict to the work it is doing.
    expect(spec.worker_id).toMatch(/^w[A-Z0-9]{4}$/);
    expect(spec.env?.RED_AFK_WORKER_ID).toBe(spec.worker_id);
    expect(spec.env?.RED_AFK_SLOT).toBe("0");
  });

  it("starts nothing when the host refuses, rather than spawning the Worker itself", async () => {
    const cwd = await root();
    const refusing: RedskilledBirthPort = {
      ...recordingHost(),
      start: async () => {
        throw new Error("redskilled refused this Worker: the host is at its ceiling");
      },
    };
    const { proc } = buildSupervisorDeps(
      cwd,
      join(cwd, ".red", "tmp"),
      join(cwd, ".red", "tmp", "slot-logs"),
      join(cwd, ".red", "tmp", "firehose.toonl"),
      join(cwd, ".red", "tmp", "state.toon"),
      "s1234",
      "claude",
      300,
      { cwd, repo: "reddb-io/red-skills" },
      "main",
      [],
      [],
      refusing,
    );

    await expect(proc.spawnSlot(0, undefined)).rejects.toThrow(/refused this Worker/);
    expect(asked).toHaveLength(0);
  });

  it("routes a Worker's death from the host event lane into the slot's exit code", async () => {
    const cwd = await root();
    const host = recordingHost();
    let events: RedskilledHostEvent[] = [];
    const { proc } = buildSupervisorDeps(
      cwd,
      join(cwd, ".red", "tmp"),
      join(cwd, ".red", "tmp", "slot-logs"),
      join(cwd, ".red", "tmp", "firehose.toonl"),
      join(cwd, ".red", "tmp", "state.toon"),
      "s1234",
      "claude",
      300,
      { cwd, repo: "reddb-io/red-skills" },
      "main",
      [],
      [],
      { ...host, drainEvents: async () => events.splice(0) },
    );

    await proc.spawnSlot(2, undefined);
    const workerId = asked[0]!.worker_id!;
    expect(proc.lastExitCode?.(2)).toBeNull();

    events = [
      {
        version: 1,
        ts: "2026-07-30T00:00:00.000Z",
        event: "worker-death",
        worker_id: workerId,
        project_label: "reddb-io/red-skills",
        pid: 4242,
        workspace_path: cwd,
        log_path: null,
        isolated: true,
        unit: null,
        memory_high: null,
        memory_max: null,
        cpu_weight: null,
        detail: "exit code=78 signal=null",
        exit_code: 78,
        signal: null,
      reason: null,
      },
    ];
    await proc.observeHostDeaths?.();

    // The number the HOST witnessed, not one this process inferred from a pid
    // that stopped answering — which is what makes the project's circuit breaker
    // a policy over the daemon's facts rather than a second observer.
    expect(proc.lastExitCode?.(2)).toBe(78);
  });
});
