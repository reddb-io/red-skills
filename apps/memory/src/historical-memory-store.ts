import { type RedDB, connect } from "@reddb-io/sdk";
import type { GraphRow, SearchRow, StoredNode } from "./graph-store.js";
import { rowToNode } from "./graph-store.js";
import { COLLECTIONS, HIDDEN_BY_EDGE_LABELS } from "./schema.js";

export interface HistoricalMemoryStoreOptions {
  uri: string;
  ref: string;
}

type HistoricalRefKind = "COMMIT" | "BRANCH" | "TAG";

/**
 * Read-only Memory graph reader bound to a RedDB VCS ref.
 *
 * This intentionally satisfies only the recall engine's read interface. It
 * does not expose MemoryStore write methods, KV access, vector maintenance, or
 * access bookkeeping, keeping `recall --as-of` side-effect free by construction.
 */
export class HistoricalMemoryStore {
  private db!: RedDB;
  private readonly clauses: string[];
  private resolvedClause: string | null = null;
  private nodeCache: StoredNode[] | null = null;
  private edgeCache: Record<string, unknown>[] | null = null;

  private constructor(private readonly opts: HistoricalMemoryStoreOptions) {
    this.clauses = asOfClauses(opts.ref);
  }

  static async open(opts: HistoricalMemoryStoreOptions): Promise<HistoricalMemoryStore> {
    const store = new HistoricalMemoryStore(opts);
    store.db = await connect(opts.uri);
    return store;
  }

  async close(): Promise<void> {
    this.nodeCache = null;
    this.edgeCache = null;
    await this.db.close();
  }

  async listNodes(): Promise<StoredNode[]> {
    if (this.nodeCache == null) {
      const rows = await this.queryRows(`SELECT * FROM ${COLLECTIONS.nodes} {AS_OF}`);
      this.nodeCache = rows.map(rowToNode).filter(isHistoricalNode);
    }
    return this.nodeCache;
  }

  async listEdges(): Promise<Record<string, unknown>[]> {
    if (this.edgeCache == null) {
      this.edgeCache = await this.queryRows(`SELECT * FROM ${COLLECTIONS.edges} {AS_OF}`);
    }
    return this.edgeCache;
  }

  async searchText(_query: string, _limit = 20): Promise<SearchRow[]> {
    return [];
  }

  async neighborhood(
    _label: string,
    _depth = 1,
    _direction: "outgoing" | "incoming" | "both" = "both",
  ): Promise<GraphRow[]> {
    return [];
  }

  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const wanted = new Set(rids);
    const out = new Map<number, number>();
    if (wanted.size === 0) return out;

    for (const edge of await this.listEdges()) {
      if (!isHiddenByEdgeLabel(String(edge.label ?? edge.LABEL ?? ""))) continue;
      const from = edgeRid(edge, "from");
      const to = edgeRid(edge, "to");
      if (wanted.has(from) && Number.isFinite(to)) out.set(from, to);
    }
    return out;
  }

  private async queryRows(template: string): Promise<Record<string, unknown>[]> {
    const errors: string[] = [];
    for (const clause of this.resolvedClause ? [this.resolvedClause] : this.clauses) {
      try {
        const result = await this.db.query(template.replace("{AS_OF}", clause));
        this.resolvedClause = clause;
        return result.rows;
      } catch (err) {
        errors.push(String((err as Error).message ?? err));
      }
    }
    throw new Error(
      `historical Memory ref "${this.opts.ref}" not found or not readable: ${errors.join("; ")}`,
    );
  }
}

function asOfClauses(ref: string): string[] {
  const escaped = quoteRef(ref);
  const candidates: HistoricalRefKind[] = /^[a-f0-9]{64}$/i.test(ref)
    ? ["COMMIT", "BRANCH", "TAG"]
    : ["BRANCH", "TAG", "COMMIT"];
  return candidates.map((kind) => `AS OF ${kind} ${escaped}`);
}

function isHiddenByEdgeLabel(label: string): boolean {
  return (HIDDEN_BY_EDGE_LABELS as readonly string[]).includes(label);
}

function quoteRef(ref: string): string {
  return `"${ref.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function isHistoricalNode(node: StoredNode): boolean {
  const props = node.properties;
  if (props.tier === "ephemeral") return false;
  if (props.scope === "session") return false;
  if (node.node_type === "session") return false;
  return true;
}

function edgeRid(edge: Record<string, unknown>, side: "from" | "to"): number {
  const upper = side.toUpperCase();
  return Number(
    edge[side] ??
      edge[`${side}_id`] ??
      edge[`${side}_rid`] ??
      edge[side === "from" ? "source" : "target"] ??
      edge[upper],
  );
}
