import { type QueryParam, type RedDB, connect } from "@reddb-io/sdk";
import { isOutcomeEvent, type OutcomeEvent } from "@reddb-io/shared/outcome-event.js";
import { contentHash, slugify } from "./hash.js";
import { KpiQuery, type KpiQueryInput, type KpiResult } from "./kpi-query.js";
import {
  MODEL_TIER_BANDIT_SCHEMA_VERSION,
  replayModelTierBandit,
  type ModelTierBanditDocument,
} from "./model-tier-bandit.js";
import {
  AUTO_LINK_CONNECTION_KINDS,
  artifactToAutoLinkArtifact,
  autoLinkThinkQuery,
  isAutoLinkConnectionKind,
  isDerivedArtifact,
  type AppliedBrainAutoLink,
  type BrainAutoLinkCandidate,
  type BrainAutoLinkProvider,
  type BrainAutoLinkRequest,
} from "./auto-linker.js";
import {
  ARTIFACT_KINDS,
  COLLECTIONS,
  CONNECTION_KINDS,
  INGESTION_KIND_ALIASES,
  type ArtifactKind,
  type BrainArtifact,
  type ConnectionKind,
  type StoredBrainArtifact,
  type StoredBrainConnection,
} from "./schema.js";

export interface BrainStoreOptions {
  uri: string;
  autoLinker?: BrainAutoLinkProvider;
  autoLinkErrors?: "ignore" | "throw";
}

export interface BrainStoreLike {
  close(): Promise<void>;
  status(): Promise<Record<string, unknown>>;
  capture(input: CaptureInput): Promise<StoredBrainArtifact>;
  getArtifact(ridOrId: number | string): Promise<StoredBrainArtifact | null>;
  listArtifacts(): Promise<StoredBrainArtifact[]>;
  search(query: string, limit?: number, options?: SearchOptions): Promise<SearchHit[]>;
  think(query: string, limit?: number, options?: ThinkOptions): Promise<BrainThinkResult>;
  link(input: {
    from: number | string;
    to: number | string;
    kind?: string;
    reason?: string;
    confidence?: "explicit" | "derived" | "inferred";
    metadata?: Record<string, unknown>;
  }): Promise<StoredBrainConnection>;
  backlinks(target: number | string): Promise<StoredBrainConnection[]>;
  listConnections(): Promise<StoredBrainConnection[]>;
  eventKpis(input?: KpiQueryInput): Promise<KpiResult>;
  appendOutcomeEvent(event: OutcomeEvent): Promise<OutcomeEvent>;
  replayOutcomeEvents(): Promise<OutcomeEvent[]>;
  loadModelTierBanditDocument(): Promise<ModelTierBanditDocument | null>;
  saveModelTierBanditDocument(document: ModelTierBanditDocument): Promise<ModelTierBanditDocument>;
  refreshModelTierBanditDocument(): Promise<ModelTierBanditDocument>;
}

export interface CaptureInput {
  title: string;
  content: string;
  kind?: string;
  tags?: string[];
  sourceAgent?: string;
  sourceRunner?: string;
  sourceSession?: string;
  sourcePath?: string;
  metadata?: Record<string, unknown>;
}

export interface SearchHit {
  artifact: StoredBrainArtifact;
  score: number;
  score_breakdown: SearchScoreBreakdown;
  excerpt: string;
}

export interface SearchScoreBreakdown {
  lexical: number;
  tags: number;
  kind: number;
  connections: number;
  vector: number;
  total: number;
}

export interface SearchOptions {
  excludeRids?: Iterable<number>;
}

export interface ThinkOptions extends SearchOptions {}

export type BrainThinkConfidence = "none" | "low" | "medium" | "high";

export interface BrainCitationSource {
  path?: string;
  session?: string;
  agent?: string;
  runner?: string;
}

export interface BrainCitation {
  ref: string;
  rid: number;
  id: string;
  title: string;
  kind: ArtifactKind;
  score: number;
  score_breakdown: SearchScoreBreakdown;
  excerpt: string;
  source?: BrainCitationSource;
}

export interface BrainThinkResult {
  answer: string;
  hits: SearchHit[];
  citations: BrainCitation[];
  confidence: BrainThinkConfidence;
  missing_evidence: string[];
}

export class BrainStore {
  private db!: RedDB;
  private artifactCache: StoredBrainArtifact[] | null = null;
  private connectionCache: StoredBrainConnection[] | null = null;
  private outcomeEventCache: OutcomeEvent[] | null = null;
  private modelTierBanditCache: ModelTierBanditDocument | null = null;

  private constructor(private readonly opts: BrainStoreOptions) {}

  static async open(opts: BrainStoreOptions): Promise<BrainStore> {
    const store = new BrainStore(opts);
    store.db = await connect(opts.uri);
    await store.bootstrap();
    return store;
  }

  get raw(): RedDB {
    return this.db;
  }

  async close(): Promise<void> {
    await this.db.close();
  }

  async bootstrap(): Promise<void> {
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.artifacts}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.connections}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.outcomeEvents}`);
  }

  private kv() {
    return this.db.kv(COLLECTIONS.kv);
  }

  async capture(input: CaptureInput): Promise<StoredBrainArtifact> {
    const kind = normalizeArtifactKind(input.kind ?? "note");
    const now = Date.now();
    const tags = normalizeTags(input.tags ?? []);
    const hash = contentHash([
      kind,
      input.title,
      input.content,
      tags,
      input.sourcePath,
      input.sourceSession,
    ]);
    const existingRid = await this.findArtifactByHash(hash);
    if (existingRid != null) {
      const existing = await this.getArtifact(existingRid);
      if (existing) return existing;
    }
    const existingArtifacts = await this.listArtifacts();

    const id = `${slugify(input.title)}-${hash.slice(0, 8)}`;
    const properties = {
      id,
      title: input.title,
      content: input.content,
      tags,
      source_agent: input.sourceAgent,
      source_runner: input.sourceRunner,
      source_session: input.sourceSession,
      source_path: input.sourcePath,
      created_at: now,
      updated_at: now,
      hash,
      metadata: input.metadata,
    };
    const artifact: BrainArtifact = {
      label: id,
      kind,
      properties,
    };
    const row = await this.db.query(
      `INSERT INTO ${COLLECTIONS.artifacts} NODE (label, node_type, hash, properties) VALUES ($1, $2, $3, $4) RETURNING *`,
      artifact.label,
      artifact.kind,
      hash,
      properties as unknown as QueryParam,
    );
    const inserted = row.rows[0];
    if (!inserted) throw new Error("INSERT artifact returned no row");
    const rid = Number(inserted.red_entity_id ?? inserted.rid);
    await this.kv().put(artifactHashKey(hash), rid);
    this.artifactCache = null;
    const stored = { ...artifact, rid };
    await this.autoLinkArtifact(stored, existingArtifacts);
    await this.materializeTagConnections(stored);
    return stored;
  }

  async getArtifact(ridOrId: number | string): Promise<StoredBrainArtifact | null> {
    const artifacts = await this.listArtifacts();
    if (typeof ridOrId === "number") {
      return artifacts.find((artifact) => artifact.rid === ridOrId) ?? null;
    }
    return artifacts.find((artifact) => artifact.properties.id === ridOrId || artifact.label === ridOrId) ?? null;
  }

  async listArtifacts(): Promise<StoredBrainArtifact[]> {
    if (this.artifactCache == null) {
      const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.artifacts}`);
      this.artifactCache = result.rows.map(rowToArtifact).filter(notNull);
    }
    return this.artifactCache;
  }

  async search(query: string, limit = 10, options: SearchOptions = {}): Promise<SearchHit[]> {
    const terms = tokenize(query);
    const excluded = new Set(options.excludeRids ?? []);
    const artifacts = await this.listArtifacts();
    const connections = await this.listConnections();
    const artifactsByRid = new Map(artifacts.map((artifact) => [artifact.rid, artifact]));
    const hits = artifacts
      .filter((artifact) => !excluded.has(artifact.rid))
      .map((artifact) => {
        const base = scoreArtifact(artifact, terms);
        const breakdown = withTotal({
          ...base,
          connections: scoreConnections(artifact, terms, connections, artifactsByRid),
          vector: 0,
        });
        return {
          artifact,
          score: breakdown.total,
          score_breakdown: breakdown,
          excerpt: excerpt(artifact.properties.content, terms),
        };
      })
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || b.artifact.properties.updated_at - a.artifact.properties.updated_at);
    return hits.slice(0, limit);
  }

  async link(input: {
    from: number | string;
    to: number | string;
    kind?: string;
    reason?: string;
    confidence?: "explicit" | "derived" | "inferred";
    metadata?: Record<string, unknown>;
  }): Promise<StoredBrainConnection> {
    const from = await this.getArtifact(input.from);
    const to = await this.getArtifact(input.to);
    if (!from) throw new Error(`Brain artifact not found: ${input.from}`);
    if (!to) throw new Error(`Brain artifact not found: ${input.to}`);
    const kind = normalizeConnectionKind(input.kind ?? "related_to");
    const existing = await this.findConnection(from.rid, to.rid, kind);
    if (existing != null) {
      const found = (await this.listConnections()).find((connection) => connection.rid === existing);
      if (found) return found;
    }
    const properties = {
      reason: input.reason,
      confidence: input.confidence ?? "explicit",
      created_at: Date.now(),
      metadata: input.metadata,
    };
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.connections} EDGE (label, from, to, weight, properties) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      kind,
      from.rid,
      to.rid,
      1.0,
      properties as unknown as QueryParam,
    );
    const row = result.rows[0];
    if (!row) throw new Error("INSERT connection returned no row");
    const rid = Number(row.red_entity_id ?? row.rid);
    await this.kv().put(connectionKey(from.rid, to.rid, kind), rid);
    this.connectionCache = null;
    return { rid, kind, from_rid: from.rid, to_rid: to.rid, weight: 1.0, properties };
  }

  async backlinks(target: number | string): Promise<StoredBrainConnection[]> {
    const artifact = await this.getArtifact(target);
    if (!artifact) throw new Error(`Brain artifact not found: ${target}`);
    return (await this.listConnections()).filter((connection) => connection.to_rid === artifact.rid);
  }

  async listConnections(): Promise<StoredBrainConnection[]> {
    if (this.connectionCache == null) {
      const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.connections}`);
      this.connectionCache = result.rows.map(rowToConnection).filter(notNull);
    }
    return this.connectionCache;
  }

  async status(): Promise<Record<string, unknown>> {
    const artifacts = await this.listArtifacts();
    const connections = await this.listConnections();
    return {
      uri: this.opts.uri,
      artifacts: artifacts.length,
      connections: connections.length,
      kinds: countBy(artifacts.map((artifact) => artifact.kind)),
    };
  }

  async eventKpis(input: KpiQueryInput = {}): Promise<KpiResult> {
    const artifacts = await this.listArtifacts();
    return new KpiQuery(artifacts).events(input);
  }

  async appendOutcomeEvent(event: OutcomeEvent): Promise<OutcomeEvent> {
    if (!isOutcomeEvent(event)) throw new Error("invalid Brain outcome event");
    const properties = { ...event };
    const result = await this.db.query(
      `INSERT INTO ${COLLECTIONS.outcomeEvents} NODE (label, node_type, properties) VALUES ($1, $2, $3) RETURNING *`,
      event.id,
      `outcome_event.v${event.schemaVersion}`,
      properties as unknown as QueryParam,
    );
    if (!result.rows[0]) throw new Error("INSERT outcome event returned no row");
    this.outcomeEventCache = null;
    return event;
  }

  async replayOutcomeEvents(): Promise<OutcomeEvent[]> {
    if (this.outcomeEventCache == null) {
      const result = await this.db.query(`SELECT * FROM ${COLLECTIONS.outcomeEvents}`);
      this.outcomeEventCache = result.rows
        .map(rowToOutcomeEvent)
        .filter(notNull)
        .sort((a, b) => a.rid - b.rid)
        .map(({ rid: _rid, event }) => event);
    }
    return [...this.outcomeEventCache];
  }

  async loadModelTierBanditDocument(): Promise<ModelTierBanditDocument | null> {
    if (this.modelTierBanditCache != null) return this.modelTierBanditCache;
    const stored = await this.kv().get(modelTierBanditKey());
    if (stored == null) return null;
    const parsed = typeof stored === "string" ? (JSON.parse(stored) as unknown) : stored;
    if (!isModelTierBanditDocument(parsed)) return null;
    this.modelTierBanditCache = parsed;
    return parsed;
  }

  async saveModelTierBanditDocument(document: ModelTierBanditDocument): Promise<ModelTierBanditDocument> {
    if (!isModelTierBanditDocument(document)) throw new Error("invalid Brain model-tier bandit document");
    await this.kv().put(modelTierBanditKey(), JSON.stringify(document));
    this.modelTierBanditCache = document;
    return document;
  }

  async refreshModelTierBanditDocument(): Promise<ModelTierBanditDocument> {
    const document = replayModelTierBandit(await this.replayOutcomeEvents());
    return this.saveModelTierBanditDocument(document);
  }

  async think(query: string, limit = 8, options: ThinkOptions = {}): Promise<BrainThinkResult> {
    const hits = (await this.search(query, Math.max(limit * 2, limit + 5), options))
      .filter((hit) => !isDerivedArtifact(hit.artifact))
      .slice(0, limit);
    return renderThinkResult(query, hits);
  }

  async deriveAutoLinks(artifact: StoredBrainArtifact): Promise<AppliedBrainAutoLink[]> {
    return this.autoLinkArtifact(artifact, await this.listArtifacts());
  }

  private async findArtifactByHash(hash: string): Promise<number | null> {
    const rid = await this.kv().get(artifactHashKey(hash));
    return rid != null ? Number(rid) : null;
  }

  private async findConnection(from: number, to: number, kind: ConnectionKind): Promise<number | null> {
    const rid = await this.kv().get(connectionKey(from, to, kind));
    return rid != null ? Number(rid) : null;
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

  private async autoLinkArtifact(
    artifact: StoredBrainArtifact,
    existingArtifacts: StoredBrainArtifact[],
  ): Promise<AppliedBrainAutoLink[]> {
    if (!this.opts.autoLinker || isDerivedArtifact(artifact)) return [];
    const existingRids = new Set(
      existingArtifacts
        .filter((candidate) => candidate.rid !== artifact.rid)
        .map((candidate) => candidate.rid),
    );
    if (existingRids.size === 0) return [];

    try {
      const query = autoLinkThinkQuery(artifact);
      const excluded = new Set<number>([artifact.rid]);
      for (const existing of existingArtifacts) {
        if (isDerivedArtifact(existing)) excluded.add(existing.rid);
      }
      const think = await this.think(query, 8, { excludeRids: excluded });
      const candidates = think.hits
        .filter((hit) => existingRids.has(hit.artifact.rid) && !isDerivedArtifact(hit.artifact))
        .map((hit): BrainAutoLinkCandidate => ({
          artifact: artifactToAutoLinkArtifact(hit.artifact),
          score: hit.score,
          excerpt: hit.excerpt,
        }));
      if (candidates.length === 0) return [];
      const request: BrainAutoLinkRequest = {
        newArtifact: artifactToAutoLinkArtifact(artifact),
        candidates,
        think: { query, answer: think.answer },
        allowedKinds: AUTO_LINK_CONNECTION_KINDS,
      };
      const proposals = await this.opts.autoLinker.deriveConnections(request);
      const applied: AppliedBrainAutoLink[] = [];
      for (const proposal of proposals) {
        if (!isAutoLinkConnectionKind(proposal.kind)) continue;
        const from = await this.getArtifact(proposal.from);
        const to = await this.getArtifact(proposal.to);
        if (!from || !to) continue;
        const connectsNew = from.rid === artifact.rid || to.rid === artifact.rid;
        const connectsExisting = existingRids.has(from.rid) || existingRids.has(to.rid);
        if (!connectsNew || !connectsExisting || from.rid === to.rid) continue;
        const connection = await this.link({
          from: from.rid,
          to: to.rid,
          kind: proposal.kind,
          reason: proposal.reason,
          confidence: "derived",
          metadata: {
            ...(proposal.metadata ?? {}),
            derived_by: "brain.autolink.afk-headless",
            source_artifact_rid: artifact.rid,
          },
        });
        applied.push({ proposal, connection });
      }
      return applied;
    } catch (err) {
      if (this.opts.autoLinkErrors === "throw") throw err;
      return [];
    }
  }
}

export function normalizeArtifactKind(value: string): ArtifactKind {
  const mapped = (INGESTION_KIND_ALIASES as Record<string, ArtifactKind | undefined>)[value];
  const candidate = mapped ?? value;
  if ((ARTIFACT_KINDS as readonly string[]).includes(candidate)) return candidate as ArtifactKind;
  throw new Error(`invalid Brain artifact kind: ${value}`);
}

export function normalizeConnectionKind(value: string): ConnectionKind {
  if ((CONNECTION_KINDS as readonly string[]).includes(value)) return value as ConnectionKind;
  throw new Error(`invalid Brain connection kind: ${value}`);
}

function rowToArtifact(row: Record<string, unknown>): StoredBrainArtifact | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  const properties = parseProperties(row.properties ?? row.PROPERTIES);
  const kind = String(row.node_type ?? row.NODE_TYPE ?? properties.kind ?? "note");
  if (!Number.isFinite(rid)) return null;
  const id = String(properties.id ?? row.label ?? row.LABEL ?? rid);
  const title = String(properties.title ?? row.label ?? row.LABEL ?? id);
  const content = String(properties.content ?? "");
  const tags = Array.isArray(properties.tags) ? properties.tags.map(String) : [];
  const now = Date.now();
  return {
    rid,
    label: String(row.label ?? row.LABEL ?? id),
    kind: normalizeArtifactKind(kind),
    properties: {
      ...properties,
      id,
      title,
      content,
      tags,
      created_at: Number(properties.created_at ?? now),
      updated_at: Number(properties.updated_at ?? properties.created_at ?? now),
      hash: String(properties.hash ?? ""),
    } as unknown as StoredBrainArtifact["properties"],
  };
}

function rowToConnection(row: Record<string, unknown>): StoredBrainConnection | null {
  const rid = Number(row.red_entity_id ?? row.rid);
  const from = Number(row.from ?? row.FROM ?? row.from_rid ?? row.source);
  const to = Number(row.to ?? row.TO ?? row.to_rid ?? row.target);
  const kind = String(row.label ?? row.LABEL ?? "related_to");
  if (!Number.isFinite(rid) || !Number.isFinite(from) || !Number.isFinite(to)) return null;
  return {
    rid,
    kind: normalizeConnectionKind(kind),
    from_rid: from,
    to_rid: to,
    weight: Number(row.weight ?? 1),
    properties: parseProperties(row.properties ?? row.PROPERTIES) as unknown as StoredBrainConnection["properties"],
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
  return value as Record<string, unknown>;
}

function notNull<T>(value: T | null): value is T {
  return value != null;
}

function normalizeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).sort();
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1);
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

function scoreArtifact(
  artifact: StoredBrainArtifact,
  terms: string[],
): Omit<SearchScoreBreakdown, "connections" | "vector" | "total"> {
  const title = artifact.properties.title.toLowerCase();
  const content = artifact.properties.content.toLowerCase();
  const tags = artifact.properties.tags.map((tag) => tag.toLowerCase());
  const kind = artifact.kind.toLowerCase();
  return {
    lexical: terms.reduce(
      (sum, term) => sum + occurrences(title, term) * 3 + occurrences(content, term),
      0,
    ),
    tags: terms.reduce((sum, term) => {
      const tagScore = tags.reduce((tagSum, tag) => {
        if (tag === term) return tagSum + 4;
        if (tag.includes(term) || term.includes(tag)) return tagSum + 2;
        return tagSum;
      }, 0);
      return sum + tagScore;
    }, 0),
    kind: terms.reduce((sum, term) => {
      if (kind === term) return sum + 3;
      return kind.includes(term) || term.includes(kind) ? sum + 1 : sum;
    }, 0),
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
    const otherRid =
      connection.from_rid === artifact.rid
        ? connection.to_rid
        : connection.to_rid === artifact.rid
          ? connection.from_rid
          : null;
    if (otherRid == null) continue;
    const other = artifactsByRid.get(otherRid);
    if (!other || isDerivedArtifact(other)) continue;
    const otherScore = withTotal({ ...scoreArtifact(other, terms), connections: 0, vector: 0 }).total;
    if (otherScore <= 0) continue;
    score += Math.min(otherScore, 12) * connectionKindWeight(connection.kind);
  }
  return roundScore(score * 0.35);
}

function connectionKindWeight(kind: ConnectionKind): number {
  switch (kind) {
    case "supports":
    case "contradicts":
    case "depends_on":
    case "derived_from":
    case "part_of":
      return 1;
    case "related_to":
    case "authored":
      return 0.75;
    case "preceded_by":
    case "followed_by":
      return 0.5;
    case "tagged":
      return 0.2;
  }
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
  const citations = hits.map(hitToCitation);
  const confidence = classifyThinkConfidence(hits);
  const missingEvidence = thinkMissingEvidence(query, citations, confidence);
  return {
    hits,
    citations,
    confidence,
    missing_evidence: missingEvidence,
    answer: renderThinkAnswer(query, citations, confidence, missingEvidence),
  };
}

function hitToCitation(hit: SearchHit, index: number): BrainCitation {
  const artifact = hit.artifact;
  const source: BrainCitationSource = {};
  if (artifact.properties.source_path) source.path = artifact.properties.source_path;
  if (artifact.properties.source_session) source.session = artifact.properties.source_session;
  if (artifact.properties.source_agent) source.agent = artifact.properties.source_agent;
  if (artifact.properties.source_runner) source.runner = artifact.properties.source_runner;
  return {
    ref: `B${index + 1}`,
    rid: artifact.rid,
    id: artifact.properties.id,
    title: artifact.properties.title,
    kind: artifact.kind,
    score: hit.score,
    score_breakdown: hit.score_breakdown,
    excerpt: hit.excerpt,
    source: Object.keys(source).length > 0 ? source : undefined,
  };
}

function classifyThinkConfidence(hits: SearchHit[]): BrainThinkConfidence {
  const top = hits[0];
  if (!top) return "none";
  const signalCount = Object.entries(top.score_breakdown)
    .filter(([key, value]) => key !== "total" && value > 0)
    .length;
  if (top.score >= 8 || (top.score >= 5 && signalCount >= 2)) return "high";
  if (top.score >= 3) return "medium";
  return "low";
}

function thinkMissingEvidence(
  query: string,
  citations: BrainCitation[],
  confidence: BrainThinkConfidence,
): string[] {
  if (citations.length === 0) {
    return [`No Brain artifacts matched "${query}". Capture or ingest cited artifacts before relying on Brain for this answer.`];
  }
  const gaps: string[] = [];
  if (confidence === "low") {
    gaps.push("Only low-scoring deterministic matches were found; open the cited artifacts before treating this as settled.");
  }
  if (citations.length === 1) {
    gaps.push("Only one cited artifact matched; missing context or contradictions may not be visible yet.");
  }
  if (citations.every((citation) => citation.source == null)) {
    gaps.push("The matched artifacts do not carry source path, session, agent, or runner provenance.");
  }
  return gaps;
}

function renderThinkAnswer(
  query: string,
  citations: BrainCitation[],
  confidence: BrainThinkConfidence,
  missingEvidence: string[],
): string {
  if (citations.length === 0) {
    return [
      `Brain has no cited evidence for "${query}".`,
      "",
      "Missing evidence:",
      ...missingEvidence.map((gap) => `- ${gap}`),
    ].join("\n");
  }

  const evidenceLines = citations.slice(0, 5).map((citation) => {
    return `- ${citation.title}: ${citation.excerpt} [${citation.ref}]`;
  });
  const citationLines = citations.map((citation) => {
    const signals = Object.entries(citation.score_breakdown)
      .filter(([key, value]) => key !== "total" && value > 0)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ");
    return `[${citation.ref}] ${citation.title} (${citation.kind}, rid ${citation.rid}, score ${citation.score})${signals ? ` [${signals}]` : ""}; ${renderCitationSource(citation)}`;
  });
  const gaps =
    missingEvidence.length > 0
      ? missingEvidence.map((gap) => `- ${gap}`)
      : ["- No deterministic evidence gap detected in the returned Brain citations."];

  return [
    `Brain answer for "${query}"`,
    "",
    `Confidence: ${confidence}`,
    "",
    "Best cited evidence:",
    ...evidenceLines,
    "",
    "Missing evidence:",
    ...gaps,
    "",
    "Citations:",
    ...citationLines,
  ].join("\n");
}

function renderCitationSource(citation: BrainCitation): string {
  if (!citation.source) return `source: Brain artifact ${citation.id}`;
  const parts = [
    citation.source.path ? `path ${citation.source.path}` : null,
    citation.source.session ? `session ${citation.source.session}` : null,
    citation.source.agent ? `agent ${citation.source.agent}` : null,
    citation.source.runner ? `runner ${citation.source.runner}` : null,
  ].filter(notNull);
  return `source: ${parts.length > 0 ? parts.join(", ") : `Brain artifact ${citation.id}`}`;
}

function artifactHashKey(hash: string): string {
  return `artifact.hash.${hash}`;
}

function connectionKey(from: number, to: number, kind: ConnectionKind): string {
  return `connection.${from}.${kind}.${to}`;
}

function modelTierBanditKey(): string {
  return `model-tier-bandit.v${MODEL_TIER_BANDIT_SCHEMA_VERSION}`;
}

function isModelTierBanditDocument(value: unknown): value is ModelTierBanditDocument {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return candidate.schemaVersion === MODEL_TIER_BANDIT_SCHEMA_VERSION && typeof candidate.buckets === "object";
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}
