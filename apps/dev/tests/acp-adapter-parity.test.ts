import { describe, expect, it, vi } from "vitest";
import type {
  RedskillsProjectAcpSession,
  RedskillsProjectControlSnapshot,
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
  const control = vi.fn(async (operation: "drain" | "stop" | "status") => {
    if (operation !== "status") {
      revision += 1;
      drainIntent = operation === "drain" ? "draining" : "stopped";
      updates.push({ sequence: revision, operation, drain_intent: drainIntent });
      emitted.push("plan", "update");
    }
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
    expect(await invokeProjectMcp(mcp.session, "project_status", {}))
      .toEqual(await invokeProjectCli(cli.session, ["project", "status"]));
    expect(mcp.control).toHaveBeenCalledWith("drain");
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
