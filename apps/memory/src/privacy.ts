import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import matter from "gray-matter";
import { readConfig, resolveNotesDir, resolveStoreUri, type MemoryConfig } from "./config.js";
import { MemoryStore, type StoredNode } from "./graph-store.js";

export type PrivacyMode = "uninitialized" | "markdown-only" | "graph" | "hybrid";
export type PrivacyStatus = "ok" | "uninitialized" | "degraded";

export type SensitiveKind =
  | "aws-access-key-id"
  | "openai-token"
  | "github-token"
  | "slack-token"
  | "private-key"
  | "credential-field";

export interface PrivacyFinding {
  kind: SensitiveKind;
  severity: "warning" | "error";
  memoryId: string;
  location: string;
  message: string;
  excerpt: string;
  redacted: string;
}

export interface PrivacyReport {
  status: PrivacyStatus;
  mode: PrivacyMode;
  readOnly: true;
  mutated: false;
  totalMemories: number;
  findings: PrivacyFinding[];
  warnings: string[];
}

export interface PrivacyMemoryRecord {
  id: string;
  location: string;
  fields: Record<string, unknown>;
}

interface GraphEdgeLike {
  rid: number;
  label: string;
  from: number;
  to: number;
  weight: number;
  properties: Record<string, unknown>;
}

const REDACTION_PREFIX = "[REDACTED:";

const VALUE_PATTERNS: ReadonlyArray<{ kind: SensitiveKind; pattern: RegExp }> = [
  { kind: "aws-access-key-id", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "openai-token", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { kind: "github-token", pattern: /\bgh[opsu]_[A-Za-z0-9_]{20,}\b/g },
  { kind: "slack-token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
  {
    kind: "private-key",
    pattern: /-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
  },
];

const CREDENTIAL_FIELD_PATTERN =
  /\b(?:api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|password|private[_-]?key)\b/i;

export async function scanPrivacy(rootDir: string): Promise<PrivacyReport> {
  const config = await readConfig(rootDir);
  if (!config) {
    return {
      status: "uninitialized",
      mode: "uninitialized",
      readOnly: true,
      mutated: false,
      totalMemories: 0,
      findings: [],
      warnings: ["memory is not initialized here"],
    };
  }

  const warnings: string[] = [];
  const memories = await collectPrivacyMemories(rootDir, config, warnings);
  return privacyReport(config.mode, memories, warnings);
}

export function privacyReport(
  mode: PrivacyMode,
  memories: PrivacyMemoryRecord[],
  warnings: string[] = [],
): PrivacyReport {
  return {
    status: warnings.length > 0 ? "degraded" : "ok",
    mode,
    readOnly: true,
    mutated: false,
    totalMemories: memories.length,
    findings: scanPrivacyRecords(memories),
    warnings,
  };
}

export function scanPrivacyRecords(memories: PrivacyMemoryRecord[]): PrivacyFinding[] {
  const findings: PrivacyFinding[] = [];
  for (const memory of memories) {
    for (const finding of scanUnknown(memory.fields, memory.id, memory.location, [])) {
      findings.push(finding);
    }
  }
  return findings.sort(comparePrivacyFindings);
}

export function redactSensitiveText(text: string): string {
  let redacted = text;
  for (const { kind, pattern } of VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, redact(kind));
  }
  return redacted;
}

export function redactSensitiveValue(value: unknown, path: string[] = []): unknown {
  if (typeof value === "string") {
    if (path.some((part) => CREDENTIAL_FIELD_PATTERN.test(part))) {
      return value ? redact("credential-field") : value;
    }
    return redactSensitiveText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactSensitiveValue(item, [...path, String(index)]));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactSensitiveValue(item, [...path, key]),
      ]),
    );
  }
  if (path.some((part) => CREDENTIAL_FIELD_PATTERN.test(part)) && value != null) {
    return redact("credential-field");
  }
  return value;
}

export function redactGraphData<TNode extends StoredNode, TEdge extends GraphEdgeLike>(
  nodes: TNode[],
  edges: TEdge[],
): { nodes: TNode[]; edges: TEdge[]; findings: PrivacyFinding[] } {
  const memories: PrivacyMemoryRecord[] = [
    ...nodes.map((node) => graphNodeRecord(node)),
    ...edges.map((edge) => graphEdgeRecord(edge)),
  ];
  const findings = scanPrivacyRecords(memories);
  return {
    nodes: nodes.map((node) => ({
      ...node,
      label: redactSensitiveText(node.label),
      properties: redactSensitiveValue(node.properties, ["properties"]) as TNode["properties"],
    })),
    edges: edges.map((edge) => ({
      ...edge,
      label: redactSensitiveText(edge.label),
      properties: redactSensitiveValue(edge.properties, ["properties"]) as TEdge["properties"],
    })),
    findings,
  };
}

export function redactionMarker(kind: SensitiveKind): string {
  return redact(kind);
}

async function collectPrivacyMemories(
  rootDir: string,
  config: MemoryConfig,
  warnings: string[],
): Promise<PrivacyMemoryRecord[]> {
  if (config.mode === "markdown-only") {
    return collectMarkdownPrivacyMemories(resolveNotesDir(rootDir, config), warnings);
  }

  if (config.mode === "graph") {
    let store: MemoryStore | null = null;
    try {
      store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
      const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
      return [
        ...nodes.map((node) => graphNodeRecord(node)),
        ...edges.map((edge) => graphEdgeRecord(edgeToLike(edge))),
      ];
    } catch (err) {
      warnings.push(`graph store could not be read: ${err instanceof Error ? err.message : String(err)}`);
      return [];
    } finally {
      await store?.close().catch(() => {});
    }
  }

  warnings.push(`privacy scan does not inspect "${config.mode}" storage yet`);
  return [];
}

async function collectMarkdownPrivacyMemories(
  notesDir: string,
  warnings: string[],
): Promise<PrivacyMemoryRecord[]> {
  let entries: string[];
  try {
    entries = (await readdir(notesDir)).filter((file) => file.endsWith(".md")).sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    warnings.push(`markdown notes could not be read: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }

  const memories: PrivacyMemoryRecord[] = [];
  for (const file of entries) {
    const path = join(notesDir, file);
    try {
      const raw = await readFile(path, "utf8");
      const parsed = matter(raw);
      const data = parsed.data as Record<string, unknown>;
      memories.push({
        id: typeof data.id === "string" ? data.id : basename(file, ".md"),
        location: path,
        fields: {
          frontmatter: data,
          body: parsed.content,
        },
      });
    } catch (err) {
      warnings.push(`markdown note ${path} could not be read: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return memories;
}

function graphNodeRecord(node: StoredNode): PrivacyMemoryRecord {
  return {
    id: `memory_nodes:${node.rid}`,
    location: `memory_nodes:${node.rid}`,
    fields: {
      label: node.label,
      node_type: node.node_type,
      properties: node.properties,
    },
  };
}

function graphEdgeRecord(edge: GraphEdgeLike): PrivacyMemoryRecord {
  return {
    id: `memory_edges:${edge.rid}`,
    location: `memory_edges:${edge.rid}`,
    fields: {
      label: edge.label,
      properties: edge.properties,
    },
  };
}

function edgeToLike(row: Record<string, unknown>): GraphEdgeLike {
  return {
    rid: Number(row.rid ?? row.red_entity_id ?? 0),
    label: String(row.label ?? row.LABEL ?? ""),
    from: Number(row.from ?? row.from_id ?? row.from_rid ?? row.source ?? row.FROM ?? 0),
    to: Number(row.to ?? row.to_id ?? row.to_rid ?? row.target ?? row.TO ?? 0),
    weight: Number(row.weight ?? row.WEIGHT ?? 1),
    properties: asRecord(row.properties ?? row.PROPERTIES),
  };
}

function* scanUnknown(
  value: unknown,
  memoryId: string,
  location: string,
  path: string[],
): Generator<PrivacyFinding> {
  if (typeof value === "string") {
    yield* scanString(value, memoryId, location, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      yield* scanUnknown(value[i], memoryId, location, [...path, String(i)]);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const nextPath = [...path, key];
      if (CREDENTIAL_FIELD_PATTERN.test(key) && item != null) {
        yield finding("credential-field", memoryId, location, nextPath, String(item));
      }
      yield* scanUnknown(item, memoryId, location, nextPath);
    }
  }
}

function* scanString(
  text: string,
  memoryId: string,
  location: string,
  path: string[],
): Generator<PrivacyFinding> {
  for (const { kind, pattern } of VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      yield finding(kind, memoryId, location, path, match[0] ?? "");
    }
  }
}

function finding(
  kind: SensitiveKind,
  memoryId: string,
  location: string,
  path: string[],
  value: string,
): PrivacyFinding {
  const redacted = redact(kind);
  return {
    kind,
    severity: "error",
    memoryId,
    location: path.length > 0 ? `${location}#${path.join(".")}` : location,
    message: "Memory contains sensitive-looking material that should not be exported raw.",
    excerpt: excerpt(value, redacted),
    redacted,
  };
}

function excerpt(value: string, redacted: string): string {
  return redactSensitiveText(value).replace(value, redacted).slice(0, 180);
}

function redact(kind: SensitiveKind): string {
  return `${REDACTION_PREFIX}${kind}]`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function comparePrivacyFindings(a: PrivacyFinding, b: PrivacyFinding): number {
  return (
    a.memoryId.localeCompare(b.memoryId) ||
    a.location.localeCompare(b.location) ||
    a.kind.localeCompare(b.kind)
  );
}
