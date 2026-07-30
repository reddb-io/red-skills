// The canary's step contract. The e2e sibling proves the canary catches #2677
// against real processes; this file pins WHAT each step asserts and that a red
// run names the step that went inert.
import { describe, expect, it, vi } from "vitest";
import { decode } from "@reddb-io/toon";
import {
  MCP_LANE_CANARY_STEPS,
  renderMcpLaneCanaryToon,
  runMcpLaneCanary,
  type CanaryWorker,
  type McpLaneCanaryDeps,
} from "../src/core/mcp-lane-canary.js";
import { parseMcpLaneCanaryArgs } from "../src/commands/mcp-lane-canary.js";
import { resolveShippedMcpEntry } from "../src/runtime/mcp-lane-canary-io.js";
import { DAEMON_SILENCE_REASON } from "../src/runtime/liveness-anchor.js";

const SUPERVISOR_PID = 40_100;
const WORKER_PID = 40_200;

function worker(overrides: Partial<CanaryWorker> = {}): CanaryWorker {
  return {
    worker: "wCAN1",
    dir: "/scratch/.red/tmp/workers/wCAN1",
    pid: WORKER_PID,
    alive: true,
    ...overrides,
  };
}

/** One `worker_vitals` row in the shape the shipped adapter publishes it. */
function vitals(daemonLiveness: unknown = daemonAnswered()): unknown {
  return [{ worker: { id: "wCAN1", pid: WORKER_PID }, live: true, daemon_liveness: daemonLiveness }];
}

/** The daemon answered — about a Worker it never birthed, which is the honest
 * verdict for one this lane launched itself. */
function daemonAnswered(): unknown {
  return {
    verdict: "unknown",
    anchor: "none",
    project_label: null,
    pid: null,
    staleness: { stale: true, age_ms: null, threshold_ms: null, reason: DAEMON_UNCOVERED },
  };
}

/** The daemon said nothing at all — the socket boundary is broken. */
function daemonSilent(): unknown {
  return {
    verdict: "unknown",
    anchor: "none",
    project_label: null,
    pid: null,
    staleness: { stale: true, age_ms: null, threshold_ms: null, reason: DAEMON_SILENCE_REASON },
  };
}

const DAEMON_UNCOVERED =
  "the daemon holds no record of this Worker while the caller still sees it running, " +
  "so its silence is ignorance about a Worker it never birthed, not evidence of death";

interface HarnessOptions {
  tools?: readonly string[];
  create?: unknown;
  status?: unknown;
  stop?: unknown;
  /** What `worker_vitals` answers. */
  vitals?: unknown;
  /** Worker observations, consumed one per scan; the last repeats forever. */
  observations?: readonly (readonly CanaryWorker[])[];
  /** Pids that are alive; a pid absent here reads dead. */
  livePids?: readonly number[];
  /** Pids that stop being alive once project_stop has been called. */
  diesOnStop?: readonly number[];
}

function harness(options: HarnessOptions = {}) {
  let stopped = false;
  let clock = 0;
  const observations = options.observations ?? [[worker()]];
  let scans = 0;
  const live = new Set(options.livePids ?? [SUPERVISOR_PID, WORKER_PID]);
  const diesOnStop = new Set(options.diesOnStop ?? [SUPERVISOR_PID, WORKER_PID]);
  const calls: { tool: string; args: Record<string, unknown> }[] = [];

  const deps: McpLaneCanaryDeps = {
    listTools: async () =>
      options.tools ?? [
        "project_start",
        "project_status",
        "project_stop",
        "worker_vitals",
        "worker_status",
      ],
    callTool: async (tool, args) => {
      calls.push({ tool, args });
      if (tool === "project_start") {
        return options.create ?? { status: "launched", pid: SUPERVISOR_PID, target: 1 };
      }
      if (tool === "worker_vitals") {
        return options.vitals ?? vitals();
      }
      if (tool === "project_status") {
        return (
          options.status ?? {
            supervisor: { pid: SUPERVISOR_PID, alive: true },
            slots: { busy: 1, free: 0, total: 1, parked: 0 },
          }
        );
      }
      if (tool === "project_stop") {
        stopped = true;
        return options.stop ?? { status: "stopped", pid: SUPERVISOR_PID };
      }
      throw new Error(`unexpected tool ${tool}`);
    },
    observeWorkers: async () => {
      const at = Math.min(scans, observations.length - 1);
      scans += 1;
      const rows = observations[at] ?? [];
      return stopped ? rows.filter((row) => !diesOnStop.has(row.pid ?? -1)) : rows;
    },
    isLive: (pid) => (stopped && diesOnStop.has(pid) ? false : live.has(pid)),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => {
      clock += 1;
      return clock;
    },
  };
  return { deps, calls };
}

const OPTIONS = {
  fleet: "canary",
  runner: "claude",
  pollMs: 10,
  workerDeadlineMs: 200,
  daemonDeadlineMs: 200,
};

describe("MCP lane canary — green lane", () => {
  it("walks every step and reports the lane alive", async () => {
    const { deps, calls } = harness();

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.ok).toBe(true);
    expect(result.inertStep).toBeUndefined();
    expect(result.steps.map((step) => step.step)).toEqual([...MCP_LANE_CANARY_STEPS]);
    expect(result.steps.every((step) => step.verdict === "ok")).toBe(true);
    expect(result.supervisorPid).toBe(SUPERVISOR_PID);
    expect(result.summary).toContain("green");
    // The real tool surface was driven, in lane order.
    expect(calls.map((call) => call.tool)).toEqual([
      "project_start",
      "worker_vitals",
      "project_status",
      "project_stop",
    ]);
  });
});

describe("MCP lane canary — the socket boundary (#2794)", () => {
  it("fails at daemon_reach when the tool answers and the daemon does not", async () => {
    const { deps } = harness({ vitals: vitals(daemonSilent()) });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.inertStep).toBe("daemon_reach");
    // The lane looked healthy up to the socket: this is the two-process shape of
    // the same silent inertness #2677 taught, so the report must say so.
    const byStep = new Map(result.steps.map((step) => [step.step, step.verdict]));
    expect(byStep.get("worker_spawn")).toBe("ok");
    expect(byStep.get("daemon_reach")).toBe("inert");
    expect(byStep.get("project_status")).toBe("skipped");
    expect(result.summary).toContain("daemon_reach");
    expect(result.summary).toContain("the tool is reachable and the socket is not");
    // An inert lane is still torn down.
    expect(byStep.get("project_stop")).toBe("ok");
  });

  it("accepts a daemon that answered about a Worker it never birthed", async () => {
    const { deps } = harness();

    const result = await runMcpLaneCanary(deps, OPTIONS);

    const step = result.steps.find((entry) => entry.step === "daemon_reach");
    expect(step?.verdict).toBe("ok");
    expect(step?.detail).toContain("crossed the socket for wCAN1");
  });

  it("fails at daemon_reach when the row carries no daemon verdict at all", async () => {
    const { deps } = harness({ vitals: [{ worker: { id: "wCAN1" }, live: true }] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("daemon_reach");
    expect(result.summary).toContain("no daemon_liveness block");
  });

  it("refuses a verdict about some other worker as evidence for this one", async () => {
    // The false-green shape: the reader answers, nothing it says is about the
    // work this walk performed.
    const { deps } = harness({
      vitals: [{ worker: { id: "wOTHER" }, live: true, daemon_liveness: daemonAnswered() }],
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("daemon_reach");
    expect(result.summary).toContain("listed only wOTHER");
    expect(result.summary).toContain("wCAN1");
  });

  it("fails at daemon_reach when the reader publishes no worker at all", async () => {
    const { deps } = harness({ vitals: [] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("daemon_reach");
    expect(result.summary).toContain("listed no worker at all");
  });

  it("fails at connect when the lane exposes no worker_vitals to ask", async () => {
    const { deps } = harness({ tools: ["project_start", "project_status", "project_stop"] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("connect");
    expect(result.summary).toContain("worker_vitals");
  });
});

describe("MCP lane canary — the #2677 shape", () => {
  // The motivating bug: project_start answers with a supervisor pid, the
  // supervisor lives, and every slot dies before writing a worker directory.
  it("fails at worker_spawn when a returned pid produces no worker directory", async () => {
    const { deps } = harness({ observations: [[]] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.ok).toBe(false);
    expect(result.inertStep).toBe("worker_spawn");
    expect(result.summary).toContain("worker_spawn");
    expect(result.summary).toContain("no worker directory was ever written");
    expect(result.summary).toContain("#2677");
    // The steps BEFORE the inert one still read green — the failure is located,
    // not smeared across the lane.
    const byStep = new Map(result.steps.map((step) => [step.step, step.verdict]));
    expect(byStep.get("project_start")).toBe("ok");
    expect(byStep.get("supervisor_live")).toBe("ok");
    expect(byStep.get("project_status")).toBe("skipped");
  });

  it("refuses to accept a dead worker directory as drainage", async () => {
    const { deps } = harness({
      observations: [[worker({ alive: false })]],
      livePids: [SUPERVISOR_PID],
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("worker_spawn");
    expect(result.summary).toContain("only dead worker directories exist");
    expect(result.summary).toContain("wCAN1");
  });

  it("names the supervisor death when the fleet dies before its first worker", async () => {
    const { deps } = harness({ observations: [[]], livePids: [SUPERVISOR_PID] });
    // Alive for the supervisor_live check, dead on the next poll.
    let probes = 0;
    deps.isLive = (pid) => pid === SUPERVISOR_PID && probes++ < 1;

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("worker_spawn");
    expect(result.summary).toContain("died before any worker appeared");
  });

  it("tears the fleet down even when the lane went inert", async () => {
    const { deps, calls } = harness({ observations: [[]] });

    await runMcpLaneCanary(deps, OPTIONS);

    expect(calls.map((call) => call.tool)).toContain("project_stop");
  });
});

describe("MCP lane canary — the other inert steps", () => {
  it("fails at connect when the server is not the castle tool surface", async () => {
    const { deps } = harness({ tools: ["queue_status"] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("connect");
    expect(result.summary).toContain("project_start, project_status, project_stop");
    expect(result.steps.every((step) => step.verdict !== "ok")).toBe(true);
  });

  it("fails at project_start when the tool throws over the transport", async () => {
    const { deps } = harness();
    deps.callTool = vi.fn(async () => {
      throw new Error("MCP error -32603: registry write failed");
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_start");
    expect(result.summary).toContain("registry write failed");
  });

  it("fails at project_start when no supervisor pid comes back", async () => {
    const { deps } = harness({ create: { status: "launched" } });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_start");
    expect(result.summary).toContain("no supervisor pid");
  });

  it("fails at supervisor_live when the returned pid names no process", async () => {
    const { deps } = harness({ livePids: [WORKER_PID] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("supervisor_live");
    expect(result.summary).toContain("no such process is alive");
  });

  it("fails at project_status when the reader cannot see its own live worker", async () => {
    const { deps } = harness({
      status: {
        supervisor: { pid: SUPERVISOR_PID, alive: true },
        slots: { busy: 0, free: 1, total: 1, parked: 0 },
      },
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_status");
    expect(result.summary).toContain("slots.busy=0");
  });

  it("fails at project_status when reader and writer disagree about liveness", async () => {
    const { deps } = harness({
      status: { supervisor: { pid: SUPERVISOR_PID, alive: false }, slots: { busy: 1 } },
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_status");
    expect(result.summary).toContain("reader and writer disagree");
  });

  it("fails at project_stop when the canonical stop leaves the supervisor alive", async () => {
    const { deps } = harness({ diesOnStop: [WORKER_PID] });

    const result = await runMcpLaneCanary(deps, {
      ...OPTIONS,
      teardownDeadlineMs: 100,
    });

    expect(result.ok).toBe(false);
    expect(result.inertStep).toBe("project_stop");
    expect(result.summary).toContain(`supervisor ${SUPERVISOR_PID}`);
    expect(result.summary).toContain("survived");
  });

  it("fails at project_stop when the stop no-ops", async () => {
    const { deps } = harness({ stop: { status: "timeout", pid: SUPERVISOR_PID } });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, teardownDeadlineMs: 100 });

    expect(result.inertStep).toBe("project_stop");
    expect(result.summary).toContain("no-opped");
  });
});

describe("MCP lane canary target resolution", () => {
  // The canary is worthless against a source tree — it must launch the SHIPPED
  // bundle, which is the artifact #2677 lived in.
  it("canaries the running castle-mcp bundle itself", () => {
    expect(resolveShippedMcpEntry("/opt/red/dist/castle-mcp.bundle.min.mjs")).toBe(
      "/opt/red/dist/castle-mcp.bundle.min.mjs",
    );
    expect(resolveShippedMcpEntry("/opt/red/dist/castle-mcp-2.90.0.bundle.min.mjs")).toBe(
      "/opt/red/dist/castle-mcp-2.90.0.bundle.min.mjs",
    );
  });

  it("resolves the castle-mcp sibling when invoked from a dev bundle", () => {
    expect(resolveShippedMcpEntry("/opt/red/dist/dev.bundle.min.mjs")).toBe(
      "/opt/red/dist/castle-mcp.bundle.min.mjs",
    );
    expect(resolveShippedMcpEntry("/opt/red/dist/dev-2.90.0.bundle.min.mjs")).toBe(
      "/opt/red/dist/castle-mcp-2.90.0.bundle.min.mjs",
    );
  });

  it("parses the probe's tuning flags and refuses unknown ones", () => {
    const parsed = parseMcpLaneCanaryArgs(
      ["--runner", "codex", "--worker-deadline-ms", "9000"],
      "/scratch",
    );

    expect(parsed).toMatchObject({ runner: "codex", workerDeadlineMs: 9_000 });
    expect(parsed.root).toBe("/scratch");
    expect(() => parseMcpLaneCanaryArgs(["--nope"], "/scratch")).toThrow(/unknown flag/);
    expect(() => parseMcpLaneCanaryArgs(["--fleet", "probe"], "/scratch")).toThrow(/unknown flag/);
    expect(() => parseMcpLaneCanaryArgs(["--runner"], "/scratch")).toThrow(/requires a value/);
  });
});

describe("MCP lane canary report", () => {
  it("renders the walk as TOON with the inert step addressable", async () => {
    const { deps } = harness({ observations: [[]] });

    const rendered = renderMcpLaneCanaryToon(await runMcpLaneCanary(deps, OPTIONS));
    const decoded = decode(rendered) as {
      ok: boolean;
      inert_step: string;
      steps: { step: string; verdict: string }[];
    };

    expect(rendered).not.toContain("{\n");
    expect(decoded.ok).toBe(false);
    expect(decoded.inert_step).toBe("worker_spawn");
    expect(decoded.steps).toHaveLength(MCP_LANE_CANARY_STEPS.length);
  });
});
