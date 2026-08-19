import { describe, expect, it, vi } from "vitest";
import {
  createCastleMcpTools,
  type CastleMcpDependencies,
} from "../src/mcp-tools/index.js";
import {
  CASTLE_MCP_CONTRACT_VERSION,
  applyOutputContracts,
  projectStatusOutputSchema,
  monitorOutputSchema,
  queueStatusOutputSchema,
  workerVitalsContract,
  workerVitalsOutputSchema,
  type ProjectStatusOutput,
} from "../src/mcp-tools/contracts.js";
import type { CastleMcpTool } from "../src/mcp-tools/tool.js";

const PROJECT_STATUS: ProjectStatusOutput = {
  validation_schedule: {
    narration: "Validation moments — iteration: skip (undeclared); post_done: skip (undeclared); landing: skip (undeclared)",
    moments: [
      { moment: "iteration", state: "skip", declared: false, commands: [] },
      { moment: "post_done", state: "skip", declared: false, commands: [] },
      { moment: "landing", state: "skip", declared: false, commands: [] },
    ],
  },
  registration: {
    held: true,
    daemon_reachable: true,
    project: "red-skills",
    socket: "/run/redskilled.sock",
    selector: "{}",
    target: 2,
    renewal: "renewing" as const,
    renew_by: "2026-07-31T05:30:00.000Z",
    renewals: 3,
    lapsed_at: "",
    reason: "",
    launch_revision: 0,
    bundle_version: "3.3.24",
    plugin_cache_version: "3.3.21",
  },
  birth_latch: null,
  slots: { busy: 1, free: 1, parked: 0, total: 2, interactive_reservation: 1 },
  live_workers: [
    { id: "worker-1", pid: 43, issue: "2305", activity: "impl", origin: "afk" },
  ],
  unattributed_workers: [
    { id: "worker-2", pid: 44, issue: "2306", activity: "impl", origin: "afk" },
    { id: "worker-3", pid: 45, issue: "2307", activity: "review", origin: "go" },
  ],
};

function tool(output: unknown): CastleMcpTool {
  return {
    name: "project_status",
    title: "Get project worker status",
    description: "…",
    inputSchema: {},
    outputContract: {
      version: CASTLE_MCP_CONTRACT_VERSION,
      schema: projectStatusOutputSchema,
    },
    invoke: async () => output,
  };
}

describe("observability output contracts", () => {
  it("keeps all three engine delivery lanes in project status", () => {
    expect(PROJECT_STATUS.registration).toMatchObject({
      bundle_version: "3.3.24",
      plugin_cache_version: "3.3.21",
    });
    const { bundle_version: _bundle, ...withoutBundle } = PROJECT_STATUS.registration;
    expect(projectStatusOutputSchema.safeParse({
      ...PROJECT_STATUS,
      registration: withoutBundle,
    }).success).toBe(false);
  });

  it("carries the interactive reservation beside every slot count", () => {
    expect(projectStatusOutputSchema.parse(PROJECT_STATUS).slots.interactive_reservation).toBe(1);
  });

  it("requires the narrated Validation moment schedule", () => {
    const { validation_schedule: _schedule, ...withoutSchedule } = PROJECT_STATUS;
    expect(projectStatusOutputSchema.safeParse(withoutSchedule).success).toBe(false);
  });

  it("declares a versioned contract on every observability tool", () => {
    const tools = createCastleMcpTools({} as CastleMcpDependencies);
    const contracted = [
      "status",
      "project_status",
      "queue_status",
    ];

    for (const name of contracted) {
      const declared = tools.find((t) => t.name === name)?.outputContract;
      expect(declared, name).toBeDefined();
      expect(declared?.version).toBe(CASTLE_MCP_CONTRACT_VERSION);
    }
  });

  it("passes a conforming payload through byte-identically", async () => {
    const withExtra = { ...PROJECT_STATUS, experimental_note: "additive" };
    const [wrapped] = applyOutputContracts([tool(withExtra)]);

    // Unknown keys survive: validation is enforcement, never serialization.
    await expect(wrapped!.invoke({})).resolves.toBe(withExtra);
  });

  it("turns shape drift into a named, located error", async () => {
    const drifted = {
      ...PROJECT_STATUS,
      slots: { ...PROJECT_STATUS.slots, total: "2" },
    };
    const [wrapped] = applyOutputContracts([tool(drifted)]);

    await expect(wrapped!.invoke({})).rejects.toThrow(
      /project_status output violates contract 2\.0\.0: slots\.total/,
    );
  });

  it("relaxes presence — never type — for a projected call", async () => {
    const projected: CastleMcpTool = {
      name: "worker_vitals",
      title: "Read worker vitals",
      description: "…",
      inputSchema: {},
      outputContract: workerVitalsContract,
      invoke: async (input) =>
        (input.fields as string[] | undefined)?.length
          ? [{ live: true, liveness: "active" }]
          : [],
    };
    const [wrapped] = applyOutputContracts([projected]);

    await expect(
      wrapped!.invoke({ fields: ["live", "liveness"] }),
    ).resolves.toEqual([{ live: true, liveness: "active" }]);
    // An empty projection is no projection: the full shape still applies.
    await expect(wrapped!.invoke({ fields: [] })).resolves.toEqual([]);
  });

  it("still rejects a projected field carrying the wrong type", async () => {
    const drifted: CastleMcpTool = {
      name: "worker_vitals",
      title: "Read worker vitals",
      description: "…",
      inputSchema: {},
      outputContract: workerVitalsContract,
      invoke: async () => [{ live: "yes" }],
    };
    const [wrapped] = applyOutputContracts([drifted]);

    await expect(wrapped!.invoke({ fields: ["live"] })).rejects.toThrow(
      /worker_vitals output violates contract 2\.0\.0: 0\.live/,
    );
  });

  it("leaves an uncontracted tool untouched", async () => {
    const uncontracted: CastleMcpTool = {
      name: "history",
      title: "Read Castle history",
      description: "…",
      inputSchema: {},
      invoke: async () => "anything at all",
    };
    const [wrapped] = applyOutputContracts([uncontracted]);

    expect(wrapped).toBe(uncontracted);
    await expect(wrapped!.invoke({})).resolves.toBe("anything at all");
  });

  it("validates the observability payloads a live tool call returns", async () => {
    const deps = {
      projectStatus: vi.fn(async () => PROJECT_STATUS),
      workerStatus: vi.fn(async () => []),
      workerVitals: vi.fn(async () => []),
      monitor: vi.fn(async () => ({ workers: [], events: [], fleet: null })),
      queueStatus: vi.fn(async () => ({
        ready_for_agent: {
          eligible: [{ number: 2335, title: "E1", labels: ["type:ticket"] }],
          held_for_summon: [],
        },
        ready_for_human: [],
        counts: {
          ready_for_agent_eligible: 1,
          ready_for_agent_held: 0,
          ready_for_human: 0,
        },
        degraded: false,
        errors: [],
      })),
    } as unknown as CastleMcpDependencies;
    const tools = createCastleMcpTools(deps);
    const invoke = (name: string, input: Record<string, unknown> = {}) =>
      tools.find((t) => t.name === name)!.invoke(input);

    expect(
      projectStatusOutputSchema.safeParse(
        await invoke("status", { scope: "project" }),
      ).success,
    ).toBe(true);
    const workers = await invoke("status", { scope: "worker" }) as {
      vitals: unknown;
      monitor: unknown;
    };
    expect(
      workerVitalsOutputSchema.safeParse(workers.vitals).success,
    ).toBe(true);
    expect(monitorOutputSchema.safeParse(workers.monitor).success).toBe(
      true,
    );
    expect(
      queueStatusOutputSchema.safeParse(await invoke("queue_status")).success,
    ).toBe(true);
  });
});
