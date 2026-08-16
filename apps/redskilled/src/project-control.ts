import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  methods,
  type AgentConnection,
} from "@agentclientprotocol/sdk";
import * as acpV2 from "@agentclientprotocol/sdk/experimental/v2";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import type { AcpProjectWorkspace } from "./project-workspace.js";

export const PROJECT_CONTROL_METHODS = [
  "_redskills/project_drain",
  "_redskills/project_stop",
  "_redskills/project_status",
] as const;

export type ProjectControlOperation = "drain" | "stop";
type ProjectDrainIntent = "inactive" | "draining" | "stopped";
export type ProjectControlOperationStatus = "draining" | "already-draining" | "stopped" | "already-stopped";

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

interface ProjectControlStoreSnapshot {
  readonly version: 1;
  readonly projects: readonly {
    readonly project_id: string;
    readonly state: ProjectControlState;
  }[];
}

export interface ProjectControlStore {
  read(): Promise<Map<string, ProjectControlState>>;
  replace(projects: ReadonlyMap<string, ProjectControlState>): Promise<void>;
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

export async function applyProjectControl(
  project: AcpProjectWorkspace,
  operation: ProjectControlOperation,
  projectControls: Map<string, ProjectControlState>,
  persist: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
) {
  const held = projectControls.get(project.projectId);
  if (held == null && operation === "stop") {
    return { ...projectControlSnapshot(project, projectControls), status: "already-stopped" as const };
  }
  const observed = held ?? {
    drainIntent: "inactive" as const,
    revision: 0,
    updates: [],
  };
  const requestedIntent = operation === "drain" ? "draining" as const : "stopped" as const;
  if (observed.drainIntent === requestedIntent) {
    const status = operation === "drain" ? "already-draining" as const : "already-stopped" as const;
    return { ...projectControlSnapshot(project, projectControls), status };
  }
  const revision = observed.revision + 1;
  const next = new Map(projectControls);
  next.set(project.projectId, {
    drainIntent: requestedIntent,
    revision,
    updates: [...observed.updates, { sequence: revision, operation, drain_intent: requestedIntent }],
  });
  await persist(next);
  projectControls.set(project.projectId, next.get(project.projectId)!);
  return { ...projectControlSnapshot(project, projectControls), status: requestedIntent };
}

export function projectControlStorePath(registrationIntentPath: string): string {
  return join(dirname(registrationIntentPath), "redskilled.project-control.toon");
}

export function createProjectControlStore(path: string): ProjectControlStore {
  let tail: Promise<void> = Promise.resolve();

  return {
    async read() {
      await tail;
      let raw: string;
      try {
        raw = await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
        throw error;
      }
      const parsed = parseStoreSnapshot(raw);
      if (!isStoreSnapshot(parsed)) return new Map();
      return new Map(parsed.projects.map(({ project_id, state }) => [project_id, state]));
    },
    replace(projects) {
      const snapshot: ProjectControlStoreSnapshot = {
        version: 1,
        projects: [...projects].map(([project_id, state]) => ({ project_id, state })),
      };
      tail = tail.then(async () => {
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
        await writeFile(temporary, `${encode(snapshot as unknown as JsonValue)}\n`, {
          encoding: "utf8",
          mode: 0o600,
        });
        await rename(temporary, path);
      });
      return tail;
    },
  };
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
  control: Awaited<ReturnType<typeof applyProjectControl>>,
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
  persist: (projects: ReadonlyMap<string, ProjectControlState>) => Promise<void>,
): Promise<void> {
  const session = sessions.get(params.sessionId);
  if (session == null) return;
  const control = await applyProjectControl(session.project, operation, projectControls, persist);
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

function parseStoreSnapshot(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return decode(body);
  } catch {
    try {
      return JSON.parse(body) as unknown;
    } catch {
      return null;
    }
  }
}

function isStoreSnapshot(value: unknown): value is ProjectControlStoreSnapshot {
  const snapshot = record(value);
  return snapshot?.version === 1 &&
    Array.isArray(snapshot.projects) &&
    snapshot.projects.every((entry) => {
      const project = record(entry);
      const state = record(project?.state);
      return typeof project?.project_id === "string" &&
        (state?.drainIntent === "inactive" || state?.drainIntent === "draining" || state?.drainIntent === "stopped") &&
        typeof state.revision === "number" &&
        Array.isArray(state.updates);
    });
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
