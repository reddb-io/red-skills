import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const host = vi.hoisted(() => ({
  registrationState: vi.fn(),
  workerBirths: vi.fn(async () => ({})),
  interactiveReservation: vi.fn(async () => 1),
  hostState: vi.fn(),
}));

const github = vi.hoisted(() => ({ calls: 0 }));

vi.mock("../src/runtime/redskilled-birth.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/redskilled-birth.js")>();
  return {
    ...actual,
    createRedskilledBirthPort: () => ({
      projectLabel: "acme/widgets",
      socketPath: "/fake/redskilled.sock",
      registrationState: host.registrationState,
      workerBirths: host.workerBirths,
      interactiveReservation: host.interactiveReservation,
      hostState: host.hostState,
    }),
  };
});

// Help is a socket-local hot path. Any GitHub transport reached by the adapter
// is a test failure, even if a caller later catches and hides that failure.
vi.mock("../src/runtime/gh.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/runtime/gh.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function"
        ? (..._args: unknown[]) => {
            github.calls += 1;
            throw new Error(`help reached GitHub through ${name}`);
          }
        : value,
    ]),
  );
});

import { createCastleMcpTools } from "@reddb-io/red-castle/mcp-server";
import { createCastleMcpDependencies } from "../src/mcp-adapter.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  vi.clearAllMocks();
  github.calls = 0;
});

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dev-mcp-help-"));
  roots.push(root);
  return root;
}

function heldRegistration(root: string) {
  return {
    version: 1 as const,
    project_label: "acme/widgets",
    selector: 'repo:acme/widgets is:issue is:open label:"ready-for-agent"',
    argv: ["red-skills-dev", "run", "--once"],
    workspace_path: root,
    env: {},
    target: 2,
    registered_at: "2026-08-04T18:00:00.000Z",
    renew_within_ms: 300_000,
    renew_by: "2026-08-04T18:10:00.000Z",
    renewed_at: "2026-08-04T18:05:00.000Z",
    renewals: 1,
    launch_revision: 0,
    renewal: "renewing" as const,
    last_poll: {
      at: "2026-08-04T18:05:00.000Z",
      outcome: "counted" as const,
      depth: 3,
      request_count: 1,
      detail: "counted 3 ready Tickets",
    },
  };
}

describe("castle MCP help", () => {
  it("answers an unregistered project with the composed, pasteable registration repair", async () => {
    const root = await scratch();
    host.registrationState.mockResolvedValue({ held: null, lapse: null });
    host.hostState.mockResolvedValue({ daemon_version: "3.4.2", demand: null });
    const tools = createCastleMcpTools(createCastleMcpDependencies(root));
    const help = tools.find((tool) => tool.name === "help")!;

    await expect(help.invoke({})).resolves.toMatchObject({
      here: expect.stringMatching(/unregistered/i),
      state: {
        daemon: { reachable: true, version: "3.4.2" },
        registration: { held: false, project: "acme/widgets", target: 0 },
        workers: { busy: 0, live: 0, target: 0 },
        last_refusal: null,
      },
      guidance: expect.stringContaining('call `project_start` with `{"runner":"claude","target":1}`'),
      next: {
        tool: "project_start",
        args: { runner: "claude", target: 1 },
        why: "register this project with the host so its queue can drain",
      },
    });
    expect(github.calls).toBe(0);
  });

  it("reports a healthy drain and generates its complete intent map from the live tool table", async () => {
    const root = await scratch();
    const registration = heldRegistration(root);
    host.registrationState.mockResolvedValue({ held: registration, lapse: null });
    host.hostState.mockResolvedValue({
      daemon_version: "3.4.2",
      demand: {
        refusal: "host ceiling is temporarily full",
        retry_after: "2026-08-04T18:06:00.000Z",
      },
    });
    const tools = createCastleMcpTools(createCastleMcpDependencies(root));
    const help = tools.find((tool) => tool.name === "help")!;

    const answer = await help.invoke({}) as {
      here: string;
      state: Record<string, unknown>;
      next: { tool: string; args: Record<string, unknown> };
      intent_map: Array<{ intent: string; tools: Array<{ name: string; title: string }> }>;
    };

    expect(answer).toMatchObject({
      here: expect.stringMatching(/draining/i),
      state: {
        daemon: { reachable: true, version: "3.4.2" },
        registration: { held: true, project: "acme/widgets", target: 2 },
        queue: { outcome: "counted", depth: 3 },
        workers: { busy: 0, live: 0, target: 2 },
        last_refusal: "host ceiling is temporarily full",
      },
      next: { tool: "project_status", args: {} },
    });

    const advertised = answer.intent_map.flatMap((group) => group.tools);
    expect(advertised.map(({ name }) => name)).toEqual(tools.map(({ name }) => name));
    expect(advertised.map(({ title }) => title)).toEqual(tools.map(({ title }) => title));
    expect(github.calls).toBe(0);
  });
});
