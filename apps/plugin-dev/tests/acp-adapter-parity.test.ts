import { describe, expect, it, vi } from "vitest";
import type {
  RedskillsProjectAcpSession,
  RedskillsProjectControlSnapshot,
  RedskillsProjectStatusSnapshot,
} from "@reddb-io/redskilled/acp-client";
import {
  invokeProjectCli,
  invokeProjectMcp,
  invokeRedcodeProject,
} from "../src/project-acp-adapter.js";

function projectSession() {
  let revision = 0;
  let drainIntent: RedskillsProjectControlSnapshot["drain_intent"] = "inactive";
  const updates: Array<RedskillsProjectControlSnapshot["updates"][number]> = [];
  const emitted: string[] = [];
  const permission = vi.fn(async () => "approved" as const);
  const cancel = vi.fn(async () => undefined);

  const snapshot = (): RedskillsProjectControlSnapshot => ({
    version: 1,
    project_id: "R_project",
    project_label: "acme/widgets",
    workspace_path: "[DAEMON_WORKSPACE]",
    drain_intent: drainIntent,
    revision,
    updates: [...updates],
  });
  const statusSnapshot = (): RedskillsProjectStatusSnapshot => ({
    ...snapshot(),
    context: {
      version: 1,
      observed_at: "2026-08-17T15:00:00.000Z",
      queue: {
        posture: "queue-drained",
        depth: 0,
        target: 1,
        live: 0,
        wanted: 0,
        observed_at: "2026-08-17T14:59:59.000Z",
        age_ms: 1_000,
        freshness: "fresh",
        detail: "the Project queue is drained",
        // A drained queue is one the daemon actually polls, which it does only
        // for a registration.
        registered: true,
        // A drained queue listed nothing because there was nothing to list.
        items: [],
      },
      workers: {
        total: 0,
        freshness: "fresh",
        observed_at: "2026-08-17T15:00:00.000Z",
        items: [],
      },
      // No budget was declared for this drain, so the harvest deadline is inert.
      harvest: {
        state: "inert",
        budget_ms: null,
        harvest_fraction: null,
        harvest_at: null,
        deadline_at: null,
        harvested: 0,
        stranded: 0,
        detail: "no drain budget was declared, so no harvest deadline stands and admission is unchanged",
      },
      adapter_health: {
        status: "healthy",
        checked_at: "2026-08-17T14:59:59.000Z",
        last_success_at: "2026-08-17T14:59:59.000Z",
        last_failure_at: null,
        detail: "the daemon request lane answers",
      },
    },
  });
  const control = vi.fn(async (operation: "drain" | "stop" | "status") => {
    if (operation === "status") return statusSnapshot();
    revision += 1;
    drainIntent = operation === "drain" ? "draining" : "stopped";
    updates.push({ sequence: revision, operation, drain_intent: drainIntent });
    emitted.push("plan", "update");
    return snapshot();
  });
  const prompt = vi.fn(async (text: string) => {
    const operation = text === "/drain" ? "drain" : text === "/stop" ? "stop" : "status";
    return { stopReason: "end_turn" as const, projectControl: await control(operation), updates: [...emitted] };
  });

  return {
    session: { control, prompt, cancel, close: vi.fn(), permission } as unknown as RedskillsProjectAcpSession,
    control,
    prompt,
    cancel,
    permission,
  };
}

describe("ACP Project adapter parity", () => {
  it("projects equivalent drain and status outcomes through ACP core, typed MCP, CLI, and Redcode", async () => {
    const generic = projectSession();
    const mcp = projectSession();
    const cli = projectSession();
    const redcode = projectSession();

    const coreDrain = await generic.session.prompt("/drain");
    const mcpDrain = await invokeProjectMcp(mcp.session, "drain", {});
    const cliDrain = await invokeProjectCli(cli.session, ["project", "drain"]);
    const redcodeDrain = await invokeRedcodeProject(redcode.session, "/drain");

    expect(mcpDrain).toEqual(coreDrain.projectControl);
    expect(cliDrain).toEqual(coreDrain.projectControl);
    expect(redcodeDrain.projectControl).toEqual(coreDrain.projectControl);

    const coreStatus = await generic.session.prompt("/status");
    const mcpStatus = await invokeProjectMcp(mcp.session, "project_status", {});
    const cliStatus = await invokeProjectCli(cli.session, ["project", "status"]);
    const redcodeStatus = await invokeRedcodeProject(redcode.session, "/status");
    expect(mcpStatus).toEqual(coreStatus.projectControl);
    expect(cliStatus).toEqual(coreStatus.projectControl);
    expect(redcodeStatus.projectControl).toEqual(coreStatus.projectControl);
    expect(mcpStatus).toMatchObject({
      context: {
        queue: { depth: 0, freshness: "fresh" },
        workers: { total: 0, freshness: "fresh" },
        adapter_health: { status: "healthy" },
      },
    });
    // The MCP call carries a request object even when it is empty: the control
    // surface takes what the caller asked for, and "nothing" is an answer too.
    expect(mcp.control).toHaveBeenCalledWith("drain", {});
    expect(cli.control).toHaveBeenCalledWith("drain");
    expect(redcode.prompt).toHaveBeenCalledWith("/drain");
  });

  it("keeps cancellation, permissions, and ordered updates on the ACP session", async () => {
    const client = projectSession();
    await invokeProjectCli(client.session, ["project", "cancel"]);
    expect(client.cancel).toHaveBeenCalledOnce();

    await client.session.permission({
      sessionId: "session",
      toolCall: { toolCallId: "call", title: "publish", kind: "execute" },
      options: [{ optionId: "once", name: "Allow once", kind: "allow_once" }],
    });
    expect(client.permission).toHaveBeenCalledOnce();

    const result = await invokeRedcodeProject(client.session, "/drain");
    expect(result.updates).toEqual(["plan", "update"]);
  });

  it("rejects adapter-private workflow operations instead of falling back", async () => {
    const client = projectSession();
    await expect(invokeProjectMcp(client.session, "private_worker_birth", {}))
      .rejects.toThrow(/ACP Project capability/);
    await expect(invokeProjectCli(client.session, ["project", "github", "issues"]))
      .rejects.toThrow(/ACP Project command/);
  });
});

describe("a control tool with arguments stays a control call", () => {
  it("routes a width to the control method instead of rendering it as prose", async () => {
    const calls: Array<{ operation: string; request: unknown }> = [];
    const session = {
      control: async (operation: string, request?: unknown) => {
        calls.push({ operation, request });
        return { version: 1, drain_intent: "draining" };
      },
      prompt: async () => {
        throw new Error("a control tool must not reach the prompt path");
      },
    } as never;

    await invokeProjectMcp(session, "drain", { target: 2, runner: "redcode" });

    expect(calls).toEqual([{ operation: "drain", request: { target: 2, runner: "redcode" } }]);
  });

  it("refuses an argument the control surface cannot express, rather than dropping it", async () => {
    const session = {
      control: async () => ({ version: 1 }),
      prompt: async () => {
        throw new Error("a control tool must not reach the prompt path");
      },
    } as never;

    await expect(invokeProjectMcp(session, "drain", { selector: { label: "ready-for-agent" } }))
      .rejects.toThrow(/cannot express \["selector"\]/);
  });
});

describe("read shaping is not a refusal", () => {
  it("accepts the fields `status` declares, and still refuses what the surface cannot express", async () => {
    const control = vi.fn(async () => ({ version: 1 }));
    const session = { control, prompt: async () => { throw new Error("not the prompt path"); } } as never;

    await invokeProjectMcp(session, "status", { scope: "project", live_only: true });
    expect(control).toHaveBeenCalledWith("status");

    await expect(invokeProjectMcp(session, "drain", { selector: { label: "x" } }))
      .rejects.toThrow(/cannot express/);
  });
});
