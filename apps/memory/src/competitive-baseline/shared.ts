import type { CompetitiveEvalFixture } from "../competitive-fixtures.js";
import { type RecallStore } from "../engine.js";
import type { GraphRow, SearchRow, StoredNode } from "../graph-store.js";

export class FixtureRecallStore implements RecallStore {
  constructor(private readonly fixture: CompetitiveEvalFixture) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.fixture.nodes.map((node) => ({
      ...node,
      properties: { ...node.properties },
    }));
  }

  async searchText(query: string, limit = 20): Promise<SearchRow[]> {
    const terms = query.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    return this.fixture.nodes
      .map((node) => ({
        rid: node.rid,
        score: terms.filter((term) => nodeSearchText(node).includes(term)).length,
      }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score || a.rid - b.rid)
      .slice(0, limit);
  }

  async neighborhood(): Promise<GraphRow[]> {
    return [];
  }

  async supersededByMany(): Promise<Map<number, number>> {
    return new Map();
  }

  async recordAccess(): Promise<void> {}

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.fixture.edges.map((edge) => ({ ...edge }));
  }
}

function nodeSearchText(node: StoredNode): string {
  const props = node.properties;
  return [node.label, props.title, props.summary, props.content, ...(props.tags ?? [])]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function roundMetric(value: number): number {
  return Number(value.toFixed(4));
}

export function p50(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

export function rawCorpusChars(fixture: CompetitiveEvalFixture): number {
  return fixture.nodes.reduce((sum, node) => {
    const props = node.properties;
    return sum + String(props.title ?? node.label).length + String(props.content ?? props.summary ?? "").length;
  }, 0);
}
