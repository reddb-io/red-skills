type FieldMap<T> = { readonly [K in Extract<keyof T, string>]-?: true };

export interface PublishedContract<TField extends string = string> {
  readonly schemaId: string;
  readonly docPath: `.red/contracts/${string}.md`;
  readonly typeNames: readonly string[];
  readonly fields: readonly TField[];
}

function fieldsOf<T>(fields: FieldMap<T>): readonly Extract<keyof T, string>[] {
  return Object.keys(fields) as Extract<keyof T, string>[];
}

function contract<T>(
  spec: Omit<PublishedContract<Extract<keyof T, string>>, "fields"> & {
    readonly fields: FieldMap<T>;
  },
): PublishedContract<Extract<keyof T, string>> {
  return { ...spec, fields: fieldsOf<T>(spec.fields) };
}

export const CASTLE_LANE_SCHEMA_ID = "red.castle.lane.v1" as const;
export const CASTLE_STATE_SCHEMA_ID = "red.castle.state.v1" as const;
export const CASTLE_HISTORY_SCHEMA_ID = "red.castle.history.v1" as const;
export const CASTLE_VALIDATION_SCHEMA_ID = "red.castle.validation.v2" as const;
export const CASTLE_ENVELOPE_SCHEMA_ID = "red.castle.envelope.v1" as const;
export const CASTLE_HITL_CARD_SCHEMA_ID = "red.castle.hitl-card.v1" as const;

export const DECISION_TRAIL_SCHEMA_ID = "red.castle.decision-trail.v1" as const;

export type DecisionTrailKind =
  | "decision.fork"
  | "decision.pivot"
  | "decision.revert"
  | "decision.blocker"
  | "decision.verified";

export const DECISION_TRAIL_KINDS = [
  "decision.fork",
  "decision.pivot",
  "decision.revert",
  "decision.blocker",
  "decision.verified",
] as const satisfies readonly DecisionTrailKind[];

export interface DecisionTrailPayload {
  decision: string;
  why: string;
  evidence: string;
  result: string;
}

export type CastleLaneKind =
  | "worker.claimed"
  | "worker.steered"
  | "worker.heartbeat"
  | "worker.completed"
  | "worker.blocked"
  | "supervisor.scaled"
  | "supervisor.retired"
  | (string & {});

export interface CastleLaneRecord {
  at: string;
  kind: CastleLaneKind;
  worker_id?: string;
  supervisor_id?: string;
  issue?: number;
  attempt?: number;
  /** Human-readable narrative carried beside the structured event facts. */
  msg?: string;
  payload?: Record<string, unknown>;
}

export type CastleStateKind = "worker" | "supervisor";

export interface CastleStateSnapshot {
  kind: CastleStateKind;
  id: string;
  version: number;
  updated_at: string;
  worker_id?: string;
  supervisor_id?: string;
  runner?: string;
  bundle_version?: string;
  pid?: number;
  started_at?: string;
  current?: Record<string, unknown>;
  queue?: number[];
  completed?: number[];
  envelope?: { posted: boolean };
}

export type CastleHistoryEvent =
  "done" | "blocked" | "exhausted" | (string & {});

export interface CastleHistoryRecord {
  ts: string;
  epoch: number;
  worker: string;
  issue: number;
  event: CastleHistoryEvent;
  duration_s: number;
  runner: string;
  merge_sha?: string;
  reason?: string;
}

export type CastleValidationStatus = "passed" | "failed" | "skipped";

export interface CastleValidationRecord {
  schema: typeof CASTLE_VALIDATION_SCHEMA_ID;
  name: string;
  status: CastleValidationStatus;
  command?: string;
  exitCode?: number;
  durationMs?: number;
  summary?: string;
}

/**
 * `wall-clock-capped` (#2701) is deliberately NOT folded into `no-sentinel`:
 * the worker was cut off by a wall-clock policy while working, so the envelope
 * must say "we stopped it", not "it never finished".
 */
export type CastleAttemptStatus =
  "blocked" | "no-sentinel" | "merge-conflict" | "done" | "discarded" | "wall-clock-capped";

export interface CastleEnvelopeSection {
  name: string;
  body: string;
  fenced?: boolean;
  fenceLang?: string;
}

export interface CastleEnvelope {
  status: CastleAttemptStatus;
  worker: string;
  duration: string;
  diff: string;
  attempt: number;
  mergeSha?: string;
  sections?: CastleEnvelopeSection[];
}

export type CastleHitlCardAction =
  "approve" | "approve-ci" | "reject" | "requeue";

export interface CastleHitlCardPrStatus {
  number?: number;
  ci: "pass" | "fail" | "pending" | "none";
  ciPassed: number;
  ciTotal: number;
  mergeability: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  headSha?: string;
}

export interface CastleHitlCard {
  issueNumber: number;
  issueTitle?: string;
  issueUrl?: string;
  pendingDecision: string;
  prStatus: CastleHitlCardPrStatus;
  updatedAt: string;
}

export const CASTLE_PUBLISHED_CONTRACTS = [
  contract<CastleLaneRecord>({
    schemaId: CASTLE_LANE_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.lane.v1.md",
    typeNames: ["CastleLaneRecord", "CastleLaneKind"],
    fields: {
      at: true,
      kind: true,
      worker_id: true,
      supervisor_id: true,
      issue: true,
      attempt: true,
      msg: true,
      payload: true,
    },
  }),
  contract<CastleStateSnapshot>({
    schemaId: CASTLE_STATE_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.state.v1.md",
    typeNames: ["CastleStateSnapshot", "CastleStateKind"],
    fields: {
      kind: true,
      id: true,
      version: true,
      updated_at: true,
      worker_id: true,
      supervisor_id: true,
      runner: true,
      bundle_version: true,
      pid: true,
      started_at: true,
      current: true,
      queue: true,
      completed: true,
      envelope: true,
    },
  }),
  contract<CastleHistoryRecord>({
    schemaId: CASTLE_HISTORY_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.history.v1.md",
    typeNames: ["CastleHistoryRecord", "CastleHistoryEvent"],
    fields: {
      ts: true,
      epoch: true,
      worker: true,
      issue: true,
      event: true,
      duration_s: true,
      runner: true,
      merge_sha: true,
      reason: true,
    },
  }),
  contract<CastleValidationRecord>({
    schemaId: CASTLE_VALIDATION_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.validation.v2.md",
    typeNames: ["CastleValidationRecord", "CastleValidationStatus"],
    fields: {
      schema: true,
      name: true,
      status: true,
      command: true,
      exitCode: true,
      durationMs: true,
      summary: true,
    },
  }),
  contract<CastleEnvelope>({
    schemaId: CASTLE_ENVELOPE_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.envelope.v1.md",
    typeNames: [
      "CastleEnvelope",
      "CastleEnvelopeSection",
      "CastleAttemptStatus",
    ],
    fields: {
      status: true,
      worker: true,
      duration: true,
      diff: true,
      attempt: true,
      mergeSha: true,
      sections: true,
    },
  }),
  contract<CastleHitlCard>({
    schemaId: CASTLE_HITL_CARD_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.hitl-card.v1.md",
    typeNames: [
      "CastleHitlCard",
      "CastleHitlCardPrStatus",
      "CastleHitlCardAction",
    ],
    fields: {
      issueNumber: true,
      issueTitle: true,
      issueUrl: true,
      pendingDecision: true,
      prStatus: true,
      updatedAt: true,
    },
  }),
] as const;
