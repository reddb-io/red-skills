import { createHash } from "node:crypto";
import type { MemoryStore } from "./graph-store.js";

export const PROVIDER_REVIEW_ARTIFACT_STORE_KEY = "provider_review_artifacts.v1";
export const PROVIDER_REVIEW_FINGERPRINT_ALGORITHM = "sha256:provider-review.v1";
export const DEFAULT_TIDY_REVIEW_POLICY_VERSION = "memory.governance-tidy.review.v1";

export type ProviderReviewStatus = "open" | "dismissed" | "accepted" | "stale";

export interface ProviderReviewEvidenceSubject {
  collection?: string;
  rid?: number;
  label?: string;
  node_type?: string;
  title?: string;
  hash?: string;
  content?: string;
  updated_at?: number;
  [extra: string]: JsonValue | undefined;
}

export interface ProviderReviewPairEvidence {
  pair_id?: string;
  relation?: string;
  subjects: ProviderReviewEvidenceSubject[];
  evidence?: JsonRecord[];
}

export interface ProviderReviewFingerprintInput {
  operation: string;
  policyVersion: string;
  pairEvidence: ProviderReviewPairEvidence[];
  evidence?: JsonRecord[];
}

export interface ProviderReviewFingerprintMetadata {
  algorithm: typeof PROVIDER_REVIEW_FINGERPRINT_ALGORITHM;
  fingerprint: string;
  operation: string;
  policy_version: string;
  pair_count: number;
  evidence_count: number;
}

export interface ProviderReviewRecommendationInput extends ProviderReviewFingerprintInput {
  recommendationKey: string;
  recommendation: {
    title: string;
    rationale?: string;
    suggested_action?: string;
    provider_output?: JsonRecord;
  };
  provider?: {
    mode?: string;
    model?: string;
  };
}

export interface ProviderReviewArtifact {
  schema_version: "memory.provider_review_artifact.v1";
  artifact_id: string;
  recommendation_id: string;
  recommendation_key: string;
  operation: string;
  status: ProviderReviewStatus;
  created_at: number;
  updated_at: number;
  status_changed_at: number;
  dismissed_at?: number;
  accepted_at?: number;
  stale_at?: number;
  fingerprint: string;
  fingerprint_metadata: ProviderReviewFingerprintMetadata;
  pair_evidence: ProviderReviewPairEvidence[];
  recommendation: ProviderReviewRecommendationInput["recommendation"];
  provider?: ProviderReviewRecommendationInput["provider"];
  review?: ProviderReviewActionMetadata;
}

export interface ProviderReviewActionMetadata {
  action: "accepted" | "dismissed";
  approver: string;
  reviewed_at: number;
  source: string;
  reason?: string;
}

export interface ProviderReviewArtifactState {
  schema_version: "memory.provider_review_artifacts.v1";
  artifacts: Record<string, ProviderReviewArtifact>;
}

export interface PersistProviderReviewArtifactsResult {
  artifacts: ProviderReviewArtifact[];
  stale: ProviderReviewArtifact[];
}

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonValue[] | JsonRecord;
type JsonRecord = { [key: string]: JsonValue | undefined };

export function computeProviderReviewFingerprint(
  input: ProviderReviewFingerprintInput,
): ProviderReviewFingerprintMetadata {
  const canonicalPairs = input.pairEvidence.map(canonicalPairEvidence).sort(compareStableJson);
  const canonicalEvidence = (input.evidence ?? []).map(normalizeJson).sort(compareStableJson);
  const fingerprint = sha256(
    stableJson({
      operation: input.operation,
      policy_version: input.policyVersion,
      pair_evidence: canonicalPairs,
      evidence: canonicalEvidence,
    }),
  );
  return {
    algorithm: PROVIDER_REVIEW_FINGERPRINT_ALGORITHM,
    fingerprint,
    operation: input.operation,
    policy_version: input.policyVersion,
    pair_count: canonicalPairs.length,
    evidence_count:
      canonicalEvidence.length +
      input.pairEvidence.reduce((sum, pair) => sum + (pair.evidence?.length ?? 0), 0),
  };
}

export function providerReviewRecommendationId(input: ProviderReviewRecommendationInput): string {
  const subjectIdentities = input.pairEvidence
    .flatMap((pair) => pair.subjects.map(subjectIdentity))
    .sort();
  return `provider-review:${sha256(
    stableJson({
      operation: input.operation,
      recommendation_key: input.recommendationKey,
      subjects: subjectIdentities,
    }),
  ).slice(0, 24)}`;
}

export function providerReviewArtifactId(input: ProviderReviewRecommendationInput): string {
  const recommendationId = providerReviewRecommendationId(input);
  const fingerprint = computeProviderReviewFingerprint(input).fingerprint;
  return `${recommendationId}:${fingerprint.slice(0, 24)}`;
}

export async function persistProviderReviewArtifacts(
  store: Pick<MemoryStore, "kvGet" | "kvPut">,
  recommendations: ProviderReviewRecommendationInput[],
  opts: { now?: number; operation?: string } = {},
): Promise<PersistProviderReviewArtifactsResult> {
  const now = opts.now ?? Date.now();
  const state = await readProviderReviewArtifactState(store);
  const currentArtifactIds = new Set<string>();
  const operations = new Set(recommendations.map((rec) => rec.operation));
  if (opts.operation) operations.add(opts.operation);

  const nextArtifacts: ProviderReviewArtifact[] = recommendations.map((rec) => {
    const fingerprint = computeProviderReviewFingerprint(rec);
    const recommendationId = providerReviewRecommendationId(rec);
    const artifactId = `${recommendationId}:${fingerprint.fingerprint.slice(0, 24)}`;
    currentArtifactIds.add(artifactId);
    const existing = state.artifacts[artifactId];
    const status = existing?.status ?? "open";
    return {
      schema_version: "memory.provider_review_artifact.v1",
      artifact_id: artifactId,
      recommendation_id: recommendationId,
      recommendation_key: rec.recommendationKey,
      operation: rec.operation,
      status,
      created_at: existing?.created_at ?? now,
      updated_at: now,
      status_changed_at: existing?.status_changed_at ?? now,
      dismissed_at: existing?.dismissed_at,
      accepted_at: existing?.accepted_at,
      stale_at: existing?.stale_at,
      fingerprint: fingerprint.fingerprint,
      fingerprint_metadata: fingerprint,
      pair_evidence: cloneJson(rec.pairEvidence) as ProviderReviewPairEvidence[],
      recommendation: cloneJson(
        rec.recommendation,
      ) as ProviderReviewRecommendationInput["recommendation"],
      provider: rec.provider
        ? (cloneJson(rec.provider) as ProviderReviewRecommendationInput["provider"])
        : undefined,
      review: existing?.review
        ? (cloneJson(existing.review) as ProviderReviewActionMetadata)
        : undefined,
    };
  });

  const stale: ProviderReviewArtifact[] = [];
  for (const [artifactId, artifact] of Object.entries(state.artifacts)) {
    if (artifact.status !== "open") continue;
    if (operations.size > 0 && !operations.has(artifact.operation)) continue;
    if (currentArtifactIds.has(artifactId)) continue;
    const next = {
      ...artifact,
      status: "stale" as const,
      updated_at: now,
      status_changed_at: now,
      stale_at: now,
    };
    state.artifacts[artifactId] = next;
    stale.push(next);
  }

  for (const artifact of nextArtifacts) {
    state.artifacts[artifact.artifact_id] = artifact;
  }
  await writeProviderReviewArtifactState(store, state);
  return { artifacts: nextArtifacts, stale };
}

export async function listProviderReviewArtifacts(
  store: Pick<MemoryStore, "kvGet">,
  opts: { operation?: string; status?: ProviderReviewStatus } = {},
): Promise<ProviderReviewArtifact[]> {
  const state = await readProviderReviewArtifactState(store);
  return Object.values(state.artifacts)
    .filter((artifact) => opts.operation == null || artifact.operation === opts.operation)
    .filter((artifact) => opts.status == null || artifact.status === opts.status)
    .sort((a, b) => a.created_at - b.created_at || a.artifact_id.localeCompare(b.artifact_id));
}

export async function updateProviderReviewArtifactStatus(
  store: Pick<MemoryStore, "kvGet" | "kvPut">,
  artifactId: string,
  status: ProviderReviewStatus,
  opts: { now?: number; approver?: string; reason?: string; source?: string } = {},
): Promise<ProviderReviewArtifact> {
  const now = opts.now ?? Date.now();
  const state = await readProviderReviewArtifactState(store);
  const artifact = state.artifacts[artifactId];
  if (!artifact) throw new Error(`provider review artifact not found: ${artifactId}`);
  const action = status === "accepted" || status === "dismissed" ? status : null;
  const next: ProviderReviewArtifact = {
    ...artifact,
    status,
    updated_at: now,
    status_changed_at: now,
    dismissed_at: status === "dismissed" ? now : artifact.dismissed_at,
    accepted_at: status === "accepted" ? now : artifact.accepted_at,
    stale_at: status === "stale" ? now : artifact.stale_at,
    review: action
      ? {
          action,
          approver: opts.approver ?? artifact.review?.approver ?? "unknown",
          reviewed_at: now,
          source: opts.source ?? artifact.review?.source ?? "provider review artifact status update",
          ...(opts.reason
            ? { reason: opts.reason }
            : artifact.review?.reason
              ? { reason: artifact.review.reason }
              : {}),
        }
      : artifact.review,
  };
  if (status === "open") {
    delete next.dismissed_at;
    delete next.accepted_at;
    delete next.stale_at;
    delete next.review;
  }
  state.artifacts[artifactId] = next;
  await writeProviderReviewArtifactState(store, state);
  return next;
}

export async function readProviderReviewArtifactState(
  store: Pick<MemoryStore, "kvGet">,
): Promise<ProviderReviewArtifactState> {
  const raw = await store.kvGet<ProviderReviewArtifactState | string>(
    PROVIDER_REVIEW_ARTIFACT_STORE_KEY,
  );
  if (raw == null) return emptyState();
  if (typeof raw === "string") {
    return normalizeState(JSON.parse(raw) as ProviderReviewArtifactState);
  }
  return normalizeState(raw);
}

async function writeProviderReviewArtifactState(
  store: Pick<MemoryStore, "kvPut">,
  state: ProviderReviewArtifactState,
): Promise<void> {
  await store.kvPut(PROVIDER_REVIEW_ARTIFACT_STORE_KEY, state);
}

function emptyState(): ProviderReviewArtifactState {
  return { schema_version: "memory.provider_review_artifacts.v1", artifacts: {} };
}

function normalizeState(raw: ProviderReviewArtifactState): ProviderReviewArtifactState {
  return {
    schema_version: "memory.provider_review_artifacts.v1",
    artifacts: raw.artifacts ?? {},
  };
}

function canonicalPairEvidence(pair: ProviderReviewPairEvidence): JsonRecord {
  return {
    relation: pair.relation ?? null,
    subjects: pair.subjects.map(canonicalSubject).sort(compareStableJson),
    evidence: (pair.evidence ?? []).map(normalizeJson).sort(compareStableJson),
  };
}

function canonicalSubject(subject: ProviderReviewEvidenceSubject): JsonRecord {
  return normalizeJson(subject) as JsonRecord;
}

function subjectIdentity(subject: ProviderReviewEvidenceSubject): string {
  return stableJson({
    collection: subject.collection ?? null,
    rid: subject.rid ?? null,
    label: subject.label ?? null,
    node_type: subject.node_type ?? null,
  });
}

function normalizeJson(value: unknown): JsonValue {
  if (value == null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const out: JsonRecord = {};
    for (const key of Object.keys(record).sort()) {
      const normalized = normalizeJson(record[key]);
      if (normalized !== undefined) out[key] = normalized;
    }
    return out;
  }
  return String(value);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function compareStableJson(a: unknown, b: unknown): number {
  return stableJson(a).localeCompare(stableJson(b));
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}
