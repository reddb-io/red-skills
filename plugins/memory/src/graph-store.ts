import { type QueryParam, type RedDB, connect } from "@reddb-io/sdk";
import { contentHash } from "./hash.js";
import {
  COLLECTIONS,
  DEFAULT_IMPORTANCE,
  type EdgeLabel,
  type MemoryDoc,
  type MemoryEdge,
  type MemoryNode,
  type NodeType,
} from "./schema.js";

export interface MemoryStoreOptions {
  /** RedDB connection URI, e.g. file:///abs/path/.red/memory/graph.rdb. */
  uri: string;
  /** Project tag stamped on every node. Used for multi-project hosts. */
  project?: string;
}

/** A node row read back from the graph, with its engine-assigned id. */
export type StoredNode = MemoryNode & { rid: number };

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

  private constructor(
    private readonly opts: MemoryStoreOptions,
    project: string,
  ) {
    this.project = project;
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
    const hash =
      props.hash ?? contentHash(node.label, node.node_type, props.title, props.content);

    const existing = await this.findNodeByHash(hash);
    if (existing != null) return existing;

    const properties = {
      ...props,
      hash,
      project: props.project ?? this.project,
      importance: props.importance ?? DEFAULT_IMPORTANCE,
      created_at: props.created_at ?? now,
      updated_at: now,
      accessed_at: now,
      access_count: props.access_count ?? 0,
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
    // Dedupe index: SELECT/WHERE over arbitrary node columns does not filter on
    // graph collections (only label/node_type), so the hash→rid map lives in KV.
    await this.kv().put(nodeHashKey(hash), rid);
    return rid;
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

  /** Every node in the graph. The reliable read path for recall — SEARCH/FTS
   *  over graph node properties is not available in this engine build. */
  async listNodes(): Promise<StoredNode[]> {
    const r = await this.db.query(`SELECT * FROM ${COLLECTIONS.nodes}`);
    return r.rows.map(rowToNode);
  }

  // -------------------------------------------------------------------
  // Edges
  // -------------------------------------------------------------------

  /** Upsert an edge, deduped by (from, to, label) via KV. */
  async upsertEdge(edge: MemoryEdge): Promise<number> {
    const existing = await this.findEdge(edge.from_rid, edge.to_rid, edge.label);
    if (existing != null) return existing;

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
    await this.kv().put(edgeKey(edge.from_rid, edge.to_rid, edge.label), rid);
    return rid;
  }

  /** Edge dedupe keys off KV for the same reason node dedupe does (ADR 0007). */
  async findEdge(from: number, to: number, label: EdgeLabel): Promise<number | null> {
    const rid = await this.kv().get(edgeKey(from, to, label));
    return rid != null ? Number(rid) : null;
  }

  // -------------------------------------------------------------------
  // Supersede
  // -------------------------------------------------------------------

  /**
   * Mark `oldRid` as superseded by `newRid`: create a `SUPERSEDED_BY` edge
   * old → new and record the head of the chain in KV. Recall returns the head
   * of a `SUPERSEDED_BY` chain by default (PRD #49); `isSuperseded` reads the
   * marker without scanning edges.
   */
  async supersede(oldRid: number, newRid: number, reason?: string): Promise<number> {
    const edgeRid = await this.upsertEdge({
      label: "SUPERSEDED_BY",
      from_rid: oldRid,
      to_rid: newRid,
      properties: reason ? { reason } : undefined,
    });
    await this.kv().put(supersededKey(oldRid), newRid);
    return edgeRid;
  }

  /** The rid that superseded `rid`, or null if `rid` is still current. */
  async supersededBy(rid: number): Promise<number | null> {
    const v = await this.kv().get(supersededKey(rid));
    return v != null ? Number(v) : null;
  }

  // -------------------------------------------------------------------
  // Docs
  // -------------------------------------------------------------------

  /**
   * Upsert a document chunk (markdown body + frontmatter), deduped by hash. The
   * `memory_docs` document collection is auto-created by the SDK on first
   * insert — no explicit DDL, unlike graph collections. Stores the full body so
   * later FTS/ASK work has the source text; recall over nodes does not depend on
   * it.
   */
  async upsertDoc(doc: MemoryDoc): Promise<number> {
    const existing = await this.findDocByHash(doc.hash);
    if (existing != null) return existing;
    const result = await this.db.documents.insert(COLLECTIONS.docs, {
      path: doc.path,
      title: doc.title ?? null,
      body: doc.body,
      frontmatter: doc.frontmatter ?? {},
      hash: doc.hash,
      // `updated_at` is a reserved system field on documents in this engine
      // build; store the source mtime under a user-namespaced key instead.
      source_updated_at: doc.updated_at,
    });
    return Number((result as { rid: string | number }).rid);
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

  /** Graph neighborhood expansion around a node label. */
  async neighborhood(
    label: string,
    depth = 1,
    direction: "outgoing" | "incoming" | "both" = "both",
  ): Promise<StoredNode[]> {
    const r = await this.db.query(
      `GRAPH NEIGHBORHOOD '${escapeLabel(label)}' DIRECTION ${direction} DEPTH ${depth}`,
    );
    return r.rows.map(rowToNode).filter((n) => Number.isFinite(n.rid));
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
export function factToNode(fact: string, slugify: (t: string) => string): MemoryNode {
  const trimmed = fact.trim();
  const title = trimmed.split("\n")[0]?.slice(0, 120) ?? trimmed;
  return {
    label: slugify(title),
    node_type: "concept",
    properties: { title, content: trimmed, source: "manual" },
  };
}

function escapeLabel(label: string): string {
  return label.replace(/'/g, "''");
}

/** KV key for the node dedupe index (hash → rid). */
function nodeHashKey(hash: string): string {
  return `node:hash:${hash}`;
}

/** KV key for the edge dedupe index (from→to→label → rid). */
function edgeKey(from: number, to: number, label: string): string {
  return `edge:${from}:${to}:${label}`;
}

/** KV key marking a node as superseded (oldRid → newRid). */
function supersededKey(rid: number): string {
  return `node:superseded:${rid}`;
}
