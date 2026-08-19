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
import type {
  PromptRequest,
  PromptResponse,
  RequestPermissionRequest,
  SessionNotification,
} from "@agentclientprotocol/sdk";
import { decode, encode, type JsonValue } from "@reddb-io/toon";
import {
  notifySessionRecovery,
  replacementRecoveryMeta,
  sessionRecoveryFromMeta,
  type AcpSessionJournalEntry,
  type AcpSessionRecoveryCheckpoint,
} from "@reddb-io/protocol-acp";
import type { AcpProjectWorkspace } from "./project-workspace.js";

// The entry union and the replacement checkpoint travel to a Worker inside
// `_meta`, so they are declared on the shared wire (ADR 0148) and re-exported
// here. The journal itself — the durable file, its snapshot and its append
// path — is control plane and stays behind the daemon.
export {
  notifySessionRecovery,
  replacementRecoveryMeta,
  sessionRecoveryFromMeta,
  type AcpSessionJournalEntry,
  type AcpSessionRecoveryCheckpoint,
};

type WithoutSequence<T> = T extends unknown ? Omit<T, "sequence"> : never;
type AcpSessionJournalEntryInput = WithoutSequence<AcpSessionJournalEntry>;

export interface AcpSessionJournalRecord {
  readonly public_session_id: string;
  readonly project_id: string;
  readonly project_label: string;
  readonly workspace_path: string;
  readonly entries: readonly AcpSessionJournalEntry[];
  /** Provider-native artifacts are retained beside, never inside, public history. */
  readonly session_evidence: readonly AcpSessionEvidenceReference[];
}

export type AcpSessionEvidenceAvailability = "available" | "absent" | "inaccessible";

export interface ProviderSessionEvidenceReport {
  readonly provider: string;
  readonly availability: AcpSessionEvidenceAvailability;
  readonly reference?: string;
}

export interface AcpSessionEvidenceReference extends ProviderSessionEvidenceReport {
  readonly worker_id: string;
  readonly retention: "evidence";
}

export interface AcpRetakeEvidenceProjection {
  readonly version: 1;
  readonly public_session_id: string;
  readonly evidence: readonly AcpSessionEvidenceReference[];
}

interface AcpSessionJournalSnapshot {
  readonly version: 1;
  readonly sessions: readonly AcpSessionJournalRecord[];
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
  evidence(
    publicSessionId: string,
    workerId: string,
    report: ProviderSessionEvidenceReport,
  ): Promise<void>;
  checkpoint(publicSessionId: string, response: PromptResponse, workflowOutcome?: string): Promise<void>;
  permission(
    publicSessionId: string,
    request: RequestPermissionRequest,
    policyKey: string,
    decision: Extract<AcpSessionJournalEntry, { kind: "permission" }>["decision"],
    optionId?: string,
  ): Promise<void>;
  recovery(publicSessionId: string): AcpSessionRecoveryCheckpoint;
  retake(publicSessionId: string, authorizedProjectId: string): AcpRetakeEvidenceProjection | undefined;
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
        session_evidence: [],
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
    evidence(publicSessionId, workerId, report) {
      const held = sessions.get(publicSessionId);
      if (held == null) throw new Error("unknown durable RedSkills ACP session");
      sessions.set(publicSessionId, {
        ...held,
        session_evidence: [
          ...held.session_evidence,
          { worker_id: workerId, ...report, retention: "evidence" },
        ],
      });
      return persist();
    },
    checkpoint(publicSessionId, response, workflowOutcome) {
      return append(publicSessionId, {
        kind: "checkpoint",
        stop_reason: response.stopReason,
        ...(workflowOutcome == null ? {} : { workflow_outcome: workflowOutcome }),
      });
    },
    permission(publicSessionId, request, policyKey, decision, optionId) {
      const option = optionId == null
        ? undefined
        : request.options.find((candidate) => candidate.optionId === optionId);
      return append(publicSessionId, {
        kind: "permission",
        tool_call_id: request.toolCall.toolCallId,
        policy_key: policyKey,
        decision,
        ...(option == null ? {} : { option_id: option.optionId, option_kind: option.kind }),
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
    retake(publicSessionId, authorizedProjectId) {
      const held = sessions.get(publicSessionId);
      if (held == null || held.project_id !== authorizedProjectId) return undefined;
      return {
        version: 1,
        public_session_id: publicSessionId,
        evidence: [...held.session_evidence],
      };
    },
  };
}

/** Decode only the provider-owned report; redskilled assigns retention itself. */
export function providerSessionEvidenceFromMeta(meta: unknown): ProviderSessionEvidenceReport | undefined {
  const root = record(meta);
  const redskills = record(root?.redskills);
  const evidence = record(redskills?.sessionEvidence);
  const provider = nonempty(evidence?.provider);
  const availability = evidence?.availability;
  const reference = nonempty(evidence?.reference);
  if (provider == null ||
    (availability !== "available" && availability !== "absent" && availability !== "inaccessible")) return undefined;
  if (availability !== "absent" && reference == null) return undefined;
  return {
    provider,
    availability,
    ...(reference == null ? {} : { reference }),
  };
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
  return new Map(parsed.sessions.map((session) => [session.public_session_id, {
    ...session,
    session_evidence: session.session_evidence ?? [],
  }]));
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
      Array.isArray(session.entries) &&
      (session.session_evidence == null ||
        (Array.isArray(session.session_evidence) && session.session_evidence.every(isEvidenceReference)));
  });
}

function isEvidenceReference(value: unknown): value is AcpSessionEvidenceReference {
  const evidence = record(value);
  return typeof evidence?.worker_id === "string" &&
    typeof evidence.provider === "string" &&
    (evidence.availability === "available" ||
      evidence.availability === "absent" ||
      evidence.availability === "inaccessible") &&
    evidence.retention === "evidence" &&
    (evidence.reference == null || typeof evidence.reference === "string");
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value != null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}
