/**
 * Confidence reader (issue #167) — resolves a node id to its composed
 * confidence breakdown. The composer lives in `confidence-scoring.ts`; this
 * module is the I/O wrapper used by CLI / MCP / HTTP.
 */

import {
  type ConfidenceBreakdown,
  type ConfidenceSignals,
  scoreConfidence,
} from "./confidence-scoring.js";
import {
  buildConfidenceContext,
  confidenceSignalsFor,
  type ConfidenceContext,
} from "./engine.js";
import type { MemoryStore } from "./graph-store.js";
import type { NodeType } from "./schema.js";

export interface ConfidenceReport {
  schema_version: "memory.confidence.v1";
  read_only: true;
  node: {
    rid: number;
    label: string;
    node_type: NodeType;
    title: string;
  };
  confidence: number;
  breakdown: ConfidenceBreakdown;
  signals: ConfidenceSignals;
}

export async function buildConfidenceReport(
  store: MemoryStore,
  nodeId: number | string,
  now: number = Date.now(),
): Promise<ConfidenceReport | null> {
  const rid = Number(nodeId);
  if (!Number.isFinite(rid)) return null;
  const nodes = await store.listNodes();
  const node = nodes.find((n) => n.rid === rid);
  if (!node) return null;
  const ctx: ConfidenceContext = await buildConfidenceContext(store, now);
  const signals = confidenceSignalsFor(node, ctx);
  const breakdown = scoreConfidence(signals);
  return {
    schema_version: "memory.confidence.v1",
    read_only: true,
    node: {
      rid: node.rid,
      label: node.label,
      node_type: node.node_type,
      title:
        typeof node.properties.title === "string" && node.properties.title.length > 0
          ? node.properties.title
          : node.label,
    },
    confidence: breakdown.confidence,
    breakdown,
    signals,
  };
}

export function renderConfidenceMarkdown(report: ConfidenceReport): string {
  const lines = [
    `# Confidence: ${report.node.title}`,
    "",
    `rid: ${report.node.rid}`,
    `node_type: ${report.node.node_type}`,
    `confidence: ${report.confidence.toFixed(3)}`,
    "",
    "## Components",
    `- provenance: ${report.breakdown.components.provenance.toFixed(3)}`,
    `- recency: ${report.breakdown.components.recency.toFixed(3)}`,
    `- supersession: ${report.breakdown.components.supersession.toFixed(3)}`,
    `- validation: ${report.breakdown.components.validation.toFixed(3)}`,
    "",
    "## Signals",
    `- provenance_depth: ${report.signals.provenance_depth}`,
    `- recency: ${report.signals.recency.toFixed(3)}`,
    `- supersession_status: ${report.signals.supersession_status}`,
    `- validation_signal: ${report.signals.validation_signal.toFixed(3)}`,
  ];
  return `${lines.join("\n")}\n`;
}
