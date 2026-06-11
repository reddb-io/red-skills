import { type AskCitation, type QueryParam, type RedDB, connect } from "@reddb-io/sdk";
import {
  CONFLICT_NODE_TYPES,
  detectConflicts,
  type ConflictNode,
  type DetectedConflict,
} from "./conflict-detector.js";
import { contentHash } from "./hash.js";
import { appendEngineOpEvent, type EngineOpInput } from "./memory-events.js";
import {
  COLLECTIONS,
  DEFAULT_EPHEMERAL_TTL_MS,
  DEFAULT_IMPORTANCE,
  type EdgeLabel,
  HIDDEN_BY_EDGE_LABELS,
  type MemoryDoc,
  type MemoryEdge,
  type MemoryNode,
  type MemoryProvenance,
  type MemoryScope,
  type NodeType,
  defaultTier,
  type MemoryLayer,
} from "./schema.js";

export interface MemoryStoreOptions {
  /** RedDB connection URI, e.g. file:///abs/path/.red/memory/graph.rdb. */
  uri: string;
  /** Project tag stamped on every node. Used for multi-project hosts. */
  project?: string;
  /** TTL horizon for `ephemeral` nodes, in ms (default 24h). */
  ephemeralTtlMs?: number;
}

/** A node row read back from the graph, with its engine-assigned id. */
export type StoredNode = MemoryNode & { rid: number };

export type VectorProjectionState = "ready" | "stale" | "unavailable" | "failed";

export interface VectorNodeStatus {
  source_collection: typeof COLLECTIONS.nodes;
  rid: number;
  label: string;
  node_type: NodeType;
  status: VectorProjectionState;
  text_hash: string;
  projected_text_hash?: string;
  error?: string;
  updated_at?: number;
}

export interface VectorDocStatus {
  source_collection: typeof COLLECTIONS.docs;
  rid: number;
  path: string;
  title: string | null;
  status: VectorProjectionState;
  text_hash: string;
  projected_text_hash?: string;
  error?: string;
  updated_at?: number;
}

export interface VectorStatusReport {
  schema_version: "memory.vector_status.v1";
  read_only: true;
  overall: VectorProjectionState;
  total: number;
  ready: number;
  stale: number;
  unavailable: number;
  failed: number;
  nodes: VectorNodeStatus[];
  docs: VectorDocStatus[];
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

/** A node reached by a graph walk (neighborhood/traverse), with its hop depth.
 *  Graph walks return only the engine `node_id` + `label` + `depth`; the full
 *  node (real `node_type`, `properties`) is resolved against `listNodes` by the
 *  recall engine. */
export interface GraphRow {
  rid: number;
  label: string;
  depth: number;
}

/** A full-text search hit: an engine node id and its relevance score. */
export interface SearchRow {
  rid: number;
  score: number;
}

export interface NodeScopeInput {
  scope?: MemoryScope;
  scopeId?: string;
  provenance?: MemoryProvenance;
}

/** Provider usage and billing metadata reported by RedDB ASK. */
export interface AskCost {
  cost_usd: number;
  prompt_tokens: number;
  completion_tokens: number;
  model: string;
  provider: string;
  cache_hit: boolean;
}

/** Result of a shortest-path query. `reachable` is false when the engine found
 *  no path (`hop_count` comes back null). */
export interface ShortestPathResult {
  source: number;
  target: number;
  reachable: boolean;
  hopCount: number | null;
  totalWeight: number | null;
  nodesVisited: number;
}

type TraverseStrategy = "bfs" | "dfs";
type GraphDirection = "outgoing" | "incoming" | "both";
type PathAlgorithm = "bfs" | "dijkstra";

const STRATEGIES: readonly TraverseStrategy[] = ["bfs", "dfs"];
const DIRECTIONS: readonly GraphDirection[] = ["outgoing", "incoming", "both"];
const ALGORITHMS: readonly PathAlgorithm[] = ["bfs", "dijkstra"];

/** Reject anything not in the allowlist — these tokens are interpolated raw
 *  into the graph DSL (they cannot be bound as `$1` params), so they must never
 *  carry caller-supplied text. */
function guard<T extends string>(value: string, allowed: readonly T[], kind: string): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`invalid ${kind}: ${value}`);
}

/** Marker appended to a doc body whose tail was dropped to fit the engine's
 *  per-value byte cap. */
const TRUNCATION_MARKER = "\n\n[…truncated to fit memory store…]";

/**
 * Per-document-record byte budget. The SDK packs an inserted document into a
 * single JSON value (one `body` column), and the engine hard-rejects any value
 * over its per-value cap — `PAGE_SIZE / 4`, i.e. 1 KB on the 4 KB-page builds
 * (ADR 0007). Crucially, that rejection is **not recoverable on the same
 * connection**: a failed oversized insert desyncs the embedded engine's stdio
 * RPC stream, after which every later query comes back as a bogus parser error.
 * So a doc must be sized to fit *before* it is sent, never trimmed-and-retried.
 * We target a value below the cap, leaving headroom for the engine's framing.
 */
const DOC_RECORD_MAX_BYTES = 1000;

/** Truncate `text` so its UTF-8 byte length stays within `budget` bytes,
 *  reserving room for the truncation marker and never splitting a multi-byte
 *  codepoint. `budget` is the absolute byte ceiling for the returned string. */
function truncateBytes(text: string, budget: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= budget) return text;
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER, "utf8");
  let end = Math.max(0, budget - markerBytes);
  // Back off to a codepoint boundary: UTF-8 continuation bytes are 0b10xxxxxx.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString("utf8") + TRUNCATION_MARKER;
}

/**
 * MemoryStore — thin facade over the embedded RedDB SDK.
 *
 * Ported from red-memory `packages/core/src/adapter.ts` (commit 483034e). Owns
 * collection bootstrap and node/edge writes with dedupe. All writes go through
 * the multi-model DML form (`INSERT … NODE/EDGE`) and dedupe lives in KV, per
 * ADR 0007 — graph collections reject table-style inserts and `WHERE`-filter
 * only on `label`/`node_type`.
 */
export class MemoryStore {
  private db!: RedDB;
  private readonly project: string;
  private readonly ephemeralTtlMs: number;
  private nodeCache: StoredNode[] | null = null;
  private edgeCache: Record<string, unknown>[] | null = null;
  private removedEdgeCache: { rids: Set<number>; keys: Set<string> } | null = null;

  private constructor(
    private readonly opts: MemoryStoreOptions,
    project: string,
  ) {
    this.project = project;
    this.ephemeralTtlMs = opts.ephemeralTtlMs ?? DEFAULT_EPHEMERAL_TTL_MS;
  }

  static async open(opts: MemoryStoreOptions): Promise<MemoryStore> {
    const project = opts.project ?? "default";
    const store = new MemoryStore(opts, project);
    store.db = await connect(opts.uri);
    await store.bootstrap();
    return store;
  }

  /**
   * Idempotent collection setup. Safe to call on every boot. Only graph
   * collections need explicit DDL; KV is auto-created on first put.
   */
  private async bootstrap(): Promise<void> {
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.nodes}`);
    await this.db.execute(`CREATE GRAPH IF NOT EXISTS ${COLLECTIONS.edges}`);
  }

  async close(): Promise<void> {
    this.nodeCache = null;
    this.edgeCache = null;
    await this.db.close();
  }

  /** KvClient bound to the memory KV collection. `db.kv` is callable — the
   *  client only exists once invoked with a collection (ADR 0007). */
  private kv() {
    return this.db.kv(COLLECTIONS.kv);
  }

  // -------------------------------------------------------------------
  // Nodes
  // -------------------------------------------------------------------

  /**
   * Upsert a node, deduped by content hash. A second store of the same content
   * returns the existing rid instead of creating a duplicate.
   */
  async upsertNode(node: MemoryNode): Promise<number> {
    const props = node.properties;
    const now = Date.now();
    const scope = props.scope ?? "project";
    const scopeId = props.scope_id ?? defaultScopeId(scope, props.project, this.opts.project);
    const hash =
      props.hash ??
      contentHash(node.label, node.node_type, props.title, props.content, scope, scopeId);

    const existing = await this.findNodeByHash(hash);
    if (existing != null) {
      await this.projectNodeVector(existing, node, false);
      await this.emitEngineOp({
        op: "store",
        outcome: "deduped",
        layer: props.layer ?? "L3",
        node_id: existing,
      });
      return existing;
    }

    // Tier defaults by node_type unless the caller pinned one (issue #68).
    // Only `ephemeral` nodes get a TTL horizon; `durable`/`reasoning` persist.
    const tier = props.tier ?? defaultTier(node.node_type);
    // `layer` is persisted only when the caller pins it to a non-default value.
    // Today every default routes to L3, so omitting it keeps the properties
    // payload byte-identical to pre-#175 writes — the embedded RedDB engine
    // has a per-value cap (ADR 0007) and even a stable ~14 byte addition can
    // tip large `skill_event` nodes over the cap. Future slices that promote
    // a node to L1/L2 will set `layer` explicitly and pay the cost only then.
    const layer: MemoryLayer | undefined = props.layer;
    const createdAt = props.created_at ?? now;
    const expiresAt =
      tier === "ephemeral"
        ? (props.expires_at ?? createdAt + this.ephemeralTtlMs)
        : undefined;

    const properties = {
      ...props,
      hash,
      project: props.project ?? this.project,
      scope,
      ...(scopeId ? { scope_id: scopeId } : {}),
      importance: props.importance ?? DEFAULT_IMPORTANCE,
      tier,
      ...(layer != null ? { layer } : {}),
      created_at: createdAt,
      updated_at: now,
      ...(props.provenance
        ? {
            provenance: {
              ...props.provenance,
              confidence: props.provenance.confidence ?? props.confidence,
              created_at: props.provenance.created_at ?? createdAt,
              updated_at: now,
            },
          }
        : {}),
      accessed_at: now,
      access_count: props.access_count ?? 0,
      ...(expiresAt != null ? { expires_at: expiresAt } : {}),
    };
    // Graph collections reject table-style `db.insert`; the engine requires the
    // explicit `NODE` keyword (ADR 0007). `hash` is promoted to a top-level
    // column; the engine id comes from `red_entity_id`/`rid` in RETURNING *.
    const r = await this.db.query(
      `INSERT INTO ${COLLECTIONS.nodes} NODE (label, node_type, hash, properties) VALUES ($1, $2, $3, $4) RETURNING *`,
      node.label,
      node.node_type,
      hash,
      properties as unknown as QueryParam,
    );
    const row = r.rows[0];
    if (row == null) throw new Error("INSERT NODE returned no row");
    const rid = Number(row.red_entity_id ?? row.rid);
    this.invalidateNodeCache();
    // Dedupe index: SELECT/WHERE over arbitrary node columns does not filter on
    // graph collections (only label/node_type), so the hash→rid map lives in KV.
    await this.kv().put(nodeHashKey(hash), rid);
    // Ephemeral nodes also get a KV expiry marker carrying the engine TTL. The
    // observable expiry is enforced client-side by `listNodes` (the embedded
    // engine does not sweep KV TTL promptly — see ADR 0010); the marker is the
    // forward-compatible signal so a TTL-capable transport reaps the row too.
    if (expiresAt != null) {
      await this.kv().put(nodeExpiryKey(rid), expiresAt, { expireMs: expiresAt - now });
    }
    await this.projectNodeVector(rid, { ...node, properties }, false);
    await this.detectAndRecordConflicts(rid, { ...node, properties });
    await this.emitEngineOp({
      op: "store",
      outcome: "created",
      layer: layer ?? "L3",
      node_id: rid,
    });
    return rid;
  }

  /**
   * After a fresh L3 insert, compare the new node against existing L3 nodes
   * and emit a `CONTRADICTS` edge for each detected conflict (issue #179).
   * Bounded to the conflict-relevant node types so non-decision writes
   * (`file`, `symbol`, `session`, …) bypass the scan entirely. Failures here
   * never block the write — conflict surfacing is a best-effort augmentation.
   */
  private async detectAndRecordConflicts(
    rid: number,
    inserted: MemoryNode,
  ): Promise<void> {
    if (!CONFLICT_NODE_TYPES.has(inserted.node_type)) return;
    const layer = inserted.properties.layer ?? "L3";
    if (layer !== "L3") return;

    try {
      const existing = await this.listNodes();
      const peers: ConflictNode[] = [];
      for (const peer of existing) {
        if (peer.rid === rid) continue;
        if (peer.node_type !== inserted.node_type) continue;
        peers.push({
          rid: peer.rid,
          label: peer.label,
          node_type: peer.node_type,
          properties: peer.properties,
        });
      }
      const conflicts = detectConflicts(
        {
          rid,
          label: inserted.label,
          node_type: inserted.node_type,
          properties: inserted.properties,
        },
        peers,
      );
      for (const conflict of conflicts) {
        await this.upsertEdge({
          label: "CONTRADICTS",
          from_rid: rid,
          to_rid: conflict.rid,
          properties: conflictEdgeProps(conflict),
        });
      }
    } catch {
      // best-effort — never block the underlying write
    }
  }

  /**
   * Best-effort engine-event emitter. Engine ops (store, recall, promote,
   * evict, conflict-detected) feed `mem.events` for `memory health` aggregates
   * (issue #181). Failure here never propagates — telemetry degrades, the
   * engine op does not.
   */
  async emitEngineOp(input: EngineOpInput): Promise<void> {
    await appendEngineOpEvent(this, input);
  }

  /** Resolve a content hash to its node rid via the KV dedupe index. */
  async findNodeByHash(hash: string): Promise<number | null> {
    const rid = await this.kv().get(nodeHashKey(hash));
    return rid != null ? Number(rid) : null;
  }

  /**
   * Resolve a node by its `label` (optionally narrowed by `node_type`). Unlike
   * arbitrary columns, `label`/`node_type` *are* filterable on graph collections
   * (ADR 0007), so this is a real `WHERE` query — the path the ingest indexer
   * uses to resolve markdown wiki-link targets to rids.
   */
  async findNodeByLabel(label: string, type?: NodeType): Promise<number | null> {
    const r = type
      ? await this.db.query(
          `SELECT rid FROM ${COLLECTIONS.nodes} WHERE label = $1 AND node_type = $2 LIMIT 1`,
          label,
          type,
        )
      : await this.db.query(
          `SELECT rid FROM ${COLLECTIONS.nodes} WHERE label = $1 LIMIT 1`,
          label,
        );
    const row = r.rows[0];
    return row ? Number(row.rid ?? row.red_entity_id) : null;
  }

  /**
   * Read a single node back by rid, or null if it does not exist. `WHERE rid`
   * does not filter on graph collections (ADR 0007 — only label/node_type), so
   * this scans and matches client-side.
   */
  async getNode(rid: number): Promise<StoredNode | null> {
    const nodes = await this.listNodes();
    return nodes.find((n) => n.rid === rid) ?? null;
  }

  /**
   * Every *live* node in the graph — the reliable read path for recall and
   * doctor (SEARCH/FTS over graph node properties is not available in this
   * engine build). Expired `ephemeral` nodes (`now >= expires_at`) are dropped
   * here, the single read choke point, so they vanish from every consumer at
   * once (PRD #66 / issue #68). `durable`/`reasoning` nodes have no `expires_at`
   * and always survive. `now` is injectable for tests.
   */
  async listNodes(now: number = Date.now()): Promise<StoredNode[]> {
    if (this.nodeCache == null) {
      const r = await this.db.query(`SELECT * FROM ${COLLECTIONS.nodes}`);
      this.nodeCache = r.rows.map(rowToNode);
    }
    const evicted = await this.evictedRids();
    return this.nodeCache.filter((n) => !isExpired(n, now) && !evicted.has(n.rid));
  }

  private invalidateNodeCache(): void {
    this.nodeCache = null;
  }

  /**
   * Native community detection. Returns a node-rid → community-id map computed
   * by RedDB's own Louvain pass via `GRAPH COMMUNITY ALGORITHM louvain RETURN
   * ASSIGNMENTS` (engine ≥ 1.3.1, reddb-io/reddb#660). No external
   * graph-algorithms dependency — the engine owns the partition; we only read
   * the per-node assignment it returns (`{community_id, node_id}` rows, node_id
   * carried as a string). The competitive point of PRD #66 / issue #70.
   */
  async communities(): Promise<Map<number, string>> {
    const r = await this.db.query(
      `GRAPH COMMUNITY ALGORITHM louvain RETURN ASSIGNMENTS`,
    );
    const map = new Map<number, string>();
    for (const row of r.rows) {
      const rid = Number(row.node_id ?? row.NODE_ID);
      const cid = String(row.community_id ?? row.COMMUNITY_ID ?? "");
      if (Number.isFinite(rid) && cid) map.set(rid, cid);
    }
    return map;
  }

  // -------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------

  /** Upsert an edge, deduped by (from, to, label) via KV. */
  async upsertEdge(edge: MemoryEdge): Promise<number> {
    const existing = await this.findEdge(edge.from_rid, edge.to_rid, edge.label);
    if (existing != null) return existing;
    const key = edgeKey(edge.from_rid, edge.to_rid, edge.label);

    const properties = {
      ...(edge.properties ?? {}),
      created_at: edge.properties?.created_at ?? Date.now(),
    };
    // Same multi-model rule as nodes: the engine requires the `EDGE` keyword.
    const r = await this.db.query(
      `INSERT INTO ${COLLECTIONS.edges} EDGE (label, from, to, weight, properties) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      edge.label,
      edge.from_rid,
      edge.to_rid,
      edge.weight ?? 1.0,
      properties as unknown as QueryParam,
    );
    const row = r.rows[0];
    if (row == null) throw new Error("INSERT EDGE returned no row");
    const rid = Number(row.red_entity_id ?? row.rid);
    await this.kv().put(key, rid);
    await this.clearRemovedEdgeTombstone(rid, key);
    this.invalidateEdgeCache();
    return rid;
  }

  /** Edge dedupe keys off KV for the same reason node dedupe does (ADR 0007). */
  async findEdge(from: number, to: number, label: EdgeLabel): Promise<number | null> {
    const rid = await this.kv().get(edgeKey(from, to, label));
    return rid != null ? Number(rid) : null;
  }

  /**
   * Remove an edge from Memory read paths. The bundled graph engine has narrow
   * DELETE support on graph collections, so the reliable reversal mechanism is
   * a KV tombstone over the edge rid plus removal of the dedupe marker. If the
   * engine can physically delete the edge too, that is best-effort cleanup.
   */
  async removeEdge(from: number, to: number, label: EdgeLabel): Promise<boolean> {
    const rid = await this.findEdge(from, to, label);
    if (rid == null) return false;

    try {
      await this.db.query(
        `DELETE FROM ${COLLECTIONS.edges} WHERE label = $1 AND from = $2 AND to = $3`,
        label,
        from,
        to,
      );
    } catch {
      // Logical removal below is the source of truth for Memory read paths.
    }

    await this.kv().delete(edgeKey(from, to, label));
    const removed = await this.readRemovedEdgeMap();
    removed[rid] = true;
    removed[edgeKey(from, to, label)] = true;
    await this.kv().put(REMOVED_EDGES_KEY, removed);
    if (isHiddenByEdgeLabel(label)) {
      const sup = await this.readSupersededMap();
      if (Number(sup[from]) === to) {
        delete sup[from];
        await this.kv().put(SUPERSEDED_KEY, sup);
      }
    }
    this.invalidateEdgeCache();
    this.invalidateRemovedEdgeCache();
    return true;
  }

  /**
   * Store a reasoning trace and link it to the entities it affected with
   * `TOUCHED` audit edges (issue #72). The trace defaults to a `why_note` (→
   * `reasoning` tier) so recall can replay past reasoning and rank it below
   * durable decisions. Each `touched` rid gets one `trace → entity` edge;
   * dedupe means re-recording the same trace is idempotent. Returns the trace
   * rid and the rids of the `TOUCHED` edges created.
   */
  async recordReasoning(
    trace: Omit<MemoryNode, "node_type"> & { node_type?: NodeType },
    touched: number[],
  ): Promise<{ rid: number; edges: number[] }> {
    const node: MemoryNode = { ...trace, node_type: trace.node_type ?? "why_note" };
    const rid = await this.upsertNode(node);
    const edges: number[] = [];
    for (const to of touched) {
      edges.push(
        await this.upsertEdge({ label: "TOUCHED", from_rid: rid, to_rid: to }),
      );
    }
    return { rid, edges };
  }

  // -------------------------------------------------------------------
  // Supersede
  // -------------------------------------------------------------------

  /**
   * Mark `oldRid` as superseded by `newRid`: create a `SUPERSEDED_BY` edge
   * old → new and record the head of the chain in KV. Recall returns the head
   * of a `SUPERSEDED_BY` chain by default (PRD #49).
   *
   * The head-of-chain markers live in a single aggregate KV map (oldRid →
   * newRid), not one key per node: recall checks the marker for every candidate,
   * and a get-per-candidate fanned the read path out to N engine round-trips —
   * the recall latency bottleneck, made worse because this engine build's
   * `getMany` is not actually batched (issue #72). One read serves a whole
   * recall instead.
   */
  async supersede(oldRid: number, newRid: number, reason?: string): Promise<number> {
    const edgeRid = await this.upsertEdge({
      label: "SUPERSEDED_BY",
      from_rid: oldRid,
      to_rid: newRid,
      properties: reason ? { reason } : undefined,
    });
    const map = await this.readSupersededMap();
    map[oldRid] = newRid;
    await this.kv().put(SUPERSEDED_KEY, map);
    await this.emitEngineOp({
      op: "conflict-detected",
      outcome: "succeeded",
      layer: "L3",
      node_id: oldRid,
    });
    return edgeRid;
  }

  /** The rid that superseded `rid`, or null if `rid` is still current. */
  async supersededBy(rid: number): Promise<number | null> {
    const v = (await this.readSupersededMap())[rid];
    return v != null ? Number(v) : null;
  }

  /**
   * Batch form of `supersededBy`: resolve many rids from the one aggregate map
   * in a single KV read. Recall checks the head-of-chain marker for every
   * candidate, so reading per-rid was the recall latency bottleneck (issue #72).
   * Returns only the rids that *are* superseded (rid → successor); current rids
   * are absent from the map.
   */
  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    if (rids.length === 0) return out;
    const wanted = new Set(rids);
    const map = await this.readSupersededMap();
    for (const rid of rids) {
      const v = map[rid];
      if (v != null) out.set(rid, Number(v));
    }
    for (const edge of await this.listEdges()) {
      const label = edgeLabel(edge);
      if (!isHiddenByEdgeLabel(label)) continue;
      const from = edgeFrom(edge);
      const to = edgeTo(edge);
      if (wanted.has(from) && Number.isFinite(to)) out.set(from, to);
    }
    return out;
  }

  /** The aggregate head-of-chain map. KV may hand objects back as JSON strings. */
  private async readSupersededMap(): Promise<Record<string, number>> {
    const raw = await this.kv().get(SUPERSEDED_KEY);
    if (raw == null) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, number>;
  }

  // -------------------------------------------------------------------
  // Access tracking (decay)
  // -------------------------------------------------------------------

  /**
   * Record that `rids` were just recalled: bump each node's access count and
   * stamp `accessed_at = now`. Kept in a KV overlay rather than mutating the
   * node row — graph collections in this engine reject `UPDATE` by rid (ADR
   * 0007, same constraint as the dedupe index), and a node re-`INSERT` would
   * fork the dedupe hash.
   *
   * The overlay is a single aggregate map (rid → {count, accessed_at}) under one
   * KV key, not one key per node: each recall touches a handful of nodes, and a
   * key-per-node write fanned the recall read path out to 2×N engine
   * round-trips — the dominant cost in recall latency (issue #72). One
   * read-modify-write keeps recall well inside its <100ms p50 budget. Access
   * counts are advisory (decay bookkeeping for `doctor`), so the read-modify-
   * write race between concurrent recalls is acceptable.
   */
  async recordAccess(rids: number[], now: number = Date.now()): Promise<void> {
    if (rids.length === 0) return;
    const map = await this.readAccessMap();
    for (const rid of rids) {
      const prev = map[rid];
      map[rid] = { count: (prev?.count ?? 0) + 1, accessed_at: now };
    }
    await this.kv().put(ACCESS_KEY, map);
  }

  /** The full access overlay as a map — the read path `doctor` uses so it reads
   *  the aggregate key once rather than once per node. */
  async accessRecords(): Promise<Map<number, { count: number; accessed_at: number }>> {
    const map = await this.readAccessMap();
    const out = new Map<number, { count: number; accessed_at: number }>();
    for (const [rid, v] of Object.entries(map)) {
      out.set(Number(rid), { count: Number(v.count ?? 0), accessed_at: Number(v.accessed_at ?? 0) });
    }
    return out;
  }

  /** Read the access overlay for `rid`: how many times it was recalled and when
   *  last, or null if it has never been recalled since it was written. */
  async accessRecord(rid: number): Promise<{ count: number; accessed_at: number } | null> {
    const v = (await this.readAccessMap())[rid];
    return v ? { count: Number(v.count ?? 0), accessed_at: Number(v.accessed_at ?? 0) } : null;
  }

  /** The aggregate access overlay map. KV hands object values back as a JSON
   *  string, so parse before reading. */
  private async readAccessMap(): Promise<AccessOverlayMap> {
    const raw = await this.kv().get(ACCESS_KEY);
    if (raw == null) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as AccessOverlayMap;
  }

  // -------------------------------------------------------------------
  // Reinforcement (PromotionEngine dedup gate, issue #183)
  // -------------------------------------------------------------------

  /**
   * Bump a node's `reinforced` count. Stored in a KV overlay alongside the
   * access overlay because graph collections reject `UPDATE` by rid (ADR 0007).
   * Returns the new count.
   */
  async recordReinforcement(rid: number): Promise<number> {
    const map = await this.readReinforceMap();
    const next = (Number(map[rid] ?? 0) || 0) + 1;
    map[rid] = next;
    await this.kv().put(REINFORCE_KEY, map);
    return next;
  }

  /** Current reinforcement count for `rid`, or `0` if it has never been bumped. */
  async reinforcedCount(rid: number): Promise<number> {
    const map = await this.readReinforceMap();
    return Number(map[rid] ?? 0) || 0;
  }

  /** The full reinforcement overlay; doctor + promote viewer read it. */
  async reinforcementRecords(): Promise<Map<number, number>> {
    const map = await this.readReinforceMap();
    const out = new Map<number, number>();
    for (const [rid, v] of Object.entries(map)) out.set(Number(rid), Number(v));
    return out;
  }

  private async readReinforceMap(): Promise<ReinforceOverlayMap> {
    const raw = await this.kv().get(REINFORCE_KEY);
    if (raw == null) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as ReinforceOverlayMap;
  }

  // -------------------------------------------------------------------
  // Delete (prune)
  // -------------------------------------------------------------------

  /**
   * Delete a node and its KV markers. `DELETE … WHERE rid` is a no-op on graph
   * collections (ADR 0007 — only `label`/`node_type` filter), so we delete by
   * the (label, node_type) pair, which is unique per stored fact in this graph.
   * Edges pointing at the node are left as dangling rows; recall/traversal drop
   * any rid that no longer resolves against `listNodes`, so they never surface.
   * Used only by `memory:doctor` after explicit confirmation — never automatic.
   */
  async deleteNode(node: StoredNode): Promise<void> {
    try {
      await this.db.query(
        `DELETE FROM ${COLLECTIONS.nodes} WHERE label = $1 AND node_type = $2`,
        node.label,
        node.node_type,
      );
      const hash = node.properties.hash;
      if (typeof hash === "string") await this.kv().delete(nodeHashKey(hash));
      const map = await this.readAccessMap();
      if (map[node.rid] != null) {
        delete map[node.rid];
        await this.kv().put(ACCESS_KEY, map);
      }
      const sup = await this.readSupersededMap();
      if (sup[node.rid] != null) {
        delete sup[node.rid];
        await this.kv().put(SUPERSEDED_KEY, sup);
      }
      await this.kv().delete(nodeExpiryKey(node.rid));
    } finally {
      this.invalidateNodeCache();
    }
  }

  /**
   * Mark a batch of nodes as evicted. Eviction is implemented as a KV overlay
   * rather than a physical multi-DELETE because the bundled RedDB engine has
   * two delete-related bugs that make a real reap unsafe for batches:
   *
   * 1. The second and later `DELETE FROM memory_nodes` on a single connection
   *    return `affected: 0` even when the matching row is physically present.
   *    Single-row callers (`memory doctor`, `auto-curation`'s `expire-stale`)
   *    never trip it because they only issue one DELETE before the process
   *    exits.
   * 2. The "close-and-reopen between deletes" workaround drops the most
   *    recently inserted node from the next read after reopen — a separate
   *    persistence bug that takes down the safety-net L2 transcript whenever
   *    eviction interleaves with an active session.
   *
   * The overlay matches the {@link recordAccess} / reinforcement pattern (ADR
   * 0007): one aggregate KV map of evicted rids, filtered out by
   * {@link listNodes}. Consumers see the eviction immediately; disk rows
   * accumulate until a future engine fix lets us run a real reap.
   */
  async recordEvicted(rids: Iterable<number>): Promise<number> {
    const list = Array.from(rids);
    if (list.length === 0) return 0;
    const map = await this.readEvictedMap();
    let added = 0;
    const now = Date.now();
    for (const rid of list) {
      if (map[rid] == null) {
        map[rid] = now;
        added++;
      }
    }
    if (added > 0) {
      await this.kv().put(EVICTED_KEY, map);
      this.invalidateNodeCache();
    }
    return added;
  }

  /** Read the set of rids marked evicted via {@link recordEvicted}. */
  async evictedRids(): Promise<Set<number>> {
    const map = await this.readEvictedMap();
    return new Set(Object.keys(map).map((k) => Number(k)));
  }

  private async readEvictedMap(): Promise<Record<string, number>> {
    const raw = await this.kv().get(EVICTED_KEY);
    if (raw == null) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, number>;
  }

  // -------------------------------------------------------------------
  // Docs
  // -------------------------------------------------------------------

  /**
   * Upsert a document chunk (markdown body + frontmatter), deduped by hash. The
   * `memory_docs` document collection is auto-created by the SDK on first
   * insert — no explicit DDL, unlike graph collections. Stores the body so later
   * FTS/ASK work has the source text; recall over nodes does not depend on it.
   *
   * The record is sized to fit the engine's per-value cap *before* it is sent
   * (see {@link DOC_RECORD_MAX_BYTES}): an oversized insert can't be caught and
   * retried, because the failure poisons the connection. A body that doesn't fit
   * is truncated (its head stays searchable); the concept node already carries
   * the title/tags, so recall is unaffected.
   */
  async upsertDoc(doc: MemoryDoc): Promise<number> {
    const existing = await this.findDocByHash(doc.hash);
    if (existing != null) return existing;
    const result = await this.db.documents.insert(COLLECTIONS.docs, this.fitDocRecord(doc));
    const rid = Number((result as { rid: string | number }).rid);
    await this.projectDocVector(rid, doc, false);
    return rid;
  }

  async listDocs(): Promise<Array<MemoryDoc & { rid: number }>> {
    try {
      const { items } = await this.db.documents.list(COLLECTIONS.docs, { limit: 10_000 });
      return items.map(rowToDoc).filter((doc): doc is MemoryDoc & { rid: number } => doc != null);
    } catch {
      return [];
    }
  }

  /**
   * Build a doc record whose JSON serialization fits {@link DOC_RECORD_MAX_BYTES}.
   * Returns the full record untouched when it already fits; otherwise drops the
   * (non-essential) frontmatter and truncates the body, re-measuring until the
   * serialized value is within budget — JSON escaping can expand a string, so a
   * single byte-budget pass is not enough.
   */
  private fitDocRecord(doc: MemoryDoc): Record<string, unknown> {
    const build = (body: string, frontmatter: Record<string, unknown>) => ({
      path: doc.path,
      title: doc.title ?? null,
      body,
      frontmatter,
      hash: doc.hash,
      // `updated_at` is a reserved system field on documents in this engine
      // build; store the source mtime under a user-namespaced key instead.
      source_updated_at: doc.updated_at,
    });
    const jsonBytes = (rec: unknown) => Buffer.byteLength(JSON.stringify(rec), "utf8");

    // The SDK inlines the document as a single-quoted SQL literal and the engine
    // then collapses one level of backslash escapes before JSON-parsing the
    // value, so a backslash followed by a non-JSON-escape char (e.g. a `jq`
    // `\(` snippet) round-trips into an "invalid escape sequence" parse error.
    // The body is only kept for not-yet-enabled FTS/ASK — recall reads nodes —
    // so neutralise backslashes rather than risk a failed insert.
    const safeBody = doc.body.replace(/\\/g, " ");

    const full = build(safeBody, doc.frontmatter ?? {});
    if (jsonBytes(full) <= DOC_RECORD_MAX_BYTES) return full;

    // Too big: drop frontmatter and size the body against the remaining budget.
    const overhead = jsonBytes(build("", {}));
    let body = truncateBytes(safeBody, Math.max(0, DOC_RECORD_MAX_BYTES - overhead));
    let rec = build(body, {});
    // Tighten if JSON escaping pushed it back over the cap.
    while (body.length > 0 && jsonBytes(rec) > DOC_RECORD_MAX_BYTES) {
      body = truncateBytes(body, Math.floor(Buffer.byteLength(body, "utf8") * 0.8));
      rec = build(body, {});
    }
    return rec;
  }

  private async findDocByHash(hash: string): Promise<number | null> {
    try {
      const { items } = await this.db.documents.list(COLLECTIONS.docs, {
        filter: `hash = '${hash.replace(/'/g, "''")}'`,
        limit: 1,
      });
      const row = items[0];
      return row ? Number(row.rid) : null;
    } catch {
      // Collection does not yet exist — no doc to find.
      return null;
    }
  }

  // -------------------------------------------------------------------
  // KV (session state, dedupe markers)
  // -------------------------------------------------------------------

  async kvGet<T = unknown>(key: string): Promise<T | null> {
    const v = await this.kv().get(key);
    return (v ?? null) as T | null;
  }

  async kvPut(key: string, value: unknown, expireMs?: number): Promise<void> {
    await this.kv().put(key, value, { expireMs });
  }

  // -------------------------------------------------------------------
  // Read paths
  // -------------------------------------------------------------------

  /**
   * Graph neighborhood expansion around a node label. Returns lightweight
   * `{ rid, label, depth }` rows — graph walks in this engine surface only the
   * `node_id`/`label`/`depth`, not the node's properties or real `node_type`,
   * so the recall engine resolves each rid against `listNodes`.
   */
  async neighborhood(
    label: string,
    depth = 1,
    direction: GraphDirection = "both",
  ): Promise<GraphRow[]> {
    const dir = guard(direction, DIRECTIONS, "direction");
    const r = await this.db.query(
      `GRAPH NEIGHBORHOOD '${escapeLabel(label)}' DIRECTION ${dir} DEPTH ${clampDepth(depth)}`,
    );
    return r.rows.map(rowToGraphRow).filter((g) => Number.isFinite(g.rid));
  }

  /**
   * BFS/DFS traversal from a node label. Like `neighborhood`, returns
   * `{ rid, label, depth }` rows ordered by the engine's walk.
   */
  async traverse(
    label: string,
    opts: { depth?: number; strategy?: TraverseStrategy; direction?: GraphDirection } = {},
  ): Promise<GraphRow[]> {
    const strategy = guard(opts.strategy ?? "bfs", STRATEGIES, "strategy");
    const direction = guard(opts.direction ?? "outgoing", DIRECTIONS, "direction");
    const r = await this.db.query(
      `GRAPH TRAVERSE FROM '${escapeLabel(label)}' STRATEGY ${strategy} DIRECTION ${direction} MAX_DEPTH ${clampDepth(opts.depth ?? 3)}`,
    );
    return r.rows.map(rowToGraphRow).filter((g) => Number.isFinite(g.rid));
  }

  /**
   * Shortest path between two node labels. The engine returns path metadata
   * (hop count, total weight) rather than the node sequence; `reachable` is
   * false when no path exists (`hop_count` is null).
   */
  async shortestPath(
    from: string,
    to: string,
    algorithm: PathAlgorithm = "bfs",
  ): Promise<ShortestPathResult | null> {
    const algo = guard(algorithm, ALGORITHMS, "algorithm");
    const r = await this.db.query(
      `GRAPH SHORTEST_PATH FROM '${escapeLabel(from)}' TO '${escapeLabel(to)}' ALGORITHM ${algo}`,
    );
    const row = r.rows[0];
    if (row == null) return null;
    const hopCount = row.hop_count == null ? null : Number(row.hop_count);
    return {
      source: Number(row.source),
      target: Number(row.target),
      reachable: hopCount != null,
      hopCount,
      totalWeight: row.total_weight == null ? null : Number(row.total_weight),
      nodesVisited: Number(row.nodes_visited ?? 0),
    };
  }

  /**
   * Full-text search over node titles + content via the engine's `SEARCH TEXT`.
   * Returns `{ rid, score }` hits; the query is interpolated as a string literal
   * (the engine rejects `$1` binding here). Returns `[]` if the engine build has
   * no FTS index, so the recall engine can fall back to a client-side term scan.
   */
  async searchText(query: string, limit = 20): Promise<SearchRow[]> {
    try {
      const r = await this.db.query(
        `SEARCH TEXT '${escapeLabel(query)}' COLLECTION ${COLLECTIONS.nodes} LIMIT ${clampLimit(limit)}`,
      );
      return r.rows
        .map((row) => ({
          rid: Number(row.entity_id ?? row.rid ?? row.red_entity_id),
          score: Number(row.score ?? 1),
        }))
        .filter((h) => Number.isFinite(h.rid));
    } catch {
      return [];
    }
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
  private async projectNodeVector(
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
  private async projectDocVector(
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

  /**
   * Grounded ASK over the memory document collection (RedDB `ASK` with
   * citations). This is the one read path that calls an LLM — it needs an API
   * key configured on the engine and is therefore *not* part of the zero-token
   * recall guarantee. Callers handle the thrown error when no key is set.
   */
  async ask(
    question: string,
  ): Promise<{ answer: string; citations: AskCitation[]; cost: AskCost }> {
    const r = await this.db.query(
      `ASK '${escapeLabel(question)}' COLLECTION ${COLLECTIONS.docs}` as `ASK ${string}`,
    );
    return {
      answer: r.answer,
      citations: r.citations,
      cost: {
        cost_usd: r.cost_usd,
        prompt_tokens: r.prompt_tokens,
        completion_tokens: r.completion_tokens,
        model: r.model,
        provider: r.provider,
        cache_hit: r.cache_hit,
      },
    };
  }

  /** Every edge in the graph, for export/inspection. */
  async listEdges(): Promise<Record<string, unknown>[]> {
    try {
      if (this.edgeCache != null) return this.edgeCache;
      const r = await this.db.query(`SELECT * FROM ${COLLECTIONS.edges}`);
      const removed = await this.removedEdges();
      this.edgeCache = r.rows.filter((edge) => !isRemovedEdge(edge, removed));
      return this.edgeCache;
    } catch {
      return [];
    }
  }

  private invalidateEdgeCache(): void {
    this.edgeCache = null;
  }

  private invalidateRemovedEdgeCache(): void {
    this.removedEdgeCache = null;
  }

  private async removedEdges(): Promise<{ rids: Set<number>; keys: Set<string> }> {
    if (this.removedEdgeCache != null) return this.removedEdgeCache;
    const map = await this.readRemovedEdgeMap();
    const rids = new Set<number>();
    const keys = new Set<string>();
    for (const [key, removed] of Object.entries(map)) {
      if (!removed) continue;
      const rid = Number(key);
      if (Number.isFinite(rid)) rids.add(rid);
      else keys.add(key);
    }
    this.removedEdgeCache = { rids, keys };
    return this.removedEdgeCache;
  }

  private async readRemovedEdgeMap(): Promise<Record<string, boolean>> {
    const raw = await this.kv().get(REMOVED_EDGES_KEY);
    if (raw == null) return {};
    return (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, boolean>;
  }

  private async clearRemovedEdgeTombstone(rid: number, key: string): Promise<void> {
    const removed = await this.readRemovedEdgeMap();
    if (!removed[rid] && !removed[key]) return;
    delete removed[rid];
    delete removed[key];
    await this.kv().put(REMOVED_EDGES_KEY, removed);
    this.invalidateRemovedEdgeCache();
  }

  async stats(): Promise<{ nodes: number; edges: number }> {
    const count = async (sql: string): Promise<number> => {
      try {
        const r = await this.db.query(sql);
        return Number(r.rows[0]?.n ?? 0);
      } catch {
        return 0;
      }
    };
    const [nodes, edges] = await Promise.all([
      count(`SELECT COUNT(*) AS n FROM ${COLLECTIONS.nodes}`),
      count(`SELECT COUNT(*) AS n FROM ${COLLECTIONS.edges}`),
    ]);
    return { nodes, edges };
  }

  /** Internal raw access for advanced callers. */
  get raw(): RedDB {
    return this.db;
  }
}

function conflictEdgeProps(conflict: DetectedConflict): {
  reason: string;
  kind: DetectedConflict["kind"];
  candidate_session: string | null;
  existing_session: string | null;
} {
  return {
    reason: conflict.reason,
    kind: conflict.kind,
    candidate_session: conflict.sessions.candidate,
    existing_session: conflict.sessions.existing,
  };
}

/**
 * Normalize a RedDB graph row into a MemoryNode. The engine returns promoted
 * columns uppercased (`PROPERTIES`, `HASH`) alongside lowercase `rid`, `label`,
 * `node_type`, so read both cases.
 */
export function rowToNode(row: Record<string, unknown>): StoredNode {
  const properties = (row.properties ?? row.PROPERTIES ?? {}) as MemoryNode["properties"];
  return {
    rid: Number(row.rid ?? row.red_entity_id),
    label: String(row.label ?? ""),
    node_type: (row.node_type as NodeType) ?? "concept",
    properties: properties ?? { title: String(row.label ?? "") },
  };
}

/**
 * Turn a free-text fact (as `/memory:store` receives it) into a graph node:
 * a `concept` whose label is the slugified first line, full text in `content`.
 * Mirrors the markdown-only note shape so the two modes capture the same thing.
 */
export function factToNode(
  fact: string,
  slugify: (t: string) => string,
  scopeInput: NodeScopeInput = {},
): MemoryNode {
  const trimmed = fact.trim();
  const title = trimmed.split("\n")[0]?.slice(0, 120) ?? trimmed;
  return {
    label: slugify(title),
    node_type: "concept",
    properties: {
      title,
      content: trimmed,
      source: "manual",
      ...(scopeInput.provenance ? { provenance: scopeInput.provenance } : {}),
      ...(scopeInput.scope ? { scope: scopeInput.scope } : {}),
      ...(scopeInput.scopeId ? { scope_id: scopeInput.scopeId } : {}),
    },
  };
}

function defaultScopeId(
  scope: MemoryScope,
  nodeProject: string | undefined,
  storeProject: string | undefined,
): string | undefined {
  if (scope !== "project") return undefined;
  return nodeProject ?? storeProject;
}

/**
 * Normalize a graph-walk row (NEIGHBORHOOD/TRAVERSE) into a `GraphRow`. These
 * rows carry `node_id` (the rid as a string) and a synthetic `node_type` like
 * `label_64` — the real type lives on the node read back via `listNodes`.
 */
export function rowToGraphRow(row: Record<string, unknown>): GraphRow {
  return {
    rid: Number(row.node_id ?? row.rid ?? row.red_entity_id),
    label: String(row.label ?? ""),
    depth: Number(row.depth ?? 0),
  };
}

function escapeLabel(label: string): string {
  return label.replace(/'/g, "''");
}

/** Clamp a depth to a sane non-negative integer for the graph DSL. */
function clampDepth(depth: number): number {
  return Math.max(0, Math.floor(Number.isFinite(depth) ? depth : 0));
}

/** Clamp a limit to a positive integer for the search DSL. */
function clampLimit(limit: number): number {
  return Math.max(1, Math.floor(Number.isFinite(limit) ? limit : 1));
}

/** KV key for the node dedupe index (hash → rid). */
function nodeHashKey(hash: string): string {
  return `node:hash:${hash}`;
}

/** KV key for the edge dedupe index (from→to→label → rid). */
function edgeKey(from: number, to: number, label: string): string {
  return `edge:${from}:${to}:${label}`;
}

function isRemovedEdge(
  edge: Record<string, unknown>,
  removed: { rids: Set<number>; keys: Set<string> },
): boolean {
  const rid = edgeRid(edge);
  if (Number.isFinite(rid) && removed.rids.has(rid)) return true;
  const from = edgeFrom(edge);
  const to = edgeTo(edge);
  const label = edgeLabel(edge);
  return (
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    removed.keys.has(edgeKey(from, to, label))
  );
}

function isHiddenByEdgeLabel(label: string): label is (typeof HIDDEN_BY_EDGE_LABELS)[number] {
  return (HIDDEN_BY_EDGE_LABELS as readonly string[]).includes(label);
}

function edgeRid(edge: Record<string, unknown>): number {
  return Number(
    edge.rid ?? edge.red_entity_id ?? edge.RED_ENTITY_ID ?? edge.edge_id ?? edge.EDGE_ID,
  );
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.edge_label ?? edge.LABEL ?? "");
}

function edgeFrom(edge: Record<string, unknown>): number {
  return Number(
    edge.from_rid ?? edge.from ?? edge.FROM ?? edge.from_id ?? edge.source ?? edge.source_id,
  );
}

function edgeTo(edge: Record<string, unknown>): number {
  return Number(edge.to_rid ?? edge.to ?? edge.TO ?? edge.to_id ?? edge.target ?? edge.target_id);
}

/** Aggregate head-of-chain map: oldRid → newRid. One KV key for the whole
 *  graph, not one per node — see `supersede`. */
const SUPERSEDED_KEY = "node:superseded:all";

/** Aggregate logical edge-deletion map: edge rid → removed. */
const REMOVED_EDGES_KEY = "edge:removed:all";

/** KV key carrying an ephemeral node's TTL horizon (forward-compat reaping). */
function nodeExpiryKey(rid: number): string {
  return `node:expiry:${rid}`;
}

/**
 * Whether an `ephemeral` node has passed its TTL horizon. Only `ephemeral`
 * nodes carry `expires_at`; `durable`/`reasoning` nodes never expire.
 */
export function isExpired(node: StoredNode, now: number = Date.now()): boolean {
  if (node.properties.tier !== "ephemeral") return false;
  const expiresAt = node.properties.expires_at;
  return typeof expiresAt === "number" && now >= expiresAt;
}

/** Aggregate access overlay: rid → {recall count, last-accessed time}. One KV
 *  key for the whole graph, not one per node — see `recordAccess`. */
type AccessOverlayMap = Record<string, { count: number; accessed_at: number }>;
const ACCESS_KEY = "node:access:all";

/** Aggregate reinforcement overlay: rid → reinforced count. One KV key for the
 *  whole graph, mirrors {@link ACCESS_KEY}. PromotionEngine bumps this on each
 *  dedup hit instead of mutating the node row (graph collections reject UPDATE,
 *  ADR 0007). */
type ReinforceOverlayMap = Record<string, number>;
const REINFORCE_KEY = "node:reinforce:all";

/** Aggregate eviction overlay: rid → evicted_at (ms). Filtered out by
 *  {@link MemoryStore.listNodes}, so consumers stop seeing the node even
 *  though the underlying row may still live on disk (see
 *  {@link MemoryStore.recordEvicted}). */
const EVICTED_KEY = "node:evicted:all";

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

function rowToDoc(row: Record<string, unknown>): (MemoryDoc & { rid: number }) | null {
  const get = (key: string) => row[key] ?? row[key.toUpperCase()];
  const rid = Number(get("rid") ?? row.red_entity_id ?? 0);
  const path = get("path");
  const hash = get("hash");
  if (!Number.isFinite(rid) || typeof path !== "string" || typeof hash !== "string") {
    return null;
  }
  const frontmatter = get("frontmatter");
  return {
    rid,
    path,
    title: get("title") == null ? undefined : String(get("title")),
    body: String(get("body") ?? ""),
    frontmatter:
      frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)
        ? (frontmatter as Record<string, unknown>)
        : undefined,
    hash,
    updated_at: Number(get("source_updated_at") ?? get("updated_at") ?? 0),
  };
}
