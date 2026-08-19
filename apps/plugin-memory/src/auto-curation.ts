/**
 * Memory auto-curation — opt-in orchestrator (issue #171).
 *
 * Composes the existing read-only diagnose / decay / supersession primitives
 * into a single proposal pass, then optionally applies the proposals it can
 * safely execute. Defaults to dry-run; mutating runs require the explicit
 * `--apply` flag from the caller. Claim-guarded nodes
 * (`properties.claim_guard === true`) are never mutated, even in apply mode —
 * they show up as `skipped_claim_guarded` so the caller can see what was held
 * back.
 *
 * Entropy is a coarse "memory noise" ratio
 * `(superseded + contradicted + expired_ephemeral + stale_unrecalled) / total`,
 * stamped before and after so the caller can see whether the run actually
 * reduced clutter. Each completed run is appended to a small KV ring buffer
 * (`memory.autocure.runs`) so the workbench can render an entropy trend.
 */

import { diagnose, type StaleNode } from "./doctor.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";
import { buildMemoryDecayReport } from "./memory-decay.js";
import { listContradictions } from "./supersession.js";
import type { NodeType } from "./schema.js";

export type AutoCureActionKind =
  | "dedupe-supersede"
  | "supersede-contradiction"
  | "expire-stale"
  | "promote-edge"
  | "archive-untouched";

export type AutoCureSkipReason = "claim-guarded";

export interface AutoCureNodeRef {
  rid: number;
  label: string;
  node_type: NodeType;
  title: string;
}

export interface AutoCureAction {
  kind: AutoCureActionKind;
  target: AutoCureNodeRef;
  /** Secondary node (e.g. the supersession winner). */
  with?: AutoCureNodeRef;
  reason: string;
  /** When `kind` describes an edge action, the engine edge rid. */
  edge_rid?: number;
}

export interface AutoCureSkippedAction extends AutoCureAction {
  skipped: AutoCureSkipReason;
}

export interface AutoCureRunWindow {
  /** Milliseconds of history considered for staleness/decay. */
  staleDays: number;
  /** Pinned threshold for claim-guard semantics (mirrors decay). */
  pinnedImportance: number;
  generated_at: string;
}

export interface AutoCureReport {
  schema_version: "memory.autocure.v1";
  read_only: boolean;
  dry_run: boolean;
  window: AutoCureRunWindow;
  totals: {
    nodes: number;
    edges: number;
    claim_guarded: number;
  };
  actions_proposed: AutoCureAction[];
  actions_applied: AutoCureAction[];
  skipped_claim_guarded: AutoCureSkippedAction[];
  entropy_before: number;
  entropy_after: number;
  by_kind: Record<AutoCureActionKind, { proposed: number; applied: number }>;
}

export interface AutoCureOptions {
  /** When true, mutates the graph. Default false (dry-run). */
  apply?: boolean;
  /** Stale threshold passed through to doctor/decay (default 90). */
  staleDays?: number;
  /** Pinned importance for claim-guard semantics (default 0.8). */
  pinnedImportance?: number;
  /** Promote-edge access count threshold (default 5). */
  promoteEdgeAccess?: number;
  now?: number;
  /** Cap on entries kept in the persisted run log (default 10). */
  historyLimit?: number;
}

const RUN_LOG_KEY = "memory.autocure.runs";
const DEFAULT_HISTORY = 10;

export interface AutoCureRunLogEntry {
  generated_at: string;
  dry_run: boolean;
  entropy_before: number;
  entropy_after: number;
  proposed: number;
  applied: number;
  skipped_claim_guarded: number;
}

export interface AutoCureRunLog {
  schema_version: "memory.autocure.runs.v1";
  entries: AutoCureRunLogEntry[];
}

export async function readAutoCureRunLog(store: MemoryStore): Promise<AutoCureRunLog> {
  try {
    const raw = await store.kvGet<AutoCureRunLog | string>(RUN_LOG_KEY);
    if (!raw) return { schema_version: "memory.autocure.runs.v1", entries: [] };
    const parsed = typeof raw === "string" ? (JSON.parse(raw) as AutoCureRunLog) : raw;
    return {
      schema_version: "memory.autocure.runs.v1",
      entries: Array.isArray(parsed.entries) ? parsed.entries : [],
    };
  } catch {
    return { schema_version: "memory.autocure.runs.v1", entries: [] };
  }
}

async function appendRunLog(
  store: MemoryStore,
  entry: AutoCureRunLogEntry,
  historyLimit: number,
): Promise<void> {
  const log = await readAutoCureRunLog(store);
  const next: AutoCureRunLog = {
    schema_version: "memory.autocure.runs.v1",
    entries: [...log.entries, entry].slice(-historyLimit),
  };
  await store.kvPut(RUN_LOG_KEY, next);
}

function nodeRef(node: StoredNode): AutoCureNodeRef {
  return {
    rid: node.rid,
    label: node.label,
    node_type: node.node_type,
    title: String(node.properties.title ?? node.label),
  };
}

function isClaimGuarded(node: StoredNode | undefined): boolean {
  if (!node) return false;
  const props = node.properties;
  return Boolean(props.claim_guard === true || props.has_active_claim === true);
}

function nodeImportance(node: StoredNode): number {
  return typeof node.properties.importance === "number" ? node.properties.importance : 0;
}

function createdAt(node: StoredNode): number {
  const p = node.properties;
  return Number(p.created_at ?? p.updated_at ?? 0);
}

/** Pick the newer node by `created_at`; tie-break by higher rid. */
function pickNewer(a: StoredNode, b: StoredNode): { winner: StoredNode; loser: StoredNode } {
  if (createdAt(a) > createdAt(b)) return { winner: a, loser: b };
  if (createdAt(a) < createdAt(b)) return { winner: b, loser: a };
  return a.rid >= b.rid ? { winner: a, loser: b } : { winner: b, loser: a };
}

interface PlanInputs {
  nodes: StoredNode[];
  byRid: Map<number, StoredNode>;
  superseded: Map<number, number>;
  staleNodes: StaleNode[];
  decayExpire: Array<{ rid: number; title: string }>;
  decayDeprecate: Array<{ rid: number; title: string }>;
  contradictions: Array<{ fromRid: number; toRid: number; reason: string | null }>;
  edges: Record<string, unknown>[];
  accessRecords: Map<number, { count: number; accessed_at: number }>;
  promoteEdgeAccess: number;
}

function detectDedupes(inputs: PlanInputs): AutoCureAction[] {
  const groups = new Map<string, StoredNode[]>();
  for (const node of inputs.nodes) {
    if (inputs.superseded.has(node.rid)) continue;
    const hash = node.properties.hash;
    if (typeof hash !== "string" || !hash) continue;
    const list = groups.get(hash) ?? [];
    list.push(node);
    groups.set(hash, list);
  }
  const actions: AutoCureAction[] = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => createdAt(b) - createdAt(a) || b.rid - a.rid);
    const winner = sorted[0]!;
    for (const loser of sorted.slice(1)) {
      actions.push({
        kind: "dedupe-supersede",
        target: nodeRef(loser),
        with: nodeRef(winner),
        reason: `same content hash as memory_nodes:${winner.rid}`,
      });
    }
  }
  return actions;
}

function detectContradictionSupersessions(inputs: PlanInputs): AutoCureAction[] {
  const actions: AutoCureAction[] = [];
  for (const conflict of inputs.contradictions) {
    const from = inputs.byRid.get(conflict.fromRid);
    const to = inputs.byRid.get(conflict.toRid);
    if (!from || !to) continue;
    if (inputs.superseded.has(from.rid) || inputs.superseded.has(to.rid)) continue;
    const { winner, loser } = pickNewer(from, to);
    actions.push({
      kind: "supersede-contradiction",
      target: nodeRef(loser),
      with: nodeRef(winner),
      reason:
        conflict.reason ?? `older contradicted guidance, superseded by memory_nodes:${winner.rid}`,
    });
  }
  return actions;
}

function detectExpireStale(inputs: PlanInputs): AutoCureAction[] {
  return inputs.decayExpire
    .map((item) => inputs.byRid.get(item.rid))
    .filter((node): node is StoredNode => Boolean(node))
    .map((node) => ({
      kind: "expire-stale" as const,
      target: nodeRef(node),
      reason: "ephemeral TTL passed; safe to remove",
    }));
}

function detectArchive(inputs: PlanInputs): AutoCureAction[] {
  return inputs.decayDeprecate
    .map((item) => inputs.byRid.get(item.rid))
    .filter((node): node is StoredNode => Boolean(node))
    .map((node) => ({
      kind: "archive-untouched" as const,
      target: nodeRef(node),
      reason: "untouched beyond decay horizon",
    }));
}

function edgeRid(edge: Record<string, unknown>): number | null {
  const v = edge.rid ?? edge.RID ?? edge.id ?? edge.ID;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function edgeFrom(edge: Record<string, unknown>): number | null {
  const v = edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function edgeLabel(edge: Record<string, unknown>): string {
  return String(edge.label ?? edge.LABEL ?? "");
}

function edgeProps(edge: Record<string, unknown>): Record<string, unknown> {
  const p = edge.properties ?? edge.PROPERTIES;
  return p && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

function detectPromoteEdges(inputs: PlanInputs): AutoCureAction[] {
  const actions: AutoCureAction[] = [];
  for (const edge of inputs.edges) {
    const label = edgeLabel(edge);
    if (label === "SUPERSEDED_BY" || label === "CONTRADICTS") continue;
    const from = edgeFrom(edge);
    if (from == null) continue;
    const access = inputs.accessRecords.get(from);
    if (!access || access.count < inputs.promoteEdgeAccess) continue;
    if (edgeProps(edge).promoted_at != null) continue;
    const node = inputs.byRid.get(from);
    if (!node) continue;
    const rid = edgeRid(edge);
    actions.push({
      kind: "promote-edge",
      target: nodeRef(node),
      reason: `edge ${label} recalled ${access.count} time(s); flag as promoted`,
      ...(rid != null ? { edge_rid: rid } : {}),
    });
  }
  return actions;
}

function computeEntropy(args: {
  totalNodes: number;
  supersededRids: Iterable<number>;
  contradictedRids: Iterable<number>;
  expireRids: Iterable<number>;
  deprecateRids: Iterable<number>;
}): number {
  if (args.totalNodes <= 0) return 0;
  const noise = new Set<number>();
  for (const r of args.supersededRids) noise.add(r);
  for (const r of args.contradictedRids) noise.add(r);
  for (const r of args.expireRids) noise.add(r);
  for (const r of args.deprecateRids) noise.add(r);
  return Number((noise.size / args.totalNodes).toFixed(6));
}

async function gatherInputs(
  store: MemoryStore,
  opts: AutoCureOptions,
): Promise<PlanInputs> {
  const staleDays = opts.staleDays ?? 90;
  const now = opts.now ?? Date.now();
  const nodes = await store.listNodes(now);
  const byRid = new Map(nodes.map((n) => [n.rid, n]));
  const [edges, superseded, accessRecords] = await Promise.all([
    store.listEdges(),
    store.supersededByMany(nodes.map((n) => n.rid)),
    store.accessRecords(),
  ]);
  const [decay, contradictions, doctorReport] = await Promise.all([
    buildMemoryDecayReport(store, { stale_days: staleDays, limit: 1000, now }),
    listContradictions(store),
    diagnose(store, { staleDays, now }),
  ]);
  return {
    nodes,
    byRid,
    superseded,
    edges,
    accessRecords,
    decayExpire: decay.expire.map((i) => ({ rid: i.rid, title: i.title })),
    decayDeprecate: decay.deprecate.map((i) => ({ rid: i.rid, title: i.title })),
    contradictions: contradictions.map((c) => ({
      fromRid: c.from.rid,
      toRid: c.to.rid,
      reason: c.reason,
    })),
    staleNodes: doctorReport.stale,
    promoteEdgeAccess: opts.promoteEdgeAccess ?? 5,
  };
}

/**
 * Run autocure. Returns the report; if `apply` is true, mutates the graph
 * per proposal and reports back which actions actually ran vs were held back
 * by a claim guard.
 */
export async function runAutoCure(
  store: MemoryStore,
  opts: AutoCureOptions = {},
): Promise<AutoCureReport> {
  const now = opts.now ?? Date.now();
  const staleDays = opts.staleDays ?? 90;
  const pinnedImportance = opts.pinnedImportance ?? 0.8;
  const historyLimit = Math.max(1, opts.historyLimit ?? DEFAULT_HISTORY);
  const apply = opts.apply === true;

  const inputs = await gatherInputs(store, { ...opts, now, staleDays });

  const proposed: AutoCureAction[] = [
    ...detectDedupes(inputs),
    ...detectContradictionSupersessions(inputs),
    ...detectExpireStale(inputs),
    ...detectPromoteEdges(inputs),
    ...detectArchive(inputs),
  ];

  const contradictedRids = new Set<number>();
  for (const c of inputs.contradictions) {
    contradictedRids.add(c.fromRid);
    contradictedRids.add(c.toRid);
  }
  const entropyBefore = computeEntropy({
    totalNodes: inputs.nodes.length,
    supersededRids: inputs.superseded.keys(),
    contradictedRids,
    expireRids: inputs.decayExpire.map((i) => i.rid),
    deprecateRids: inputs.decayDeprecate.map((i) => i.rid),
  });
  const claimGuardedRids = new Set(
    inputs.nodes.filter(isClaimGuarded).map((n) => n.rid),
  );

  const applied: AutoCureAction[] = [];
  const skipped: AutoCureSkippedAction[] = [];

  if (apply) {
    for (const action of proposed) {
      if (
        claimGuardedRids.has(action.target.rid) ||
        (action.with != null && claimGuardedRids.has(action.with.rid))
      ) {
        skipped.push({ ...action, skipped: "claim-guarded" });
        continue;
      }
      const ran = await applyAction(store, action);
      if (ran) applied.push(action);
    }
  }

  // Recompute entropy after apply. In dry-run this equals before.
  const entropyAfter = apply
    ? await recomputeEntropy(store, { staleDays, now })
    : entropyBefore;

  const byKind: AutoCureReport["by_kind"] = {
    "dedupe-supersede": { proposed: 0, applied: 0 },
    "supersede-contradiction": { proposed: 0, applied: 0 },
    "expire-stale": { proposed: 0, applied: 0 },
    "promote-edge": { proposed: 0, applied: 0 },
    "archive-untouched": { proposed: 0, applied: 0 },
  };
  for (const a of proposed) byKind[a.kind].proposed += 1;
  for (const a of applied) byKind[a.kind].applied += 1;

  const report: AutoCureReport = {
    schema_version: "memory.autocure.v1",
    read_only: !apply,
    dry_run: !apply,
    window: {
      staleDays,
      pinnedImportance,
      generated_at: new Date(now).toISOString(),
    },
    totals: {
      nodes: inputs.nodes.length,
      edges: inputs.edges.length,
      claim_guarded: claimGuardedRids.size,
    },
    actions_proposed: proposed,
    actions_applied: applied,
    skipped_claim_guarded: skipped,
    entropy_before: entropyBefore,
    entropy_after: entropyAfter,
    by_kind: byKind,
  };

  try {
    await appendRunLog(
      store,
      {
        generated_at: report.window.generated_at,
        dry_run: report.dry_run,
        entropy_before: report.entropy_before,
        entropy_after: report.entropy_after,
        proposed: report.actions_proposed.length,
        applied: report.actions_applied.length,
        skipped_claim_guarded: report.skipped_claim_guarded.length,
      },
      historyLimit,
    );
  } catch {
    // KV write failure must not derail the report itself.
  }

  return report;
}

async function applyAction(store: MemoryStore, action: AutoCureAction): Promise<boolean> {
  switch (action.kind) {
    case "dedupe-supersede":
    case "supersede-contradiction": {
      if (!action.with) return false;
      await store.supersede(action.target.rid, action.with.rid, action.reason);
      return true;
    }
    case "expire-stale": {
      const node = await store.getNode(action.target.rid);
      if (!node) return false;
      await store.deleteNode(node);
      return true;
    }
    case "promote-edge":
    case "archive-untouched":
      // No mutation primitive yet — recorded in proposals only.
      return false;
  }
}

async function recomputeEntropy(
  store: MemoryStore,
  opts: { staleDays: number; now: number },
): Promise<number> {
  const nodes = await store.listNodes(opts.now);
  const superseded = await store.supersededByMany(nodes.map((n) => n.rid));
  const contradictions = await listContradictions(store);
  const contradictedRids = new Set<number>();
  for (const c of contradictions) {
    contradictedRids.add(c.from.rid);
    contradictedRids.add(c.to.rid);
  }
  const decay = await buildMemoryDecayReport(store, {
    stale_days: opts.staleDays,
    limit: 1000,
    now: opts.now,
  });
  return computeEntropy({
    totalNodes: nodes.length,
    supersededRids: superseded.keys(),
    contradictedRids,
    expireRids: decay.expire.map((i) => i.rid),
    deprecateRids: decay.deprecate.map((i) => i.rid),
  });
}
