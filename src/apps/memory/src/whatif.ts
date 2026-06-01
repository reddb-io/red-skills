/**
 * What-if surface (issue #172, parent PRD #165).
 *
 * Predicts blast radius for a list of proposed changes by composing
 * `structural-impact-reader` (syntactic blast) with
 * `reasoning-replay` (semantic blast from similar past attempts).
 *
 * Read-only: never mutates the graph, never edits files. Returns a
 * `memory.whatif.v1` envelope that surfaces affected files, symbols, tests,
 * historical attempts, a composite `breakage_likelihood`, and a
 * `self_confidence` score callers can use to weight the prediction.
 */
import type { MemoryStore } from "./graph-store.js";
import {
  readStructuralImpact,
  type StructuralImpact,
  type StructuralImpactEdge,
  type StructuralImpactNode,
  type StructuralImpactStore,
} from "./structural-impact-reader.js";
import {
  buildReasoningReplay,
  type ReasoningReplayResult,
} from "./reasoning/reasoning-replay.js";

export type WhatifChangeKind = "rename" | "delete" | "edit";

export interface WhatifChange {
  kind: WhatifChangeKind;
  file?: string;
  symbol?: string;
  /** Optional rename target ("rename X to Y" → with: "Y"). */
  with?: string;
  /** Optional natural-language description; falls back to a synthesised one. */
  description?: string;
}

export interface WhatifAffected {
  files: string[];
  symbols: string[];
  tests: string[];
}

export interface WhatifReport {
  schema_version: "memory.whatif.v1";
  read_only: true;
  generated_at: string;
  changes: WhatifChange[];
  breakage_likelihood: number;
  affected: WhatifAffected;
  historical_attempts: ReasoningReplayResult[];
  self_confidence: number;
}

export interface WhatifOptions {
  /** Cap on historical_attempts returned. */
  limit?: number;
  /** Override clock for deterministic tests. */
  now?: number;
}

const DEFAULT_HISTORICAL_LIMIT = 5;

/**
 * Per-change-kind weight on the structural component of `breakage_likelihood`.
 * Rename/delete propagate; edit is local-ish so we soften its contribution.
 */
const KIND_WEIGHT: Record<WhatifChangeKind, number> = {
  rename: 1,
  delete: 1,
  edit: 0.6,
};

/** Fan-out at which the structural component saturates at 1.0. */
const STRUCTURAL_SATURATION = 20;

export async function buildWhatifReport(
  store: MemoryStore,
  changes: WhatifChange[],
  opts: WhatifOptions = {},
): Promise<WhatifReport> {
  const now = opts.now ?? Date.now();
  const generatedAt = new Date(now).toISOString();
  const normalized = changes.map(normalizeChange);

  const files = new Set<string>();
  const symbols = new Set<string>();
  let weightedStructural = 0;

  for (const change of normalized) {
    if (!change.file && !change.symbol) continue;
    let impact: StructuralImpact;
    try {
      impact = await readStructuralImpact(store as unknown as StructuralImpactStore, {
        file: change.file,
        symbol: change.symbol,
      });
    } catch {
      continue;
    }
    const { fileSet, symbolSet, fanOut } = collectImpact(impact, change);
    for (const f of fileSet) files.add(f);
    for (const s of symbolSet) symbols.add(s);
    weightedStructural += KIND_WEIGHT[change.kind] * fanOut;
  }

  const tests = [...files].filter(isTestPath).sort();
  const sortedFiles = [...files].sort();
  const sortedSymbols = [...symbols].sort();

  const historical = await collectHistorical(store, normalized, {
    limit: opts.limit ?? DEFAULT_HISTORICAL_LIMIT,
    now,
  });

  const structuralComponent = clamp01(weightedStructural / STRUCTURAL_SATURATION);
  const historicalComponent = scoreHistorical(historical);
  const breakage = clamp01(0.6 * structuralComponent + 0.4 * historicalComponent);

  const hasStructural = sortedFiles.length + sortedSymbols.length > 0;
  const hasHistorical = historical.length > 0;
  const selfConfidence = (hasStructural ? 0.5 : 0) + (hasHistorical ? 0.5 : 0);

  return {
    schema_version: "memory.whatif.v1",
    read_only: true,
    generated_at: generatedAt,
    changes: normalized,
    breakage_likelihood: roundTo(breakage, 4),
    affected: {
      files: sortedFiles,
      symbols: sortedSymbols,
      tests,
    },
    historical_attempts: historical,
    self_confidence: roundTo(selfConfidence, 4),
  };
}

/**
 * Parse a free-form descriptor like `rename foo to bar` / `delete src/x.ts` /
 * `edit src/y.ts#handler` into a structured WhatifChange. Useful for the CLI,
 * which only accepts strings.
 */
export function parseWhatifChange(raw: string): WhatifChange {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("whatif change cannot be empty");
  }
  const lower = trimmed.toLowerCase();
  const kind: WhatifChangeKind = lower.startsWith("rename")
    ? "rename"
    : lower.startsWith("delete") || lower.startsWith("remove")
      ? "delete"
      : "edit";

  // Strip the verb if present so we can parse target/with.
  const body = trimmed.replace(/^(rename|delete|remove|edit)\s+/i, "");

  if (kind === "rename") {
    const match = /^(\S+)\s+(?:to|->)\s+(\S+)$/i.exec(body);
    if (match) {
      const [, target, withName] = match;
      const parsed = splitTarget(target);
      return { kind, description: trimmed, with: withName, ...parsed };
    }
  }

  const parsed = splitTarget(body || trimmed);
  return { kind, description: trimmed, ...parsed };
}

function normalizeChange(change: WhatifChange): WhatifChange {
  return {
    kind: change.kind,
    file: change.file,
    symbol: change.symbol,
    with: change.with,
    description: change.description ?? synthesiseDescription(change),
  };
}

function synthesiseDescription(change: WhatifChange): string {
  const target = change.symbol
    ? change.file
      ? `${change.symbol} in ${change.file}`
      : change.symbol
    : (change.file ?? "(unknown target)");
  if (change.kind === "rename" && change.with) {
    return `rename ${target} to ${change.with}`;
  }
  return `${change.kind} ${target}`;
}

function splitTarget(raw: string): { file?: string; symbol?: string } {
  const cleaned = raw.replace(/[`"']/g, "").trim();
  if (!cleaned) return {};
  if (cleaned.includes("#")) {
    const [file, symbol] = cleaned.split("#", 2);
    return {
      file: file ? file : undefined,
      symbol: symbol ? symbol : undefined,
    };
  }
  // Heuristic: anything with `/` or `.` we treat as a file path; otherwise symbol.
  if (cleaned.includes("/") || /\.[a-z0-9]+$/i.test(cleaned)) {
    return { file: cleaned };
  }
  return { symbol: cleaned };
}

interface CollectedImpact {
  fileSet: Set<string>;
  symbolSet: Set<string>;
  fanOut: number;
}

function collectImpact(impact: StructuralImpact, change: WhatifChange): CollectedImpact {
  const fileSet = new Set<string>();
  const symbolSet = new Set<string>();

  for (const node of impact.defines) {
    addSymbol(symbolSet, node);
  }
  if (impact.definedIn) addFile(fileSet, impact.definedIn);

  // Downstream blast: everything that depends on the changed file/symbol.
  for (const edge of impact.importedBy) addFileFromEdge(fileSet, edge, "from");
  for (const edge of impact.calledBy) {
    addSymbolFromEdge(symbolSet, edge, "from");
    addFileFromCallSite(fileSet, edge, "from");
  }
  for (const edge of impact.referencedBy) {
    addSymbolFromEdge(symbolSet, edge, "from");
    addFileFromCallSite(fileSet, edge, "from");
  }
  for (const edge of impact.usedByTypes) {
    addSymbolFromEdge(symbolSet, edge, "from");
    addFileFromCallSite(fileSet, edge, "from");
  }

  // For rename/delete, callers' outbound dependencies also matter (the broken
  // import surface). For edit we keep it tight.
  if (change.kind !== "edit") {
    for (const edge of impact.imports) addFileFromEdge(fileSet, edge, "to");
  }

  const fanOut =
    impact.importedBy.length +
    impact.calledBy.length +
    impact.referencedBy.length +
    impact.usedByTypes.length;

  if (change.file) fileSet.delete(normalizePath(change.file));
  if (change.symbol) symbolSet.delete(change.symbol);

  return { fileSet, symbolSet, fanOut };
}

function addFile(set: Set<string>, node: StructuralImpactNode | undefined | null): void {
  if (!node) return;
  const path = pickFilePath(node);
  if (path) set.add(path);
}

function addFileFromEdge(
  set: Set<string>,
  edge: StructuralImpactEdge,
  side: "from" | "to",
): void {
  const node = side === "from" ? edge.from : edge.to;
  // For IMPORTS edges the `from` is a file; the `to` is an import alias whose
  // resolved_path / title points at the imported file.
  if (node.node_type === "file") {
    addFile(set, node);
    return;
  }
  if (node.node_type === "import") {
    const resolved =
      typeof node.properties.resolved_path === "string" ? node.properties.resolved_path : "";
    const title =
      typeof node.properties.title === "string" ? node.properties.title : "";
    if (resolved) set.add(normalizePath(resolved));
    else if (title) set.add(normalizePath(title));
    return;
  }
  addFile(set, node);
}

function addFileFromCallSite(
  set: Set<string>,
  edge: StructuralImpactEdge,
  side: "from" | "to",
): void {
  // CALLS/REFERENCES edges connect symbols. Promote each symbol to the file it
  // is defined in when that information is available on the node properties.
  const node = side === "from" ? edge.from : edge.to;
  if (node.node_type === "file") {
    addFile(set, node);
    return;
  }
  const path =
    typeof node.properties.file === "string"
      ? node.properties.file
      : typeof node.properties.source === "string"
        ? node.properties.source
        : "";
  if (path) set.add(normalizePath(path));
}

function addSymbol(set: Set<string>, node: StructuralImpactNode | undefined | null): void {
  if (!node) return;
  const name = pickSymbolName(node);
  if (name) set.add(name);
}

function addSymbolFromEdge(
  set: Set<string>,
  edge: StructuralImpactEdge,
  side: "from" | "to",
): void {
  const node = side === "from" ? edge.from : edge.to;
  if (node.node_type !== "symbol") return;
  addSymbol(set, node);
}

function pickFilePath(node: StructuralImpactNode): string {
  if (node.node_type === "file") {
    const label = node.label.startsWith("file:") ? node.label.slice("file:".length) : node.label;
    if (label) return normalizePath(label);
  }
  const title = node.properties.title;
  if (typeof title === "string" && title) return normalizePath(title);
  return "";
}

function pickSymbolName(node: StructuralImpactNode): string {
  const title = node.properties.title;
  if (typeof title === "string" && title) return title;
  const hash = node.label.indexOf("#");
  if (hash >= 0 && hash < node.label.length - 1) return node.label.slice(hash + 1);
  return node.label;
}

function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.includes("/tests/") ||
    lower.includes("/test/") ||
    lower.includes("/__tests__/") ||
    /\.(test|spec)\.[a-z0-9]+$/.test(lower)
  );
}

function normalizePath(path: string): string {
  return path.replace(/^file:/, "").replace(/\\/g, "/").replace(/\/+$/, "");
}

async function collectHistorical(
  store: MemoryStore,
  changes: WhatifChange[],
  opts: { limit: number; now: number },
): Promise<ReasoningReplayResult[]> {
  if (changes.length === 0) return [];
  const descriptor = changes
    .map((change) => change.description ?? synthesiseDescription(change))
    .filter((s) => s.length > 0)
    .join(" ; ")
    .trim();
  if (!descriptor) return [];
  try {
    const replay = await buildReasoningReplay(store, descriptor, {
      limit: opts.limit,
      now: opts.now,
    });
    // Drop zero-similarity hits — they add noise without signal.
    return replay.results.filter((r) => r.similarity > 0);
  } catch {
    return [];
  }
}

function scoreHistorical(results: ReasoningReplayResult[]): number {
  if (results.length === 0) return 0;
  let weight = 0;
  let blockedWeight = 0;
  for (const result of results) {
    const w = Math.max(result.similarity, 0.05);
    weight += w;
    if (result.outcome === "blocked" || result.outcome === "no-sentinel") {
      blockedWeight += w;
    } else if (result.outcome === "unknown") {
      blockedWeight += w * 0.3;
    }
  }
  if (weight === 0) return 0;
  return clamp01(blockedWeight / weight);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
