import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { readConfig, resolveNotesDir, resolveStoreUri, type MemoryConfig } from "./config.js";
import { MemoryStore, type StoredNode } from "./graph-store.js";
import type { MemoryScope, Tier } from "./schema.js";

const MS_PER_DAY = 86_400_000;
const DEFAULT_STALE_PROGRESS_DAYS = 14;

export type LintMode = "uninitialized" | "markdown-only" | "graph" | "hybrid";
export type LintStatus = "ok" | "uninitialized" | "degraded";

export type LintFindingCode =
  | "stale-progress-fact"
  | "imperative-memory"
  | "missing-scope"
  | "missing-tier"
  | "duplicate-like"
  | "likely-secret";

export interface LintFinding {
  code: LintFindingCode;
  severity: "warning" | "error";
  memoryId: string;
  location: string;
  message: string;
  excerpt: string;
  relatedMemoryId?: string;
}

export interface LintReport {
  status: LintStatus;
  mode: LintMode;
  readOnly: true;
  totalMemories: number;
  findings: LintFinding[];
  warnings: string[];
}

interface LintMemory {
  id: string;
  location: string;
  title: string;
  body: string;
  scope?: MemoryScope;
  tier?: Tier;
  createdAt?: number;
  updatedAt?: number;
}

export interface LintOptions {
  now?: number;
  staleProgressDays?: number;
}

export async function lintMemory(rootDir: string, opts: LintOptions = {}): Promise<LintReport> {
  const config = await readConfig(rootDir);
  if (!config) {
    return {
      status: "uninitialized",
      mode: "uninitialized",
      readOnly: true,
      totalMemories: 0,
      findings: [],
      warnings: ["memory is not initialized here"],
    };
  }

  const warnings: string[] = [];
  const memories = await collectMemories(rootDir, config, warnings);
  const findings = findPolicyProblems(memories, opts);
  return {
    status: warnings.length > 0 ? "degraded" : "ok",
    mode: config.mode,
    readOnly: true,
    totalMemories: memories.length,
    findings,
    warnings,
  };
}

async function collectMemories(
  rootDir: string,
  config: MemoryConfig,
  warnings: string[],
): Promise<LintMemory[]> {
  if (config.mode === "markdown-only") {
    return collectMarkdownMemories(resolveNotesDir(rootDir, config), warnings);
  }

  if (config.mode === "graph") {
    let store: MemoryStore | null = null;
    try {
      store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
      return (await store.listNodes()).map(graphNodeToMemory);
    } catch (err) {
      warnings.push(`graph store could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      await store?.close().catch(() => {});
    }
  }

  warnings.push(`lint does not inspect "${config.mode}" storage yet`);
  return [];
}

async function collectMarkdownMemories(
  notesDir: string,
  warnings: string[],
): Promise<LintMemory[]> {
  let entries: string[];
  try {
    entries = (await readdir(notesDir)).filter((file) => file.endsWith(".md")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    warnings.push(`markdown notes could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const memories: LintMemory[] = [];
  for (const file of entries) {
    const path = join(notesDir, file);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      const body = parsed.content.trim();
      const id = typeof data.id === "string" ? data.id : basename(file, ".md");
      memories.push({
        id,
        location: path,
        title: typeof data.title === "string" ? data.title : firstLine(body) || id,
        body,
        scope: parseScope(data.scope),
        tier: parseTier(data.tier),
        createdAt: parseTime(data.created_at),
        updatedAt: parseTime(data.updated_at),
      });
    } catch (err) {
      warnings.push(`markdown note ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return memories;
}

function graphNodeToMemory(node: StoredNode): LintMemory {
  const props = node.properties;
  const body = String(props.content ?? props.summary ?? props.title ?? node.label);
  return {
    id: `memory_nodes:${node.rid}`,
    location: `memory_nodes:${node.rid}`,
    title: String(props.title ?? node.label),
    body,
    scope: parseScope(props.scope),
    tier: parseTier(props.tier),
    createdAt: parseTime(props.created_at),
    updatedAt: parseTime(props.updated_at),
  };
}

function findPolicyProblems(memories: LintMemory[], opts: LintOptions): LintFinding[] {
  const now = opts.now ?? Date.now();
  const staleProgressDays = opts.staleProgressDays ?? DEFAULT_STALE_PROGRESS_DAYS;
  const findings: LintFinding[] = [];

  for (const memory of memories) {
    if (isStaleProgress(memory, now, staleProgressDays)) {
      findings.push(finding("stale-progress-fact", memory, "Progress/update wording should stay ephemeral instead of durable recall."));
    }
    if (isImperativeMemory(memory)) {
      findings.push(finding("imperative-memory", memory, "Imperative instruction is masquerading as a stored memory."));
    }
    if (!memory.scope) {
      findings.push(finding("missing-scope", memory, "Memory does not declare the scope where it is safe to recall."));
    }
    if (!memory.tier) {
      findings.push(finding("missing-tier", memory, "Memory does not declare a durable, ephemeral, or reasoning tier."));
    }
    if (hasSecretLikeContent(memory)) {
      findings.push(finding("likely-secret", memory, "Memory contains credential-shaped or secret-placeholder material.", "error"));
    }
  }

  for (const duplicate of duplicatePairs(memories)) {
    findings.push({
      ...finding("duplicate-like", duplicate.memory, "Memory is very similar to another stored memory."),
      relatedMemoryId: duplicate.related.id,
    });
  }

  return findings.sort(compareFindings);
}

function finding(
  code: LintFindingCode,
  memory: LintMemory,
  message: string,
  severity: LintFinding["severity"] = "warning",
): LintFinding {
  return {
    code,
    severity,
    memoryId: memory.id,
    location: memory.location,
    message,
    excerpt: excerpt(memory.body || memory.title),
  };
}

function isStaleProgress(memory: LintMemory, now: number, staleProgressDays: number): boolean {
  const text = `${memory.title}\n${memory.body}`.toLowerCase();
  const looksLikeProgress =
    /\b(current progress|progress update|status update|halfway through|tests? (are )?running|working on|todo|next step)\b/.test(
      text,
    );
  if (!looksLikeProgress) return false;
  if (memory.tier === "ephemeral") return false;
  const stamp = memory.updatedAt ?? memory.createdAt;
  if (stamp == null) return true;
  return now - stamp >= staleProgressDays * MS_PER_DAY || memory.tier === "durable";
}

function isImperativeMemory(memory: LintMemory): boolean {
  const text = `${memory.title}\n${memory.body}`.trim().toLowerCase();
  return /^(remember to|always|never|do not|don't|run|use|make sure)\b/.test(text);
}

function hasSecretLikeContent(memory: LintMemory): boolean {
  const text = `${memory.title}\n${memory.body}`;
  return (
    /\b(aws_secret_access_key|api[_-]?key|secret[_-]?key|private[_-]?key|access[_-]?token|auth[_-]?token|password)\b\s*[:=]/i.test(
      text,
    ) ||
    /\bcredential (placeholder|value|material)\b/i.test(text)
  );
}

function duplicatePairs(memories: LintMemory[]): Array<{ memory: LintMemory; related: LintMemory }> {
  const pairs: Array<{ memory: LintMemory; related: LintMemory }> = [];
  const signatures = memories.map((memory) => ({
    memory,
    tokens: new Set(normalizedTokens(`${memory.title}\n${memory.body}`)),
  }));

  for (let i = 0; i < signatures.length; i++) {
    for (let j = i + 1; j < signatures.length; j++) {
      const left = signatures[i]!;
      const right = signatures[j]!;
      if (left.tokens.size < 5 || right.tokens.size < 5) continue;
      if (jaccard(left.tokens, right.tokens) >= 0.72) {
        pairs.push({ memory: right.memory, related: left.memory });
      }
    }
  }
  return pairs;
}

function normalizedTokens(text: string): string[] {
  const stop = new Set(["a", "an", "and", "are", "before", "for", "must", "the", "this", "to"]);
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .map(stemToken)
    .filter((token) => token.length > 1 && !stop.has(token));
}

function stemToken(token: string): string {
  if (token.endsWith("ies") && token.length > 4) return `${token.slice(0, -3)}y`;
  if (token.endsWith("ing") && token.length > 5) return token.slice(0, -3);
  if (token.endsWith("es") && token.length > 4) return token.slice(0, -2);
  if (token.endsWith("s") && token.length > 3) return token.slice(0, -1);
  return token;
}

function jaccard(left: Set<string>, right: Set<string>): number {
  let intersection = 0;
  for (const token of left) {
    if (right.has(token)) intersection += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/)[0]?.trim() ?? "";
}

function excerpt(text: string): string {
  return firstLine(text).slice(0, 180);
}

function parseScope(value: unknown): MemoryScope | undefined {
  return typeof value === "string" && isScope(value) ? value : undefined;
}

function parseTier(value: unknown): Tier | undefined {
  return typeof value === "string" && isTier(value) ? value : undefined;
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isScope(value: string): value is MemoryScope {
  return ["user", "project", "repo", "branch", "worktree", "session", "agent-run"].includes(value);
}

function isTier(value: string): value is Tier {
  return ["ephemeral", "durable", "reasoning"].includes(value);
}

function compareFindings(a: LintFinding, b: LintFinding): number {
  return (
    a.memoryId.localeCompare(b.memoryId) ||
    findingOrder(a.code) - findingOrder(b.code) ||
    (a.relatedMemoryId ?? "").localeCompare(b.relatedMemoryId ?? "")
  );
}

function findingOrder(code: LintFindingCode): number {
  return [
    "likely-secret",
    "stale-progress-fact",
    "imperative-memory",
    "missing-scope",
    "missing-tier",
    "duplicate-like",
  ].indexOf(code);
}
