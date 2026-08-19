// session-recovery — the public-journal checkpoint carried in `_meta` (ADR 0148).
//
// redskilled owns the durable public ACP session journal; a Worker never reads
// or writes it. What DOES cross the seam is one checkpoint: when the daemon
// replaces a dead Worker mid-session, it stamps the completed turns into the
// replacement's `session/new` `_meta`, and the replacement reports the resume
// back on its first prompt. Encoder and decoder are the two ends of one slot,
// so they are declared together here — a checkpoint written by a shape the
// reader does not accept is a silent loss of every completed turn.
import {
  methods,
  type AgentConnection,
  type NewSessionRequest,
  type PromptRequest,
  type PromptResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";

/** One retained public-boundary fact. Thought chunks are never admitted. */
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
  }
  | {
    readonly sequence: number;
    readonly kind: "permission";
    readonly tool_call_id: string;
    readonly policy_key: string;
    readonly decision: "attached-approved" | "attached-denied" | "policy-pre-authorized" | "hitl-required";
    readonly option_id?: string;
    readonly option_kind?: "allow_once" | "allow_always" | "reject_once" | "reject_always";
  };

/** What a replacement Worker is told about the turns it did not run. */
export interface AcpSessionRecoveryCheckpoint {
  readonly version: 1;
  readonly source: "redskilled-public-journal";
  readonly public_session_id: string;
  readonly completed_turns: number;
  readonly entries: readonly AcpSessionJournalEntry[];
}

/** Daemon side: stamp a checkpoint onto the replacement's `session/new`. */
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

/** Worker side: read the checkpoint, and only the daemon's own journal source. */
export function sessionRecoveryFromMeta(meta: NewSessionRequest["_meta"]): AcpSessionRecoveryCheckpoint | undefined {
  const recovery = (meta as { redskills?: { recovery?: AcpSessionRecoveryCheckpoint } } | undefined)
    ?.redskills?.recovery;
  return recovery?.source === "redskilled-public-journal" ? recovery : undefined;
}

/** Worker side: say out loud, on the public wire, what was resumed. */
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
