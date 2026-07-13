import { createHash } from "node:crypto";
import type { QueryParam, RedDB } from "@reddb-io/sdk";
import { isOutcomeEvent, type OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import type { BrainResidentAction } from "./resident-protocol.js";

const COLLECTIONS = {
  artifacts: "brain_artifacts",
  connections: "brain_connections",
  outcomeEvents: "brain_outcome_events",
  kv: "brain_kv",
} as const;

const ARTIFACT_KINDS = new Set([
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
]);

const CONNECTION_KINDS = new Set([
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
]);

export class ResidentBrainStore {
  constructor(
    private readonly db: RedDB,
    private readonly uri: string,
  ) {}

  async request(action: BrainResidentAction, payload: unknown): Promise<unknown> {
    await this.bootstrap();
    if (action === "status") return await this.status();
    if (action === "capture") return await this.capture(payloadRecord(payload));
    if (action === "getArtifact") return await this.getArtifact(recordField(payload, "ridOrId") as string | number);
    if (action === "listArtifacts") return await this.listArtifacts();
    if (action === "search") {
      const request = payloadRecord(payload);
      return await this.search(
        stringPayloadField(request, "query"),
        numberPayloadField(request, "limit") ?? 10,
        searchOptionsPayload(request.options),
      );
    }
    if (action === "think") {
      const request = payloadRecord(payload);
      return await this.think(
        stringPayloadField(request, "query"),
        numberPayloadField(request, "limit") ?? 8,
        searchOptionsPayload(request.options),
      );
    }
    if (action === "link") return await this.link(payloadRecord(payload));
    if (action === "backlinks") return await this.backlinks(recordField(payload, "target") as string | number);
    if (action === "listConnections") return await this.listConnections();
    if (action === "eventKpis") return await this.eventKpis(payloadRecord(payload));
    if (action === "appendOutcomeEvent") return await this.appendOutcomeEvent(payload);
    if (action === "replayOutcomeEvents") return await this.replayOutcomeEvents();
    if (action === "loadModelTierBanditDocument") return await this.loadModelTierBanditDocument();
    if (action === "saveModelTierBanditDocument") return await this.saveModelTierBanditDocument(payload);
    if (action === "refreshModelTierBanditDocument") return await this.refreshModelTierBanditDocument();
    throw new Error(`unsupported resident brain action: ${action}`);
  }

  private async bootstrap(): Promise<void> {
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.artifacts}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.connections}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.outcomeEvents}`);
  }

  private async status(): Promise<Record<string, unknown>> {
    const artifacts = await this.listArtifacts();
    const connections = await this.listConnections();
    return {
      uri: this.uri,
      artifacts: artifacts.length,
      connections: connections.length,
      kinds: countBy(artifacts.map((artifact) => artifact.kind)),
    };
  }

  private async capture(input: Record<string, unknown>): Promise<StoredBrainArtifact> {
    const title = stringValue(input.title) || "Untitled artifact";
    const content = stringValue(input.content);
    if (!content) throw new Error("brain capture requires content");
    const kind = normalizeArtifactKind(stringValue(input.kind) || "note");
    const tags = normalizeTags(Array.isArray(input.tags) ? input.tags.map(String) : []);
    const now = Date.now();
    const hash = contentHash([kind, title, content, tags, stringValue(input.sourcePath), stringValue(input.sourceSession)]);
    const existingRid = await this.kv().get(artifactHashKey(hash));
    if (existingRid != null) {
      const existing = await this.getArtifact(Number(existingRid));
      if (existing) return existing;
    }
    const id = `${slugify(title)}-${hash.slice(0, 8)}`;
    const properties = {
      id,
      title,
      content,
      tags,
      source_agent: stringValue(input.sourceAgent),
      source_runner: stringValue(input.sourceRunner),
      source_session: stringValue(input.sourceSession),
      source_path: stringValue(input.sourcePath),
      created_at: now,
      updated_at: now,
      hash,
      metadata: isRecord(input.metadata) ? input.metadata : undefined,
    };
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.artifacts} NODE (label, node_type, hash, properties) VALUES ($1, $2, $3, $4) RETURNING *`,
      id,
      kind,
      hash,
      properties,
    );
    const row = result.rows[0];
    if (!row) throw new Error("INSERT artifact returned no row");
    const artifact = rowToArtifact(row);
    if (!artifact) throw new Error("INSERT artifact returned invalid row");
    await this.kv().put(artifactHashKey(hash), artifact.rid);
    await this.materializeTagConnections(artifact);
    return artifact;
  }

  private async getArtifact(ridOrId: number | string): Promise<StoredBrainArtifact | null> {
    const artifacts = await this.listArtifacts();
    if (typeof ridOrId === "number") return artifacts.find((artifact) => artifact.rid === ridOrId) ?? null;
    return artifacts.find((artifact) => artifact.properties.id === ridOrId || artifact.label === ridOrId) ?? null;
  }

  private async listArtifacts(): Promise<StoredBrainArtifact[]> {
    const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.artifacts}`);
    return result.rows.map(rowToArtifact).filter(notNull);
  }

  private async search(query: string, limit: number, options: { excludeRids?: number[] } = {}): Promise<SearchHit[]> {
    const terms = tokenize(query);
    const excluded = new Set(options.excludeRids ?? []);
    const artifacts = await this.listArtifacts();
    const connections = await this.listConnections();
    const artifactsByRid = new Map(artifacts.map((artifact) => [artifact.rid, artifact]));
    return artifacts
      .filter((artifact) => !excluded.has(artifact.rid))
      .map((artifact) => {
        const base = scoreArtifact(artifact, terms);
        const score_breakdown = withTotal({
          ...base,
          connections: scoreConnections(artifact, terms, connections, artifactsByRid),
          vector: 0,
        });
        return {
          artifact,
          score: score_breakdown.total,
          score_breakdown,
          excerpt: excerpt(artifact.properties.content, terms),
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.artifact.properties.updated_at - a.artifact.properties.updated_at)
      .slice(0, Math.max(1, Math.min(100, limit)));
  }

  private async think(query: string, limit: number, options: { excludeRids?: number[] } = {}): Promise<BrainThinkResult> {
    const hits = (await this.search(query, Math.max(limit * 2, limit + 5), options)).slice(0, limit);
    return renderThinkResult(query, hits);
  }

  private async link(input: Record<string, unknown>): Promise<StoredBrainConnection> {
    const from = await this.getArtifact(parseRidOrId(input.from));
    const to = await this.getArtifact(parseRidOrId(input.to));
    if (!from) throw new Error(`Brain artifact not found: ${String(input.from)}`);
    if (!to) throw new Error(`Brain artifact not found: ${String(input.to)}`);
    const kind = normalizeConnectionKind(stringValue(input.kind) || "related_to");
    const existing = await this.findConnection(from.rid, to.rid, kind);
    if (existing != null) {
      const found = (await this.listConnections()).find((connection) => connection.rid === existing);
      if (found) return found;
    }
    const properties = {
      reason: stringValue(input.reason),
      confidence: stringValue(input.confidence) || "explicit",
      created_at: Date.now(),
      metadata: isRecord(input.metadata) ? input.metadata : undefined,
    };
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.connections} EDGE (label, from, to, weight, properties) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      kind,
      from.rid,
      to.rid,
      1.0,
      properties,
    );
    const row = result.rows[0];
    if (!row) throw new Error("INSERT connection returned no row");
    const connection = rowToConnection(row);
    if (!connection) throw new Error("INSERT connection returned invalid row");
    await this.kv().put(connectionKey(from.rid, to.rid, kind), connection.rid);
    return connection;
  }

  private async backlinks(target: number | string): Promise<StoredBrainConnection[]> {
    const artifact = await this.getArtifact(target);
    if (!artifact) throw new Error(`Brain artifact not found: ${target}`);
    return (await this.listConnections()).filter((connection) => connection.to_rid === artifact.rid);
  }

  private async listConnections(): Promise<StoredBrainConnection[]> {
    const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.connections}`);
    return result.rows.map(rowToConnection).filter(notNull);
  }

  private async eventKpis(input: Record<string, unknown>): Promise<KpiResult> {
    const artifacts = (await this.listArtifacts()).filter((artifact) => artifact.kind === "event");
    const interval = normalizeInterval(stringValue(input.interval) || "day");
    const timeField = stringValue(input.timeField) === "ingested" ? "ingested" : "event";
    return {
      kind: "event",
      interval,
      timeField,
      range: { from: null, to: null },
      total: artifacts.length,
      series: [{ group: null, total: artifacts.length, buckets: [] }],
    };
  }

  private async appendOutcomeEvent(value: unknown): Promise<OutcomeEvent> {
    if (!isOutcomeEvent(value)) throw new Error("invalid Brain outcome event");
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.outcomeEvents} NODE (label, node_type, properties) VALUES ($1, $2, $3) RETURNING *`,
      value.id,
      `outcome_event.v${value.schemaVersion}`,
      value as unknown as QueryParam,
    );
    if (!result.rows[0]) throw new Error("INSERT outcome event returned no row");
    return value;
  }

  private async replayOutcomeEvents(): Promise<OutcomeEvent[]> {
    const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.outcomeEvents}`);
    return result.rows
      .map(rowToOutcomeEvent)
      .filter(notNull)
      .sort((a, b) => a.rid - b.rid)
      .map(({ event }) => event);
  }

  private async loadModelTierBanditDocument(): Promise<unknown> {
    const stored = await this.kv().get(modelTierBanditKey());
    return typeof stored === "string" ? JSON.parse(stored) as unknown : stored;
  }

  private async saveModelTierBanditDocument(document: unknown): Promise<unknown> {
    await this.kv().put(modelTierBanditKey(), JSON.stringify(document));
    return document;
  }

  private async refreshModelTierBanditDocument(): Promise<unknown> {
    const existing = await this.loadModelTierBanditDocument();
    if (existing != null) return existing;
    const document = { schema_version: "brain.model-tier-bandit.v1", updated_at: new Date().toISOString(), arms: {} };
    await this.saveModelTierBanditDocument(document);
    return document;
  }

  private async materializeTagConnections(artifact: StoredBrainArtifact): Promise<void> {
    if (artifact.properties.metadata?.derived_kind === "tag") return;
    for (const tag of artifact.properties.tags) {
      const tagArtifact = await this.capture({
        title: tag,
        content: `Tag: ${tag}`,
        kind: "custom",
        tags: ["tag"],
        metadata: { derived: true, derived_kind: "tag" },
      });
      await this.link({
        from: artifact.rid,
        to: tagArtifact.rid,
        kind: "tagged",
        confidence: "derived",
      });
    }
  }

  private async findConnection(from: number, to: number, kind: string): Promise<number | null> {
    const rid = await this.kv().get(connectionKey(from, to, kind));
    return rid != null ? Number(rid) : null;
  }

  private kv() {
    return this.db.kv(COLLECTIONS.kv);
  }
}

export function createResidentBrainStore(db: RedDB, uri: string): ResidentBrainStore {
  return new ResidentBrainStore(db, uri);
}

interface StoredBrainArtifact {
  rid: number;
  label: string;
  kind: string;
  properties: {
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
  };
}

interface StoredBrainConnection {
  rid: number;
  kind: string;
  from_rid: number;
  to_rid: number;
  weight: number;
  properties: Record<string, unknown>;
}

interface SearchHit {
  artifact: StoredBrainArtifact;
  score: number;
  score_breakdown: SearchScoreBreakdown;
  excerpt: string;
}

interface SearchScoreBreakdown {
  lexical: number;
  tags: number;
  kind: number;
  connections: number;
  vector: number;
  total: number;
}

interface BrainThinkResult {
  answer: string;
  hits: SearchHit[];
  citations: unknown[];
  confidence: "none" | "low" | "medium" | "high";
  missing_evidence: string[];
}

interface KpiResult {
  kind: "event";
  interval: "hour" | "day" | "week" | "month";
  timeField: "event" | "ingested";
  range: { from: number | null; to: number | null };
  total: number;
  series: Array<{ group: string | null; total: number; buckets: unknown[] }>;
}

function rowToArtifact(row: Record<string, unknown>): StoredBrainArtifact | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  const properties = parseProperties(row.properties ?? row.PROPERTIES);
  const kind = normalizeArtifactKind(String(row.node_type ?? row.NODE_TYPE ?? properties.kind ?? "note"));
  if (!Number.isFinite(rid)) return null;
  const id = String(properties.id ?? row.label ?? row.LABEL ?? rid);
  const title = String(properties.title ?? row.label ?? row.LABEL ?? id);
  const content = String(properties.content ?? "");
  const tags = Array.isArray(properties.tags) ? properties.tags.map(String) : [];
  const now = Date.now();
  return {
    rid,
    label: String(row.label ?? row.LABEL ?? id),
    kind,
    properties: {
      ...properties,
      id,
      title,
      content,
      tags,
      created_at: Number(properties.created_at ?? now),
      updated_at: Number(properties.updated_at ?? properties.created_at ?? now),
      hash: String(properties.hash ?? ""),
    },
  };
}

function rowToConnection(row: Record<string, unknown>): StoredBrainConnection | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  const from = Number(row.from ?? row.FROM ?? row.from_rid ?? row.source);
  const to = Number(row.to ?? row.TO ?? row.to_rid ?? row.target);
  const kind = normalizeConnectionKind(String(row.label ?? row.LABEL ?? "related_to"));
  if (!Number.isFinite(rid) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    rid,
    kind,
    from_rid: from,
    to_rid: to,
    weight: Number(row.weight ?? 1),
    properties: parseProperties(row.properties ?? row.PROPERTIES),
  };
}

function rowToOutcomeEvent(row: Record<string, unknown>): { rid: number; event: OutcomeEvent } | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  const properties = parseProperties(row.properties ?? row.PROPERTIES);
  if (!Number.isFinite(rid) || !isOutcomeEvent(properties)) return null;
  return { rid, event: properties };
}

function parseProperties(value: unknown): Record<string, unknown> {
  if (value == null) return {};
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return isRecord(value) ? value : {};
}

function normalizeArtifactKind(value: string): string {
  const mapped = value === "contact" ? "person" : value;
  if (ARTIFACT_KINDS.has(mapped)) return mapped;
  throw new Error(`invalid Brain artifact kind: ${value}`);
}

function normalizeConnectionKind(value: string): string {
  if (CONNECTION_KINDS.has(value)) return value;
  throw new Error(`invalid Brain connection kind: ${value}`);
}

function normalizeInterval(value: string): KpiResult["interval"] {
  return value === "hour" || value === "week" || value === "month" ? value : "day";
}

function parseRidOrId(value: unknown): number | string {
  if (typeof value === "number") return value;
  const text = String(value ?? "");
  return /^\d+$/.test(text) ? Number(text) : text;
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function recordField(value: unknown, key: string): unknown {
  return payloadRecord(value)[key];
}

function stringPayloadField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string") throw new Error(`brain ${key} must be a string`);
  return field;
}

function numberPayloadField(value: Record<string, unknown>, key: string): number | undefined {
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function searchOptionsPayload(value: unknown): { excludeRids?: number[] } {
  const options = payloadRecord(value);
  const excludeRids = Array.isArray(options.excludeRids)
    ? options.excludeRids.map(Number).filter(Number.isFinite)
    : undefined;
  return { excludeRids };
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function notNull<T>(value: T | null): value is T {
  return value != null;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort();
}

function contentHash(parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "artifact";
}

function artifactHashKey(hash: string): string {
  return `artifact-hash:${hash}`;
}

function connectionKey(from: number, to: number, kind: string): string {
  return `connection:${from}:${to}:${kind}`;
}

function modelTierBanditKey(): string {
  return "model-tier-bandit:v1";
}

function tokenize(query: string): string[] {
  return query.toLowerCase().split(/[^a-z0-9_]+/).map((term) => term.trim()).filter((term) => term.length > 1);
}

function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index >= 0) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

function scoreArtifact(artifact: StoredBrainArtifact, terms: string[]): Omit<SearchScoreBreakdown, "connections" | "vector" | "total"> {
  const title = artifact.properties.title.toLowerCase();
  const content = artifact.properties.content.toLowerCase();
  const tags = artifact.properties.tags.map((tag) => tag.toLowerCase());
  const kind = artifact.kind.toLowerCase();
  return {
    lexical: terms.reduce((sum, term) => sum + occurrences(title, term) * 3 + occurrences(content, term), 0),
    tags: terms.reduce((sum, term) => sum + tags.reduce((tagSum, tag) => tagSum + (tag === term ? 4 : tag.includes(term) || term.includes(tag) ? 2 : 0), 0), 0),
    kind: terms.reduce((sum, term) => sum + (kind === term ? 3 : kind.includes(term) || term.includes(kind) ? 1 : 0), 0),
  };
}

function scoreConnections(
  artifact: StoredBrainArtifact,
  terms: string[],
  connections: StoredBrainConnection[],
  artifactsByRid: Map<number, StoredBrainArtifact>,
): number {
  let score = 0;
  for (const connection of connections) {
    const otherRid = connection.from_rid === artifact.rid
      ? connection.to_rid
      : connection.to_rid === artifact.rid
        ? connection.from_rid
        : null;
    if (otherRid == null) continue;
    const other = artifactsByRid.get(otherRid);
    if (!other) continue;
    const otherScore = withTotal({ ...scoreArtifact(other, terms), connections: 0, vector: 0 }).total;
    if (otherScore > 0) score += Math.min(otherScore, 12) * 0.35;
  }
  return roundScore(score);
}

function withTotal(parts: Omit<SearchScoreBreakdown, "total">): SearchScoreBreakdown {
  return {
    ...parts,
    lexical: roundScore(parts.lexical),
    tags: roundScore(parts.tags),
    kind: roundScore(parts.kind),
    connections: roundScore(parts.connections),
    vector: roundScore(parts.vector),
    total: roundScore(parts.lexical + parts.tags + parts.kind + parts.connections + parts.vector),
  };
}

function roundScore(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function excerpt(content: string, terms: string[]): string {
  if (content.length <= 220) return content;
  const lower = content.toLowerCase();
  const first = terms.map((term) => lower.indexOf(term)).filter((idx) => idx >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, first - 80);
  return `${start > 0 ? "..." : ""}${content.slice(start, start + 220)}${start + 220 < content.length ? "..." : ""}`;
}

function renderThinkResult(query: string, hits: SearchHit[]): BrainThinkResult {
  const confidence = hits.length === 0 ? "none" : hits[0]!.score >= 5 ? "high" : hits[0]!.score >= 3 ? "medium" : "low";
  const missing_evidence = hits.length === 0 ? [`No Brain artifacts matched "${query}".`] : [];
  return {
    answer: hits.length === 0
      ? `Brain has no cited evidence for "${query}".`
      : `Brain found ${hits.length} cited artifact${hits.length === 1 ? "" : "s"} for "${query}".`,
    hits,
    citations: hits.map((hit, index) => ({
      ref: `B${index + 1}`,
      rid: hit.artifact.rid,
      id: hit.artifact.properties.id,
      title: hit.artifact.properties.title,
      kind: hit.artifact.kind,
      score: hit.score,
      score_breakdown: hit.score_breakdown,
      excerpt: hit.excerpt,
    })),
    confidence,
    missing_evidence,
  };
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
