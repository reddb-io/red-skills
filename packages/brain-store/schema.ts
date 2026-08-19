export const ARTIFACT_KINDS = [
  "pillar",
  "decision",
  "concept",
  "question",
  "playbook",
  "task",
  "event",
  "pattern",
  "hypothesis",
  "fact",
  "source",
  "bookmark",
  "note",
  "reference",
  "custom",
  "project",
  "idea",
  "meeting",
  "claim",
  "organization",
  "person",
] as const;

export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const INGESTION_KIND_ALIASES = {
  contact: "person",
} as const satisfies Record<string, ArtifactKind>;

export const CONNECTION_KINDS = [
  "supports",
  "contradicts",
  "depends_on",
  "derived_from",
  "related_to",
  "part_of",
  "preceded_by",
  "followed_by",
  "authored",
  "tagged",
] as const;

export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

export const COLLECTIONS = {
  artifacts: "brain_artifacts",
  connections: "brain_connections",
  outcomeEvents: "brain_outcome_events",
  kv: "brain_kv",
} as const;

export interface BrainArtifactProperties {
  id: string;
  title: string;
  content: string;
  tags: string[];
  source_agent?: string;
  source_runner?: string;
  source_session?: string;
  source_path?: string;
  created_at: number;
  updated_at: number;
  hash: string;
  metadata?: Record<string, unknown>;
}

export interface BrainArtifact {
  rid?: number;
  label: string;
  kind: ArtifactKind;
  properties: BrainArtifactProperties;
}

export interface StoredBrainArtifact extends BrainArtifact {
  rid: number;
}

export interface BrainConnectionProperties {
  reason?: string;
  confidence?: "explicit" | "derived" | "inferred";
  created_at: number;
  metadata?: Record<string, unknown>;
}

export interface BrainConnection {
  rid?: number;
  kind: ConnectionKind;
  from_rid: number;
  to_rid: number;
  weight?: number;
  properties: BrainConnectionProperties;
}

export interface StoredBrainConnection extends BrainConnection {
  rid: number;
}
