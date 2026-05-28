import { connect } from "@reddb-io/sdk";
import { rowToNode } from "./graph-store.js";
import { COLLECTIONS } from "./schema.js";
/**
 * Read-only Memory graph reader bound to a RedDB VCS ref.
 *
 * This intentionally satisfies only the recall engine's read interface. It
 * does not expose MemoryStore write methods, KV access, vector maintenance, or
 * access bookkeeping, keeping `recall --as-of` side-effect free by construction.
 */
export class HistoricalMemoryStore {
    opts;
    db;
    clauses;
    resolvedClause = null;
    nodeCache = null;
    edgeCache = null;
    constructor(opts) {
        this.opts = opts;
        this.clauses = asOfClauses(opts.ref);
    }
    static async open(opts) {
        const store = new HistoricalMemoryStore(opts);
        store.db = await connect(opts.uri);
        return store;
    }
    async close() {
        this.nodeCache = null;
        this.edgeCache = null;
        await this.db.close();
    }
    async listNodes() {
        if (this.nodeCache == null) {
            const rows = await this.queryRows(`SELECT * FROM ${COLLECTIONS.nodes} {AS_OF}`);
            this.nodeCache = rows.map(rowToNode).filter(isHistoricalNode);
        }
        return this.nodeCache;
    }
    async listEdges() {
        if (this.edgeCache == null) {
            this.edgeCache = await this.queryRows(`SELECT * FROM ${COLLECTIONS.edges} {AS_OF}`);
        }
        return this.edgeCache;
    }
    async searchText(_query, _limit = 20) {
        return [];
    }
    async neighborhood(_label, _depth = 1, _direction = "both") {
        return [];
    }
    async supersededByMany(rids) {
        const wanted = new Set(rids);
        const out = new Map();
        if (wanted.size === 0)
            return out;
        for (const edge of await this.listEdges()) {
            if (String(edge.label ?? edge.LABEL ?? "") !== "SUPERSEDED_BY")
                continue;
            const from = edgeRid(edge, "from");
            const to = edgeRid(edge, "to");
            if (wanted.has(from) && Number.isFinite(to))
                out.set(from, to);
        }
        return out;
    }
    async queryRows(template) {
        const errors = [];
        for (const clause of this.resolvedClause ? [this.resolvedClause] : this.clauses) {
            try {
                const result = await this.db.query(template.replace("{AS_OF}", clause));
                this.resolvedClause = clause;
                return result.rows;
            }
            catch (err) {
                errors.push(String(err.message ?? err));
            }
        }
        throw new Error(`historical Memory ref "${this.opts.ref}" not found or not readable: ${errors.join("; ")}`);
    }
}
function asOfClauses(ref) {
    const escaped = quoteRef(ref);
    const candidates = /^[a-f0-9]{64}$/i.test(ref)
        ? ["COMMIT", "BRANCH", "TAG"]
        : ["BRANCH", "TAG", "COMMIT"];
    return candidates.map((kind) => `AS OF ${kind} ${escaped}`);
}
function quoteRef(ref) {
    return `"${ref.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
function isHistoricalNode(node) {
    const props = node.properties;
    if (props.tier === "ephemeral")
        return false;
    if (props.scope === "session")
        return false;
    if (node.node_type === "session")
        return false;
    return true;
}
function edgeRid(edge, side) {
    const upper = side.toUpperCase();
    return Number(edge[side] ??
        edge[`${side}_id`] ??
        edge[`${side}_rid`] ??
        edge[side === "from" ? "source" : "target"] ??
        edge[upper]);
}
