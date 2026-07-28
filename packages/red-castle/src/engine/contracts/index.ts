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
export const CASTLE_ATTEMPT_SCHEMA_ID = "red.castle.attempt.v1" as const;
export const CASTLE_VALIDATION_SCHEMA_ID = "red.castle.validation.v2" as const;
export const CASTLE_ENVELOPE_SCHEMA_ID = "red.castle.envelope.v1" as const;
export const CASTLE_HITL_CARD_SCHEMA_ID = "red.castle.hitl-card.v1" as const;

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

/**
 * The attempt — one worker × one ticket × one try — is the unit of truth, and
 * the RESIDENT writes it (ADR 0128). `writer` is a single-member union on
 * purpose: an entry stamped by anything but the resident is rejected, because
 * the record exists for exactly the moment the worker is already gone.
 */
export type CastleAttemptWriter = "resident";

export type CastleAttemptEvent =
  | "attempt.claimed"
  | "attempt.routed"
  | "attempt.progressed"
  | "attempt.committed"
  | "attempt.pr-opened"
  | "attempt.gated"
  | "attempt.landing"
  | "attempt.resourced"
  | "attempt.artifact"
  | "attempt.closed"
  | (string & {});

/** Terminal outcome. `budget-exceeded` NAMES its budget and is never a stall. */
export type CastleAttemptOutcomeKind =
  | "done"
  | "blocked"
  | "killed"
  | "budget-exceeded"
  | "discarded"
  | (string & {});

export interface CastleAttemptClaim {
  state: "claimed" | "conceded";
  by?: string;
  reason?: string;
}

/** The routing decision, as taken (ADR 0128 §4). */
export interface CastleAttemptRouting {
  runner: string;
  tier?: string;
  model?: string;
  effort?: string;
}

export interface CastleAttemptResources {
  wall_clock_s?: number;
  peak_rss_mb?: number;
  cost_usd?: number;
}

/**
 * An artifact the attempt left behind, with the reclaim verdict the janitor
 * reads. Reclaim eligibility is stated by the record, never inferred from a
 * missing pid file (ADR 0128, Consequences).
 */
export interface CastleAttemptArtifact {
  kind: string;
  ref?: string;
  path?: string;
  reclaimable: boolean;
  reclaim_after?: string;
  reason?: string;
}

export interface CastleAttemptGateVerdict {
  name: string;
  status: CastleValidationStatus;
  summary?: string;
}

export interface CastleAttemptLandingStep {
  step: string;
  status: string;
  detail?: string;
}

export interface CastleAttemptOutcome {
  kind: CastleAttemptOutcomeKind;
  detail?: string;
  /** Set when `kind` is `budget-exceeded`: the budget that terminated it. */
  budget?: string;
}

/**
 * One append-only line of an attempt's narrative. The attempt RECORD
 * (`CastleAttemptRecord`) is the fold of every entry sharing an `attempt_id` —
 * never separately maintained state, so nothing is ever rewritten in place.
 */
export interface CastleAttemptEntry {
  schema: typeof CASTLE_ATTEMPT_SCHEMA_ID;
  attempt_id: string;
  worker_id: string;
  issue: number;
  try: number;
  at: string;
  event: CastleAttemptEvent;
  writer: CastleAttemptWriter;
  claim?: CastleAttemptClaim;
  routing?: CastleAttemptRouting;
  branch?: string;
  commit?: string;
  pr?: number;
  gate?: CastleAttemptGateVerdict;
  landing?: CastleAttemptLandingStep;
  outcome?: CastleAttemptOutcome;
  resources?: CastleAttemptResources;
  artifact?: CastleAttemptArtifact;
  note?: string;
  payload?: Record<string, unknown>;
}

/** The folded narrative of one attempt — a derived view, never a stored one. */
export interface CastleAttemptRecord {
  attempt_id: string;
  worker_id: string;
  issue: number;
  try: number;
  opened_at: string;
  updated_at: string;
  closed: boolean;
  claim?: CastleAttemptClaim;
  routing?: CastleAttemptRouting;
  branch?: string;
  commits: string[];
  pr?: number;
  gate: CastleAttemptGateVerdict[];
  landing: CastleAttemptLandingStep[];
  outcome?: CastleAttemptOutcome;
  resources?: CastleAttemptResources;
  artifacts: CastleAttemptArtifact[];
  events: CastleAttemptEntry[];
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
  contract<CastleAttemptEntry>({
    schemaId: CASTLE_ATTEMPT_SCHEMA_ID,
    docPath: ".red/contracts/red.castle.attempt.v1.md",
    typeNames: [
      "CastleAttemptEntry",
      "CastleAttemptRecord",
      "CastleAttemptEvent",
      "CastleAttemptWriter",
      "CastleAttemptClaim",
      "CastleAttemptRouting",
      "CastleAttemptGateVerdict",
      "CastleAttemptLandingStep",
      "CastleAttemptOutcome",
      "CastleAttemptOutcomeKind",
      "CastleAttemptResources",
      "CastleAttemptArtifact",
    ],
    fields: {
      schema: true,
      attempt_id: true,
      worker_id: true,
      issue: true,
      try: true,
      at: true,
      event: true,
      writer: true,
      claim: true,
      routing: true,
      branch: true,
      commit: true,
      pr: true,
      gate: true,
      landing: true,
      outcome: true,
      resources: true,
      artifact: true,
      note: true,
      payload: true,
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
