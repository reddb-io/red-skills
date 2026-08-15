import {
  methods,
  type AgentConnection,
} from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import type { AcpProjectWorkspace } from "./project-workspace.js";

export const PROJECT_CONTROL_METHODS = [
  "_redskills/project_drain",
  "_redskills/project_stop",
  "_redskills/project_status",
] as const;

export type ProjectControlOperation = "drain" | "stop";
type ProjectDrainIntent = "inactive" | "draining" | "stopped";

interface ProjectControlUpdate {
  readonly sequence: number;
  readonly operation: ProjectControlOperation;
  readonly drain_intent: Exclude<ProjectDrainIntent, "inactive">;
}

export interface ProjectControlState {
  readonly drainIntent: ProjectDrainIntent;
  readonly revision: number;
  readonly updates: readonly ProjectControlUpdate[];
}

interface ProjectControlSession {
  readonly project: AcpProjectWorkspace;
}

export function projectControlSnapshot(
  project: AcpProjectWorkspace,
  projectControls: Map<string, ProjectControlState>,
) {
  const control = projectControls.get(project.projectId) ?? {
    drainIntent: "inactive" as const,
    revision: 0,
    updates: [],
  };
  return {
    version: 1 as const,
    project_id: project.projectId,
    project_label: project.projectLabel,
    workspace_path: project.workspacePath,
    drain_intent: control.drainIntent,
    revision: control.revision,
    updates: [...control.updates],
  };
}

export function applyProjectControl(
  project: AcpProjectWorkspace,
  operation: ProjectControlOperation,
  projectControls: Map<string, ProjectControlState>,
) {
  const held = projectControls.get(project.projectId) ?? {
    drainIntent: "inactive" as const,
    revision: 0,
    updates: [],
  };
  const requestedIntent = operation === "drain" ? "draining" as const : "stopped" as const;
  if (held.drainIntent === requestedIntent) return projectControlSnapshot(project, projectControls);
  const revision = held.revision + 1;
  projectControls.set(project.projectId, {
    drainIntent: requestedIntent,
    revision,
    updates: [...held.updates, { sequence: revision, operation, drain_intent: requestedIntent }],
  });
  return projectControlSnapshot(project, projectControls);
}

export function coreProjectOperation(prompt: unknown): ProjectControlOperation | undefined {
  const text = promptBlocksText(prompt).trim().toLowerCase();
  if (text === "/drain" || text === "drain") return "drain";
  if (text === "/stop" || text === "stop" || text === "/project_stop") return "stop";
  return undefined;
}

function promptBlocksText(prompt: unknown): string {
  if (!Array.isArray(prompt)) return "";
  return prompt
    .map((block) => record(block))
    .filter((block): block is Record<string, unknown> => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("\n");
}

export async function notifyV1ProjectControl(
  upstream: AgentConnection["client"],
  sessionId: string,
  operation: ProjectControlOperation,
  control: ReturnType<typeof projectControlSnapshot>,
): Promise<void> {
  await upstream.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "plan",
      entries: [{
        content: `${operation === "drain" ? "Continue" : "Stop"} the Project drain`,
        priority: "high",
        status: "completed",
      }],
    },
  });
  await upstream.notify(methods.client.session.update, {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `Project drain intent is ${control.drain_intent} at revision ${control.revision}\n`,
      },
    },
  });
}

export async function runV2ProjectControlTurn(
  sessions: ReadonlyMap<string, ProjectControlSession>,
  params: acpV2.PromptRequest,
  upstream: acpV2.AgentContext,
  operation: ProjectControlOperation,
  projectControls: Map<string, ProjectControlState>,
): Promise<void> {
  const session = sessions.get(params.sessionId);
  if (session == null) return;
  const control = applyProjectControl(session.project, operation, projectControls);
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: {
      sessionUpdate: "plan_update",
      plan: {
        type: "items",
        planId: "project-control",
        entries: [{
          content: `${operation === "drain" ? "Continue" : "Stop"} the Project drain`,
          priority: "high",
          status: "completed",
        }],
      },
    },
  });
  await upstream.notify(acpV2.methods.client.session.update, {
    sessionId: params.sessionId,
    update: { sessionUpdate: "state_update", state: "idle", stopReason: "end_turn" },
    _meta: { redskills: { authority: "redskilled", projectControl: control } },
  });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
