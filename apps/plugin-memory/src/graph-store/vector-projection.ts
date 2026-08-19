import type { RedDB } from "@reddb-io/sdk";
import { contentHash } from "../hash.js";
import { COLLECTIONS, type MemoryDoc, type MemoryNode, type NodeType } from "../schema.js";
import { clampLimit, escapeLabel } from "./helpers.js";
import type {
  SearchRow,
  StoredNode,
  VectorDocStatus,
  VectorNodeStatus,
  VectorProjectionState,
  VectorStatusReport,
} from "./types.js";

type VectorKvClient = ReturnType<RedDB["kv"]>;

interface MemoryVectorProjectionContext {
  db: RedDB;
  kv: () => VectorKvClient;
  project: string;
  listNodes: () => Promise<StoredNode[]>;
  listDocs: () => Promise<Array<MemoryDoc & { rid: number }>>;
}

interface VectorProjectionRecord {
  rid: number;
  node_rid: number;
  doc_rid?: number;
  node_hash?: string;
  text_hash: string;
  label: string;
  node_type?: NodeType;
  path?: string;
  title?: string | null;
  text_length: number;
  source_collection: string;
  project: string;
  provider: string;
  updated_at: number;
}

interface LocalVectorProjectionRecord extends VectorProjectionRecord {
  embedding: string | number[];
}

interface VectorFailureRecord {
  status: "unavailable" | "failed";
  error: string;
  text_hash: string;
  updated_at: number;
}

function vectorText(node: MemoryNode): string {
  const p = node.properties;
  const tags = Array.isArray(p.tags) ? p.tags.join(" ") : "";
  return [node.label, p.title, p.summary, p.content, tags].filter(Boolean).join("\n");
}

function vectorTextHash(node: MemoryNode): string {
  return contentHash("memory-vector", vectorText(node));
}

function docVectorText(doc: MemoryDoc): string {
  const frontmatter = Object.entries(doc.frontmatter ?? {})
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join("\n");
  return [doc.path, doc.title, frontmatter, doc.body].filter(Boolean).join("\n");
}

function docVectorTextHash(doc: MemoryDoc): string {
  return contentHash("memory-doc-vector", docVectorText(doc));
}

function vectorProvider(strict: boolean): string | null {
  if (!strict && process.env.RED_MEMORY_VECTOR_PROVIDER == null) return null;
  const provider = process.env.RED_MEMORY_VECTOR_PROVIDER ?? "openai";
  if (/^[a-zA-Z0-9_-]+$/.test(provider)) return provider;
  return "openai";
}

function isLocalVectorProvider(provider: string): boolean {
  return provider === "local" || provider === "local-dev";
}

const LOCAL_VECTOR_PROVIDER = "local";
const LOCAL_VECTOR_INDEX_KEY = "vector:local:index";
const LOCAL_VECTOR_DIMENSIONS = 128;

function localEmbedding(text: string): number[] {
  const vector = Array.from({ length: LOCAL_VECTOR_DIMENSIONS }, () => 0);
  for (const token of localEmbeddingTokens(text)) {
    const hash = positiveHash(token);
    const index = hash % LOCAL_VECTOR_DIMENSIONS;
    const sign = hash % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) return vector;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function encodeLocalEmbedding(vector: number[]): string {
  return Buffer.from(
    vector.map((value) => Math.max(-127, Math.min(127, Math.round(value * 127))) & 0xff),
  ).toString("base64");
}

function decodeLocalEmbedding(embedding: string | number[]): number[] {
  if (Array.isArray(embedding)) return embedding;
  const bytes = Buffer.from(embedding, "base64");
  return Array.from(bytes, (byte) => (byte > 127 ? byte - 256 : byte) / 127);
}

function localEmbeddingTokens(text: string): string[] {
  return text
    .toLowerCase()
    .match(/[a-z0-9_]+/g)
    ?.filter((token) => token.length > 1) ?? [];
}

function positiveHash(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const length = Math.min(a.length, b.length);
  let score = 0;
  for (let i = 0; i < length; i++) score += a[i] * b[i];
  return Number(Math.max(0, score).toFixed(6));
}

function classifyVectorFailure(
  err: unknown,
  textHash: string,
  updatedAt: number,
): VectorFailureRecord {
  const error = err instanceof Error ? err.message : String(err);
  const truncatedError = error.slice(0, 500);
  const status = /api[_ -]?key|credential|provider|unauthorized|auth|not configured|OPENAI/i.test(
    error,
  )
    ? "unavailable"
    : "failed";
  return { status, error: truncatedError, text_hash: textHash, updated_at: updatedAt };
}

function latestVectorRecords(
  records: VectorProjectionRecord[],
): Map<string, VectorProjectionRecord> {
  const out = new Map<string, VectorProjectionRecord>();
  for (const record of records) {
    const targetRid = record.source_collection === COLLECTIONS.docs ? record.doc_rid : record.node_rid;
    if (!Number.isFinite(targetRid)) continue;
    const key = vectorTargetKey(record.source_collection, Number(targetRid));
    const prev = out.get(key);
    if (!prev || record.updated_at >= prev.updated_at) out.set(key, record);
  }
  return out;
}

function vectorTargetKey(sourceCollection: string, rid: number): string {
  return `${sourceCollection}:${rid}`;
}

function vectorOverall(counts: {
  ready: number;
  stale: number;
  unavailable: number;
  failed: number;
}): VectorProjectionState {
  if (counts.failed > 0) return "failed";
  if (counts.unavailable > 0) return "unavailable";
  if (counts.stale > 0) return "stale";
  return "ready";
}

function rowToVectorRecord(row: Record<string, unknown>): VectorProjectionRecord {
  const props = (row.properties ?? row.PROPERTIES ?? {}) as Record<string, unknown>;
  const get = (key: string) => row[key] ?? row[key.toUpperCase()] ?? props[key];
  return {
    rid: Number(get("rid") ?? row.red_entity_id ?? 0),
    node_rid: Number(get("node_rid")),
    doc_rid: get("doc_rid") == null ? undefined : Number(get("doc_rid")),
    node_hash: get("node_hash") == null ? undefined : String(get("node_hash")),
    text_hash: String(get("text_hash") ?? ""),
    label: String(get("label") ?? ""),
    node_type: get("node_type") == null ? undefined : (get("node_type") as NodeType),
    path: get("path") == null ? undefined : String(get("path")),
    title: get("title") == null ? null : String(get("title")),
    text_length: Number(get("text_length") ?? 0),
    source_collection: String(get("source_collection") ?? COLLECTIONS.nodes),
    project: String(get("project") ?? "default"),
    provider: String(get("provider") ?? "unknown"),
    updated_at: Number(get("updated_at") ?? 0),
  };
}

function hasVectorTarget(row: VectorProjectionRecord): boolean {
  if (row.source_collection === COLLECTIONS.docs) return Number.isFinite(row.doc_rid);
  return Number.isFinite(row.node_rid);
}

interface VectorSearchHit {
  entity_id?: number;
  node_rid?: number;
  doc_rid?: number;
  node_hash?: string;
  source_collection: string;
  score: number;
}

function rowToVectorSearchHit(row: Record<string, unknown>): VectorSearchHit {
  const props = (row.properties ?? row.PROPERTIES ?? {}) as Record<string, unknown>;
  const get = (key: string) => row[key] ?? row[key.toUpperCase()] ?? props[key];
  return {
    entity_id: optionalNumber(get("entity_id") ?? row.red_entity_id),
    node_rid: optionalNumber(get("node_rid")),
    doc_rid: optionalNumber(get("doc_rid")),
    node_hash: get("node_hash") == null ? undefined : String(get("node_hash")),
    source_collection: String(get("source_collection") ?? COLLECTIONS.nodes),
    score: Number(get("similarity") ?? get("score") ?? 1),
  };
}

function optionalNumber(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function vectorFailureKey(rid: number): string {
  return `vector:failure:${rid}`;
}

function docVectorFailureKey(rid: number): string {
  return `vector:failure:doc:${rid}`;
}

function localVectorKey(sourceCollection: string, rid: number): string {
  return `vector:local:${sourceCollection}:${rid}`;
}


export class MemoryVectorProjection {
  constructor(private readonly ctx: MemoryVectorProjectionContext) {}

  private get db(): RedDB {
    return this.ctx.db;
  }

  private get project(): string {
    return this.ctx.project;
  }

  private kv(): VectorKvClient {
    return this.ctx.kv();
  }

  private async listNodes(): Promise<StoredNode[]> {
    return this.ctx.listNodes();
  }

  private async listDocs(): Promise<Array<MemoryDoc & { rid: number }>> {
    return this.ctx.listDocs();
  }

  /**
   * Semantic vector search over the projected vector rows. Node vectors map
   * directly to Memory node rids. Document vectors map through their source hash
   * to the ingested markdown root node, so recall still applies its normal
   * scope, supersession, tier, trust, recency, and centrality governance.
   */
  async searchVector(query: string, limit = 20): Promise<SearchRow[]> {
    const provider = await this.vectorReadProvider();
    if (provider == null) {
      throw new Error("RED_MEMORY_VECTOR_PROVIDER is not configured");
    }
    if (isLocalVectorProvider(provider)) {
      return this.searchLocalVector(query, limit);
    }
    const r = await this.db.query(
      `SEARCH SIMILAR TEXT '${escapeLabel(query)}' COLLECTION ${COLLECTIONS.vectors} USING ${provider} LIMIT ${clampLimit(limit)}`,
    );
    return this.groundVectorSearchRows(r.rows);
  }

  private async searchLocalVector(query: string, limit = 20): Promise<SearchRow[]> {
    const queryEmbedding = localEmbedding(query);
    const rows = (await this.listLocalVectorRecords())
      .map((record) => ({
        record,
        score: cosineSimilarity(queryEmbedding, decodeLocalEmbedding(record.embedding)),
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.record.label.localeCompare(b.record.label))
      .slice(0, clampLimit(limit));
    const hashToNodeRid = new Map<string, number>();
    const out: SearchRow[] = [];
    for (const { record, score } of rows) {
      if (record.source_collection === COLLECTIONS.nodes) {
        out.push({ rid: record.node_rid, score });
        continue;
      }
      if (record.source_collection !== COLLECTIONS.docs || !record.node_hash) continue;
      if (hashToNodeRid.size === 0) {
        for (const node of await this.listNodes()) {
          const hash = node.properties.hash;
          if (typeof hash === "string") hashToNodeRid.set(hash, node.rid);
        }
      }
      const rid = hashToNodeRid.get(record.node_hash);
      if (rid != null) out.push({ rid, score });
    }
    return out;
  }

  private async groundVectorSearchRows(rows: Record<string, unknown>[]): Promise<SearchRow[]> {
    const hashToNodeRid = new Map<string, number>();
    const out: SearchRow[] = [];
    for (const row of rows) {
      const hit = rowToVectorSearchHit(row);
      if (hit.source_collection === COLLECTIONS.nodes) {
        const rid = Number(hit.node_rid ?? hit.entity_id);
        if (Number.isFinite(rid)) out.push({ rid, score: hit.score });
        continue;
      }
      if (hit.source_collection !== COLLECTIONS.docs || !hit.node_hash) continue;
      if (hashToNodeRid.size === 0) {
        for (const node of await this.listNodes()) {
          const hash = node.properties.hash;
          if (typeof hash === "string") hashToNodeRid.set(hash, node.rid);
        }
      }
      const rid = hashToNodeRid.get(hit.node_hash);
      if (rid != null) out.push({ rid, score: hit.score });
    }
    return out;
  }

  // -------------------------------------------------------------------
  // Vector projection
  // -------------------------------------------------------------------

  /**
   * Best-effort mirror of Memory node text into RedDB's native vector path.
   * The engine owns embedding (`WITH AUTO EMBED`); Memory only records enough
   * node metadata to report freshness and retry strictly from maintenance.
   */
  async projectNodeVector(
    rid: number,
    node: MemoryNode,
    strict: boolean,
  ): Promise<VectorProjectionState> {
    const text = vectorText(node);
    const textHash = vectorTextHash(node);
    const provider = vectorProvider(strict);
    const updatedAt = Date.now();
    if (provider == null) {
      return "unavailable";
    }
    if (isLocalVectorProvider(provider)) {
      await this.recordLocalVector({
        rid,
        node_rid: rid,
        node_hash: node.properties.hash,
        text_hash: textHash,
        label: node.label,
        node_type: node.node_type,
        text_length: text.length,
        source_collection: COLLECTIONS.nodes,
        project: node.properties.project ?? this.project,
        provider,
        updated_at: updatedAt,
        embedding: encodeLocalEmbedding(localEmbedding(text)),
      });
      await this.clearVectorFailure(rid);
      return "ready";
    }
    try {
      await this.db.query(
        `INSERT INTO ${COLLECTIONS.vectors} (node_rid, node_hash, text_hash, text, label, node_type, text_length, source_collection, project, provider, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) WITH AUTO EMBED (text) USING ${provider} RETURNING *`,
        rid,
        node.properties.hash ?? null,
        textHash,
        text,
        node.label,
        node.node_type,
        text.length,
        COLLECTIONS.nodes,
        node.properties.project ?? this.project,
        provider,
        updatedAt,
      );
      await this.clearVectorFailure(rid);
      return "ready";
    } catch (err) {
      const failure = classifyVectorFailure(err, textHash, updatedAt);
      await this.recordVectorFailure(rid, failure);
      if (strict) throw new Error(`vector projection ${failure.status}: ${failure.error}`);
      return failure.status;
    }
  }

  /**
   * Best-effort vector projection for document chunks. These records are kept
   * in the same RedDB vector collection so readiness can prove doc coverage,
   * but recall only accepts node-backed vector hits until doc->node grounding is
   * explicit.
   */
  async projectDocVector(
    rid: number,
    doc: MemoryDoc,
    strict: boolean,
  ): Promise<VectorProjectionState> {
    const text = docVectorText(doc);
    const textHash = docVectorTextHash(doc);
    const provider = vectorProvider(strict);
    const updatedAt = Date.now();
    if (provider == null) {
      return "unavailable";
    }
    if (isLocalVectorProvider(provider)) {
      await this.recordLocalVector({
        rid,
        node_rid: 0,
        doc_rid: rid,
        node_hash: doc.hash,
        text_hash: textHash,
        label: `doc:${doc.path}`,
        path: doc.path,
        title: doc.title ?? null,
        text_length: text.length,
        source_collection: COLLECTIONS.docs,
        project: this.project,
        provider,
        updated_at: updatedAt,
        embedding: encodeLocalEmbedding(localEmbedding(text)),
      });
      await this.clearVectorFailure(docVectorFailureKey(rid));
      return "ready";
    }
    try {
      await this.db.query(
        `INSERT INTO ${COLLECTIONS.vectors} (doc_rid, node_hash, text_hash, text, label, path, title, text_length, source_collection, project, provider, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) WITH AUTO EMBED (text) USING ${provider} RETURNING *`,
        rid,
        doc.hash,
        textHash,
        text,
        `doc:${doc.path}`,
        doc.path,
        doc.title ?? null,
        text.length,
        COLLECTIONS.docs,
        this.project,
        provider,
        updatedAt,
      );
      await this.clearVectorFailure(docVectorFailureKey(rid));
      return "ready";
    } catch (err) {
      const failure = classifyVectorFailure(err, textHash, updatedAt);
      await this.recordVectorFailure(docVectorFailureKey(rid), failure);
      if (strict) throw new Error(`vector projection ${failure.status}: ${failure.error}`);
      return failure.status;
    }
  }

  async maintainVectorProjection(opts: { strict?: boolean } = {}): Promise<VectorStatusReport> {
    const strict = opts.strict === true;
    for (const node of await this.listNodes()) {
      await this.projectNodeVector(node.rid, node, strict);
    }
    for (const doc of await this.listDocs()) {
      await this.projectDocVector(doc.rid, doc, strict);
    }
    const report = await this.vectorStatus();
    if (strict && report.overall !== "ready") {
      throw new Error(`vector projection not ready: ${report.overall}`);
    }
    return report;
  }

  async vectorStatus(): Promise<VectorStatusReport> {
    const nodes = await this.listNodes();
    const docs = await this.listDocs();
    const provider = await this.vectorReadProvider();
    const records = provider == null ? [] : await this.listVectorRecords(provider);
    const byTarget = latestVectorRecords(records);
    const failures = await Promise.all(nodes.map((node) => this.readVectorFailure(node.rid)));
    const statuses: VectorNodeStatus[] = nodes.map((node, index) => {
      const expected = vectorTextHash(node);
      const projected = byTarget.get(vectorTargetKey(COLLECTIONS.nodes, node.rid));
      if (projected) {
        return {
          source_collection: COLLECTIONS.nodes,
          rid: node.rid,
          label: node.label,
          node_type: node.node_type,
          status: projected.text_hash === expected ? "ready" : "stale",
          text_hash: expected,
          projected_text_hash: projected.text_hash,
          updated_at: projected.updated_at,
        };
      }
      const failure = failures[index];
      return {
        source_collection: COLLECTIONS.nodes,
        rid: node.rid,
        label: node.label,
        node_type: node.node_type,
        status: failure?.status ?? "unavailable",
        text_hash: expected,
        error: failure?.error,
        updated_at: failure?.updated_at,
      };
    });
    const docFailures = await Promise.all(
      docs.map((doc) => this.readVectorFailure(docVectorFailureKey(doc.rid))),
    );
    const docStatuses: VectorDocStatus[] = docs.map((doc, index) => {
      const expected = docVectorTextHash(doc);
      const projected = byTarget.get(vectorTargetKey(COLLECTIONS.docs, doc.rid));
      if (projected) {
        return {
          source_collection: COLLECTIONS.docs,
          rid: doc.rid,
          path: doc.path,
          title: doc.title ?? null,
          status: projected.text_hash === expected ? "ready" : "stale",
          text_hash: expected,
          projected_text_hash: projected.text_hash,
          updated_at: projected.updated_at,
        };
      }
      const failure = docFailures[index];
      return {
        source_collection: COLLECTIONS.docs,
        rid: doc.rid,
        path: doc.path,
        title: doc.title ?? null,
        status: failure?.status ?? "unavailable",
        text_hash: expected,
        error: failure?.error,
        updated_at: failure?.updated_at,
      };
    });

    const allStatuses = [...statuses, ...docStatuses];
    const ready = allStatuses.filter((s) => s.status === "ready").length;
    const stale = allStatuses.filter((s) => s.status === "stale").length;
    const unavailable = allStatuses.filter((s) => s.status === "unavailable").length;
    const failed = allStatuses.filter((s) => s.status === "failed").length;
    return {
      schema_version: "memory.vector_status.v1",
      read_only: true,
      overall: vectorOverall({ ready, stale, unavailable, failed }),
      total: allStatuses.length,
      ready,
      stale,
      unavailable,
      failed,
      nodes: statuses,
      docs: docStatuses,
    };
  }

  private async listVectorRecords(provider: string): Promise<VectorProjectionRecord[]> {
    const localRecords = await this.listLocalVectorRecords();
    try {
      const r = await this.db.query(`SELECT * FROM ${COLLECTIONS.vectors}`);
      return [...r.rows.map(rowToVectorRecord).filter(hasVectorTarget), ...localRecords].filter(
        (record) => record.provider === provider,
      );
    } catch {
      return localRecords.filter((record) => record.provider === provider);
    }
  }

  private async vectorReadProvider(): Promise<string | null> {
    const configured = vectorProvider(false);
    if (configured != null) return configured;

    // Fast-path local-dev vector auto-discovery. Older code detected local
    // vectors by probing one KV key per node/doc on every recall; on a 1k-node
    // graph that made the zero-token recall hot path spend seconds in KV reads
    // even when no vectors existed. New local projections maintain one aggregate
    // index, so the common "not configured" path is a single KV read.
    return (await this.readLocalVectorIndex()).size > 0 ? LOCAL_VECTOR_PROVIDER : null;
  }

  private async listLocalVectorRecords(): Promise<LocalVectorProjectionRecord[]> {
    const indexed = await this.readLocalVectorIndex();
    const records = await Promise.all([...indexed.values()].map((key) => this.readLocalVectorKey(key)));
    return records.filter((record): record is LocalVectorProjectionRecord => record !== null);
  }

  private async readLocalVector(
    sourceCollection: string,
    rid: number,
  ): Promise<LocalVectorProjectionRecord | null> {
    const raw = await this.kv().get(localVectorKey(sourceCollection, rid));
    if (raw == null) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as LocalVectorProjectionRecord;
  }

  private async recordLocalVector(record: LocalVectorProjectionRecord): Promise<void> {
    const targetRid =
      record.source_collection === COLLECTIONS.docs ? record.doc_rid : record.node_rid;
    if (!Number.isFinite(targetRid)) return;
    await this.kv().put(localVectorKey(record.source_collection, Number(targetRid)), record);
    const index = await this.readLocalVectorIndex();
    index.set(
      vectorTargetKey(record.source_collection, Number(targetRid)),
      localVectorKey(record.source_collection, Number(targetRid)),
    );
    await this.writeLocalVectorIndex(index);
  }

  private async readLocalVectorIndex(): Promise<Map<string, string>> {
    const raw = await this.kv().get(LOCAL_VECTOR_INDEX_KEY);
    if (raw == null) return new Map();
    const parsed = (typeof raw === "string" ? JSON.parse(raw) : raw) as
      | Record<string, string | LocalVectorProjectionRecord>
      | LocalVectorProjectionRecord[];
    if (Array.isArray(parsed)) {
      return new Map(
        parsed
          .map((record) => {
            const targetRid =
              record.source_collection === COLLECTIONS.docs ? record.doc_rid : record.node_rid;
            return Number.isFinite(targetRid)
              ? [
                  vectorTargetKey(record.source_collection, Number(targetRid)),
                  localVectorKey(record.source_collection, Number(targetRid)),
                ]
              : null;
          })
          .filter((entry): entry is [string, string] => entry != null),
      );
    }
    return new Map(
      Object.entries(parsed).map(([target, value]) => {
        if (typeof value === "string") return [target, value];
        const targetRid = value.source_collection === COLLECTIONS.docs ? value.doc_rid : value.node_rid;
        return [target, localVectorKey(value.source_collection, Number(targetRid))];
      }),
    );
  }

  private async writeLocalVectorIndex(index: Map<string, string>): Promise<void> {
    await this.kv().put(LOCAL_VECTOR_INDEX_KEY, Object.fromEntries(index));
  }

  private async readLocalVectorKey(key: string): Promise<LocalVectorProjectionRecord | null> {
    const raw = await this.kv().get(key);
    if (raw == null) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as LocalVectorProjectionRecord;
  }

  private async readVectorFailure(key: number | string): Promise<VectorFailureRecord | null> {
    const raw = await this.kv().get(typeof key === "number" ? vectorFailureKey(key) : key);
    if (raw == null) return null;
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as VectorFailureRecord;
  }

  private async recordVectorFailure(key: number | string, failure: VectorFailureRecord): Promise<void> {
    await this.kv().put(typeof key === "number" ? vectorFailureKey(key) : key, failure);
  }

  private async clearVectorFailure(key: number | string): Promise<void> {
    await this.kv().delete(typeof key === "number" ? vectorFailureKey(key) : key);
  }
}
