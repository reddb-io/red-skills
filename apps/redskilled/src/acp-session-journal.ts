/**
 * Durable public ACP session evidence owned by redskilled.
 *
 * This is deliberately not a provider transcript. It retains only inputs and
 * updates visible at the public ACP boundary plus daemon-owned Worker pointers
 * and completed-turn checkpoints. In particular, `agent_thought_chunk` is
 * never admitted to the journal or to a replacement checkpoint.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  methods,
  type AgentConnection,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import type { AcpProjectWorkspace } from "./project-workspace.js";

export type AcpSessionJournalEntry =
  | { readonly sequence: number; readonly kind: "prompt"; readonly prompt: PromptRequest["prompt"] }
  | { readonly sequence: number; readonly kind: "plan"; readonly update: SessionNotification["update"] }
  | {
    readonly sequence: number;
    readonly kind: "workflow-pointer";
    readonly worker_id: string;
    readonly worker_session_id: string;
    readonly replacement: boolean;
  }
  | {
    readonly sequence: number;
    readonly kind: "checkpoint";
    readonly stop_reason: PromptResponse["stopReason"];
    readonly workflow_outcome?: string;
  };

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;
type AcpSessionJournalEntryInput = WithoutSequence<AcpSessionJournalEntry>;

export interface AcpSessionJournalRecord {
  readonly public_session_id: string;
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly entries: readonly AcpSessionJournalEntry[];
}

interface AcpSessionJournalSnapshot {
  readonly version: 1;
  readonly sessions: readonly AcpSessionJournalRecord[];
}

export interface AcpSessionRecoveryCheckpoint {
  readonly version: 1;
  readonly source: "redskilled-public-journal";
  readonly public_session_id: string;
  readonly completed_turns: number;
  readonly entries: readonly AcpSessionJournalEntry[];
}

export interface AcpSessionJournal {
  create(publicSessionId: string, project: AcpProjectWorkspace): Promise<void>;
  prompt(publicSessionId: string, prompt: PromptRequest["prompt"]): Promise<void>;
  update(publicSessionId: string, update: SessionNotification["update"]): Promise<void>;
  worker(
    publicSessionId: string,
    workerId: string,
    workerSessionId: string,
    replacement: boolean,
  ): Promise<void>;
  checkpoint(publicSessionId: string, response: PromptResponse, workflowOutcome?: string): Promise<void>;
  recovery(publicSessionId: string): AcpSessionRecoveryCheckpoint;
}

export function acpSessionJournalPath(registrationIntentPath: string): string {
  return join(dirname(registrationIntentPath), "redskilled.acp-sessions.toon");
}

export async function createAcpSessionJournal(path: string): Promise<AcpSessionJournal> {
  const sessions = await readSnapshot(path);
  let tail: Promise<void> = Promise.resolve();

  const persist = (): Promise<void> => {
    const snapshot: AcpSessionJournalSnapshot = { version: 1, sessions: [...sessions.values()] };
    tail = tail.then(() => writeSnapshot(path, snapshot));
    return tail;
  };

  const append = (publicSessionId: string, entry: AcpSessionJournalEntryInput): Promise<void> => {
    const held = sessions.get(publicSessionId);
    if (held == null) throw new Error("unknown durable RedSkills ACP session");
    sessions.set(publicSessionId, {
      ...held,
      entries: [...held.entries, { ...entry, sequence: held.entries.length + 1 } as AcpSessionJournalEntry],
    });
    return persist();
  };

  return {
    create(publicSessionId, project) {
      sessions.set(publicSessionId, {
        public_session_id: publicSessionId,
        project_id: project.projectId,
        project_label: project.projectLabel,
        workspace_path: project.workspacePath,
        entries: [],
      });
      return persist();
    },
    prompt(publicSessionId, prompt) {
      return append(publicSessionId, { kind: "prompt", prompt });
    },
    update(publicSessionId, update) {
      // Plans are public recovery authority. Message chunks remain public on the
      // live wire but are not needed to reconstruct work, and thought chunks are
      // intentionally never persisted.
      if (update.sessionUpdate !== "plan") return Promise.resolve();
      return append(publicSessionId, { kind: "plan", update });
    },
    worker(publicSessionId, workerId, workerSessionId, replacement) {
      return append(publicSessionId, {
        kind: "workflow-pointer",
        worker_id: workerId,
        worker_session_id: workerSessionId,
        replacement,
      });
    },
    checkpoint(publicSessionId, response, workflowOutcome) {
      return append(publicSessionId, {
        kind: "checkpoint",
        stop_reason: response.stopReason,
        ...(workflowOutcome == null ? {} : { workflow_outcome: workflowOutcome }),
      });
    },
    recovery(publicSessionId) {
      const held = sessions.get(publicSessionId);
      if (held == null) throw new Error("unknown durable RedSkills ACP session");
      return {
        version: 1,
        source: "redskilled-public-journal",
        public_session_id: publicSessionId,
        completed_turns: held.entries.filter((entry) => entry.kind === "checkpoint").length,
        entries: [...held.entries],
      };
    },
  };
}

export function replacementRecoveryMeta(
  meta: NewSessionRequest["_meta"],
  recovery: AcpSessionRecoveryCheckpoint,
): NonNullable<NewSessionRequest["_meta"]> {
  const redskills = (meta as { redskills?: object } | undefined)?.redskills ?? {};
  return {
    ...(meta ?? {}),
    redskills: { ...redskills, recovery },
  };
}

export function sessionRecoveryFromMeta(meta: NewSessionRequest["_meta"]): AcpSessionRecoveryCheckpoint | undefined {
  const recovery = (meta as { redskills?: { recovery?: AcpSessionRecoveryCheckpoint } } | undefined)
    ?.redskills?.recovery;
  return recovery?.source === "redskilled-public-journal" ? recovery : undefined;
}

export async function notifySessionRecovery(
  parent: AgentConnection["client"],
  downstreamSessionId: string,
  recovery: AcpSessionRecoveryCheckpoint,
): Promise<void> {
  const turns = recovery.completed_turns;
  await parent.notify(methods.client.session.update, {
    sessionId: downstreamSessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: {
        type: "text",
        text: `native Worker resumed ${turns} completed turn${turns === 1 ? "" : "s"} from the public journal\n`,
      },
    },
    _meta: { redskills: { lifecycle: { event: "checkpoint-resume" } } },
  });
}

async function readSnapshot(path: string): Promise<Map<string, AcpSessionJournalRecord>> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Map();
    throw error;
  }
  const parsed = parseSnapshot(raw);
  if (!isSnapshot(parsed)) return new Map();
  return new Map(parsed.sessions.map((session) => [session.public_session_id, session]));
}

async function writeSnapshot(path: string, snapshot: AcpSessionJournalSnapshot): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${encode(snapshot as unknown as JsonValue)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(temporary, path);
}

function parseSnapshot(raw: string): unknown {
  const body = raw.trim();
  if (!body) return null;
  try {
    return decode(body);
  } catch {
    return null;
  }
}

function isSnapshot(value: unknown): value is AcpSessionJournalSnapshot {
  if (value == null || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.version === 1 && Array.isArray(snapshot.sessions) && snapshot.sessions.every((candidate) => {
    if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) return false;
    const session = candidate as Record<string, unknown>;
    return typeof session.public_session_id === "string" &&
      typeof session.project_id === "string" &&
      typeof session.project_label === "string" &&
      typeof session.workspace_path === "string" &&
      Array.isArray(session.entries);
  });
}
