import type { MemoryProvenance } from "./schema.js";
import type { MemoryStore, StoredNode } from "./graph-store.js";

export interface ProvenanceReport {
  node: {
    rid: number;
    label: string;
    node_type: string;
    title: string;
  };
  provenance: {
    missing: boolean;
    sourceKind: string | null;
    writer: string | null;
    command: string | null;
    hook: string | null;
    scope: {
      level: string | null;
      id: string | null;
    };
    confidence: string | null;
    timestamps: {
      createdAt: string | null;
      updatedAt: string | null;
      provenanceCreatedAt: string | null;
      provenanceUpdatedAt: string | null;
    };
    evidence: string[];
  };
}

export async function findNodeForProvenance(
  store: MemoryStore,
  target: string,
): Promise<StoredNode | null> {
  const asRid = Number(target);
  if (Number.isInteger(asRid) && asRid > 0) return store.getNode(asRid);
  const rid = await store.findNodeByLabel(target);
  return rid == null ? null : store.getNode(rid);
}

export function buildProvenanceReport(node: StoredNode): ProvenanceReport {
  const props = node.properties;
  const provenance = isProvenance(props.provenance) ? props.provenance : null;
  return {
    node: {
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title: props.title,
    },
    provenance: {
      missing: provenance == null,
      sourceKind: provenance?.source_kind ?? null,
      writer: stringValue(provenance?.writer),
      command: stringValue(provenance?.command),
      hook: stringValue(provenance?.hook),
      scope: {
        level: stringValue(provenance?.scope?.level ?? props.scope),
        id: stringValue(provenance?.scope?.id ?? props.scope_id),
      },
      confidence: stringValue(provenance?.confidence ?? props.confidence),
      timestamps: {
        createdAt: millisToIso(props.created_at),
        updatedAt: millisToIso(props.updated_at),
        provenanceCreatedAt: millisToIso(provenance?.created_at),
        provenanceUpdatedAt: millisToIso(provenance?.updated_at),
      },
      evidence: Array.isArray(provenance?.evidence) ? provenance.evidence.map(String) : [],
    },
  };
}

export function formatProvenanceHuman(report: ProvenanceReport): string {
  const p = report.provenance;
  const lines = [
    `memory provenance: node ${report.node.rid} (${report.node.node_type}) ${report.node.label}`,
    `  title: ${report.node.title}`,
  ];
  if (p.missing) {
    lines.push("  provenance: missing (node has no provenance metadata)");
  }
  lines.push(`  source kind: ${p.sourceKind ?? "missing"}`);
  lines.push(`  writer: ${p.writer ?? "missing"}`);
  if (p.command) lines.push(`  command: ${p.command}`);
  if (p.hook) lines.push(`  hook: ${p.hook}`);
  lines.push(`  scope: ${[p.scope.level, p.scope.id].filter(Boolean).join(" ") || "missing"}`);
  lines.push(`  confidence: ${p.confidence ?? "missing"}`);
  lines.push(`  created: ${p.timestamps.createdAt ?? "missing"}`);
  lines.push(`  updated: ${p.timestamps.updatedAt ?? "missing"}`);
  if (p.evidence.length > 0) lines.push(`  evidence: ${p.evidence.join("; ")}`);
  return `${lines.join("\n")}\n`;
}

function isProvenance(value: unknown): value is MemoryProvenance {
  return value != null && typeof value === "object" && "source_kind" in value;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function millisToIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : null;
}
