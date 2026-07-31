// The canary's step contract. The e2e sibling proves the canary walks the real
// lane against real processes; this file pins WHAT each step asserts and that a
// red run names the step that went inert.
//
// Since #2902 the lane the canary walks is the two-player one: the MCP
// registers, the daemon drives. So the assertions below are about a
// REGISTRATION the daemon handed back — and about the absence of anything the
// project started for itself.
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

const STRAY_PID = 40_100;
const WORKER_PID = 40_200;
/** The session socket a canary walk is pinned to, as an operator would read it. */
const SOCKET = "/run/user/1000/redskilled/canary-session.sock";
/** The daemon's opaque label for the project under test. */
const PROJECT = "p_8f21c0";

function worker(overrides: Partial<CanaryWorker> = {}): CanaryWorker {
  return {
    worker: "wCAN1",
    dir: "/scratch/.red/tmp/workers/wCAN1",
    pid: WORKER_PID,
    alive: true,
    ...overrides,
  };
}

/** What `project_start` answers on a healthy lane: a registration, no process. */
function registered(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "registered",
    project: PROJECT,
    target: 1,
    runner: "claude",
    selector: "{}",
    argv: ["/usr/bin/node", "/opt/red/dist/dev.bundle.min.mjs", "run", "--once", "--runner", "claude"],
    socket: SOCKET,
    renew_by: "2026-07-31T05:30:00.000Z",
    ...overrides,
  };
}

interface HarnessOptions {
  tools?: readonly string[];
  create?: unknown;
  status?: unknown;
  stop?: unknown;
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
  const observations = options.observations ?? [[]];
  let scans = 0;
  const live = new Set(options.livePids ?? [STRAY_PID, WORKER_PID]);
  const diesOnStop = new Set(options.diesOnStop ?? [STRAY_PID, WORKER_PID]);
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
        return options.create ?? registered();
      }
      if (tool === "project_status") {
        return (
          options.status ?? {
            supervisor: { pid: null, alive: false },
            slots: { busy: 0, free: 0, total: 0, parked: 0 },
          }
        );
      }
      if (tool === "project_stop") {
        stopped = true;
        return options.stop ?? { status: "none", deregistered: true, project: PROJECT };
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
  runner: "claude",
  pollMs: 10,
  quietDeadlineMs: 100,
};

describe("MCP lane canary — green lane", () => {
  it("walks every step and reports the lane alive", async () => {
    const { deps, calls } = harness();

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.ok).toBe(true);
    expect(result.inertStep).toBeUndefined();
    expect(result.steps.map((step) => step.step)).toEqual([...MCP_LANE_CANARY_STEPS]);
    expect(result.steps.every((step) => step.verdict === "ok")).toBe(true);
    expect(result.registration?.project).toBe(PROJECT);
    expect(result.summary).toContain("green");
    // Green means the project holds a registration and NOTHING else: no worker
    // of its own ever appeared.
    expect(result.workers).toHaveLength(0);
    // The real tool surface was driven, in lane order.
    expect(calls.map((call) => call.tool)).toEqual([
      "project_start",
      "project_status",
      "project_stop",
    ]);
  });

  it("reports the registration the daemon handed back, verbatim", async () => {
    // ADR 0130 rule 3: the selector and the argv are the project's, carried
    // unread. The canary states what came back and asserts nothing about what it
    // should say beyond its existence.
    const { deps } = harness({
      create: registered({ selector: '{"labels":["ready-for-agent"]}' }),
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.registration?.selector).toBe('{"labels":["ready-for-agent"]}');
    expect(result.registration?.argv).toContain("run");
    expect(result.registration?.renewBy).toBe("2026-07-31T05:30:00.000Z");
    const step = result.steps.find((entry) => entry.step === "registration_held");
    expect(step?.verdict).toBe("ok");
    expect(step?.detail).toContain(PROJECT);
  });
});

describe("MCP lane canary — the registration is the whole presence (#2902)", () => {
  // The cutover's own assertion, and the inversion of #2677's: a `registered`
  // payload is not permission to have started something as well.
  it("fails at no_project_process when the start hands back a pid", async () => {
    const { deps } = harness({ create: registered({ pid: STRAY_PID }) });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, socketPath: SOCKET });

    expect(result.ok).toBe(false);
    expect(result.inertStep).toBe("no_project_process");
    expect(result.summary).toContain(`pid ${STRAY_PID}`);
    expect(result.summary).toContain("launched a process of the project's own");
    // The steps BEFORE the inert one still read green — the failure is located,
    // not smeared across the lane.
    const byStep = new Map(result.steps.map((step) => [step.step, step.verdict]));
    expect(byStep.get("project_start")).toBe("ok");
    expect(byStep.get("registration_held")).toBe("ok");
    expect(byStep.get("project_status")).toBe("skipped");
    // An inert lane still gives its registration back.
    expect(byStep.get("project_stop")).toBe("ok");
  });

  it("fails at no_project_process when a live worker appears under the project", async () => {
    const { deps } = harness({ observations: [[], [worker()]] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("no_project_process");
    expect(result.summary).toContain("wCAN1");
    expect(result.summary).toContain("unbudgeted birth");
    expect(result.workers).toHaveLength(1);
  });

  it("reads a dead worker directory as no process at all", async () => {
    // Only a LIVE process is a birth. A directory left by an earlier run is
    // litter, and failing on it would make the probe unusable on a real repo.
    const { deps } = harness({ observations: [[worker({ alive: false })]] });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.ok).toBe(true);
    expect(result.steps.find((step) => step.step === "no_project_process")?.verdict).toBe("ok");
  });

  it("fails at project_start when the lane still launches instead of registering", async () => {
    const { deps } = harness({ create: { status: "launched", pid: STRAY_PID, target: 1 } });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, socketPath: SOCKET });

    expect(result.inertStep).toBe("project_start");
    expect(result.summary).toContain("instead of registered");
    expect(result.summary).toContain(SOCKET);
  });
});

describe("MCP lane canary — the socket boundary (#2794, #2851)", () => {
  it("fails at project_start when no daemon answers, naming the socket", async () => {
    // ADR 0130 rule 6: a start that cannot reach the host refuses. The tool
    // throws the refusal, and the operator's next move is on that path — not on
    // the tool that reported it.
    const { deps } = harness();
    deps.callTool = vi.fn(async () => {
      throw new Error(`redskilled did not answer on ${SOCKET}: ECONNREFUSED`);
    });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, socketPath: SOCKET });

    expect(result.inertStep).toBe("project_start");
    expect(result.summary).toContain(SOCKET);
    expect(result.summary).toContain("ECONNREFUSED");
  });

  it("refuses a registration no daemon could have minted", async () => {
    // Only the daemon issues the project label: a payload without one proves
    // nothing crossed the socket, however healthy its `status` reads.
    const { deps } = harness({ create: registered({ project: "" }) });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, socketPath: SOCKET });

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("named no project");
    expect(result.summary).toContain(SOCKET);
  });

  it("still says which boundary broke when no socket path was resolved", async () => {
    // A canary that cannot resolve the path must not go quiet about the hop:
    // "unresolved" is itself an operator-routing fact.
    const { deps } = harness({ create: registered({ project: "" }) });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("redskilled session socket (path unresolved)");
  });
});

describe("MCP lane canary — a registration the host cannot act on", () => {
  it("fails when the registration carries no argv", async () => {
    const { deps } = harness({ create: registered({ argv: [] }) });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("carries no argv");
  });

  // The #2677 shape, moved one process out: then a slot entry that could not
  // route `run` spawned Workers that booted into nothing. Now the same fact
  // lives in the argv the host is committed to running.
  it("fails when the registered argv never routes `run`", async () => {
    const { deps } = harness({
      create: registered({ argv: ["/usr/bin/node", "/opt/red/dist/dev.bundle.min.mjs", "--once"] }),
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("never routes `run`");
    expect(result.summary).toContain("#2677");
  });

  it("fails when the registration carries no selector", async () => {
    const { deps } = harness({ create: registered({ selector: "" }) });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("carries no selector");
  });

  it("fails when the registration never lapses", async () => {
    const { deps } = harness({ create: registered({ renew_by: "" }) });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("registration_held");
    expect(result.summary).toContain("no renewal deadline");
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
      throw new Error("MCP error -32603: registration refused");
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_start");
    expect(result.summary).toContain("registration refused");
  });

  it("fails at project_status when the reader still sees a per-project supervisor", async () => {
    const { deps } = harness({
      status: { supervisor: { pid: STRAY_PID, alive: true }, slots: { busy: 0 } },
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_status");
    expect(result.summary).toContain(`supervisor pid ${STRAY_PID} alive`);
  });

  it("fails at project_status when the reader reports busy slots nothing started", async () => {
    const { deps } = harness({
      status: { supervisor: { pid: null, alive: false }, slots: { busy: 1, free: 0, total: 1 } },
    });

    const result = await runMcpLaneCanary(deps, OPTIONS);

    expect(result.inertStep).toBe("project_status");
    expect(result.summary).toContain("slots.busy=1");
  });

  it("fails at project_stop when the registration is not given back", async () => {
    const { deps } = harness({ stop: { status: "none", deregistered: false, project: PROJECT } });

    const result = await runMcpLaneCanary(deps, { ...OPTIONS, teardownDeadlineMs: 100 });

    expect(result.ok).toBe(false);
    expect(result.inertStep).toBe("project_stop");
    expect(result.summary).toContain("without deregistering");
    expect(result.summary).toContain(PROJECT);
  });

  it("fails at project_stop when a live worker survives the stop", async () => {
    // The worker appears only once the walk has stopped watching for one, so the
    // teardown is what has to catch it.
    const { deps } = harness({ observations: [[], [worker()]], diesOnStop: [] });

    const result = await runMcpLaneCanary(deps, {
      ...OPTIONS,
      quietDeadlineMs: 0,
      teardownDeadlineMs: 100,
    });

    expect(result.inertStep).toBe("project_stop");
    expect(result.summary).toContain("survived");
  });

  it("gives the registration back even when the lane went inert", async () => {
    const { deps, calls } = harness({ create: registered({ pid: STRAY_PID }) });

    await runMcpLaneCanary(deps, OPTIONS);

    expect(calls.map((call) => call.tool)).toContain("project_stop");
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
      ["--runner", "codex", "--quiet-deadline-ms", "9000"],
      "/scratch",
    );

    expect(parsed).toMatchObject({ runner: "codex", quietDeadlineMs: 9_000 });
    expect(parsed.root).toBe("/scratch");
    expect(() => parseMcpLaneCanaryArgs(["--nope"], "/scratch")).toThrow(/unknown flag/);
    expect(() => parseMcpLaneCanaryArgs(["--fleet", "probe"], "/scratch")).toThrow(/unknown flag/);
    expect(() => parseMcpLaneCanaryArgs(["--runner"], "/scratch")).toThrow(/requires a value/);
  });
});

describe("MCP lane canary report", () => {
  it("renders the walk as TOON with the inert step addressable", async () => {
    const { deps } = harness({ create: registered({ argv: [] }) });

    const rendered = renderMcpLaneCanaryToon(await runMcpLaneCanary(deps, OPTIONS));
    const decoded = decode(rendered) as {
      ok: boolean;
      inert_step: string;
      steps: { step: string; verdict: string }[];
    };

    expect(rendered).not.toContain("{\n");
    expect(decoded.ok).toBe(false);
    expect(decoded.inert_step).toBe("registration_held");
    expect(decoded.steps).toHaveLength(MCP_LANE_CANARY_STEPS.length);
  });

  it("renders the registration the walk produced", async () => {
    const { deps } = harness();

    const rendered = renderMcpLaneCanaryToon(await runMcpLaneCanary(deps, OPTIONS));
    const decoded = decode(rendered) as { registration: { project: string; argv: string[] } };

    expect(decoded.registration.project).toBe(PROJECT);
    expect(decoded.registration.argv).toContain("run");
  });
});
