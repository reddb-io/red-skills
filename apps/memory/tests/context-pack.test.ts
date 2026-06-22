import { describe, expect, test } from "vitest";
import {
  buildContextPack,
  parseExpandHandle,
  type ContentCompressor,
  type ContextPackStore,
} from "../src/context-pack.js";
import { buildContextPackViewerArtifact } from "../src/context-pack-viewer.js";
import type { GraphRow, SearchRow, StoredNode } from "../src/graph-store.js";

class MockStore implements ContextPackStore {
  constructor(
    private readonly nodes: StoredNode[],
    private readonly superseded: Map<number, number> = new Map(),
    private readonly edges: Record<string, unknown>[] = [],
  ) {}

  async listNodes(): Promise<StoredNode[]> {
    return this.nodes;
  }

  async searchText(): Promise<SearchRow[]> {
    return [];
  }

  async neighborhood(): Promise<GraphRow[]> {
    throw new Error("context pack should use recall/listEdges, not per-seed graph walks");
  }

  async supersededByMany(rids: number[]): Promise<Map<number, number>> {
    const out = new Map<number, number>();
    for (const rid of rids) {
      const to = this.superseded.get(rid);
      if (to != null) out.set(rid, to);
    }
    return out;
  }

  async recordAccess(): Promise<void> {}

  async listEdges(): Promise<Record<string, unknown>[]> {
    return this.edges;
  }

  /** Existing recall-by-rid path an expand handle round-trips through. */
  async getNode(rid: number): Promise<StoredNode | null> {
    return this.nodes.find((node) => node.rid === rid) ?? null;
  }
}

const NOW = 1_700_000_000_000;

function node(
  rid: number,
  node_type: StoredNode["node_type"],
  title: string,
  content: string,
  extra: Partial<StoredNode["properties"]> = {},
): StoredNode {
  return {
    rid,
    label: title.toLowerCase().replace(/\W+/g, "-"),
    node_type,
    properties: {
      title,
      content,
      confidence: "EXTRACTED",
      source: "manual",
      importance: 0.5,
      tier: "durable",
      created_at: NOW,
      ...extra,
    },
  };
}

describe("context packs", () => {
  test("groups recalled evidence into budgeted cited sections", async () => {
    const store = new MockStore([
      node(1, "concept", "Auth token constraint", "Token TTL changes must update docs/security.md."),
      node(2, "decision", "JWT library decision", "Decision: use jose for JWT verification."),
      node(3, "problem", "JWT staging pitfall", "Pitfall: staging rejects tokens when clock skew exceeds 30 seconds."),
      node(4, "fix", "JWT refresh prior work", "Similar past work: refresh rotation landed in issue 92."),
      node(5, "workflow", "Do not bypass JWT checks", "Do not bypass JWT checks in tests; use signed fixtures."),
    ]);

    const pack = await buildContextPack(store, "jwt token work", {
      budgetChars: 2_000,
      now: NOW,
    });

    expect(pack.status).toBe("ok");
    expect(pack.coreContext).toEqual([]);
    expect(pack.markdown.length).toBeLessThanOrEqual(2_000);
    expect(pack.markdown).toContain("## Hard constraints");
    expect(pack.markdown).toContain("## Prior decisions");
    expect(pack.markdown).toContain("## Known pitfalls");
    expect(pack.markdown).toContain("## Similar past work");
    expect(pack.markdown).toContain("## Do-not-do guidance");
    expect(pack.markdown).toContain("[M1]");
    expect(pack.markdown).toContain("urn: memory_nodes:1");
    expect(pack.markdown).toContain("trust: 1.00");
    expect(pack.markdown).toContain("importance: 0.50");
    expect(pack.markdown).toContain("Reason:");
    expect(pack.entries.map((entry) => entry.citation.urn)).toEqual([
      "memory_nodes:1",
      "memory_nodes:2",
      "memory_nodes:3",
      "memory_nodes:4",
      "memory_nodes:5",
    ]);

    const artifact = buildContextPackViewerArtifact(pack);
    expect(artifact.contract).toEqual({
      name: "memory.context_pack.viewer",
      version: "memory.context_pack.viewer.v1",
      consumes: "memory.context_pack.v1",
    });
    expect(artifact.html).toContain("Memory Context Pack");
    expect(artifact.html).toContain("Auth token constraint");
    expect(artifact.html).toContain('id="memory-context-pack-data"');
  });

  test("renders pinned eligible nodes as cited core context before ordinary sections", async () => {
    const store = new MockStore([
      node(1, "decision", "Pinned JWT invariant", "Decision: JWT token work must update docs/security.md.", {
        importance: 0.9,
        confidence: "INFERRED",
        provenance: {
          source_kind: "hook",
          writer: "codex",
          command: "memory extract",
          evidence: ["issue #42"],
        },
      }),
      node(2, "problem", "JWT rollout pitfall", "Pitfall: JWT rollout failed when signed fixtures were stale."),
    ]);

    const pack = await buildContextPack(store, "jwt token work", {
      budgetChars: 2_000,
      now: NOW,
    });

    expect(pack.coreContext.map((entry) => entry.citation.rid)).toEqual([1]);
    expect(pack.entries.map((entry) => entry.citation.rid)).toEqual([1, 2]);
    expect(pack.coreContext[0]).toMatchObject({
      citation: { marker: "[M1]", urn: "memory_nodes:1" },
      confidence: "INFERRED",
      confidence_score: expect.any(Number),
      trust: 0.85,
      importance: 0.9,
      provenance: { source_kind: "hook", writer: "codex" },
    });
    expect(pack.markdown.indexOf("## Core context")).toBeGreaterThan(-1);
    expect(pack.markdown.indexOf("## Core context")).toBeLessThan(
      pack.markdown.indexOf("## Known pitfalls"),
    );
    expect(pack.markdown).toContain("[M1] Pinned JWT invariant");
    expect(pack.markdown).toContain("provenance: hook/codex");
    expect(pack.markdown).toContain("trust: 0.85");
    expect(pack.markdown).toContain("[M2] JWT rollout pitfall");

    const artifact = buildContextPackViewerArtifact(pack);
    expect(artifact.html.indexOf("Core Context")).toBeLessThan(
      artifact.html.indexOf("Known Pitfalls"),
    );
    expect(artifact.html).toContain("[M1] Pinned JWT invariant");
    expect(artifact.html).toContain("provenance hook/codex");
  });

  test("can include shared skill recommendation data", async () => {
    const store = new MockStore([
      node(
        10,
        "workflow",
        "Debugging skill guidance",
        "For debugging failures, use dev:diagnose.",
        { tags: ["skill:dev:diagnose"] },
      ),
    ]);

    const pack = await buildContextPack(store, "debug flaky failures", {
      budgetChars: 2_000,
      now: NOW,
      skillRollups: [
        {
          name: "dev:diagnose",
          source_kind: "plugin",
          path: "/plugins/dev/skills/engineering/diagnose/SKILL.md",
          first_seen: "2026-05-22T16:00:00.000Z",
          last_activity: "2026-05-22T17:00:00.000Z",
          event_count: 3,
          view_count: 1,
          use_count: 1,
          patch_count: 0,
          change_count: 0,
          result_count: 1,
          outcome_counts: { succeeded: 1 },
          curatable_status: "active",
          archive_signal: false,
          consolidation_signal: false,
        },
      ],
    });

    expect(pack.skillRecommendations.recommendations[0]).toMatchObject({
      name: "dev:diagnose",
      evidenceStrength: "strong",
    });
    expect(pack.markdown).toContain("## Skill recommendations");
    expect(pack.markdown).toContain("dev:diagnose");
    expect(pack.markdown).toContain("[M1]");
    expect(pack.markdown).toContain("[T1]");
  });

  test("returns an explicit insufficient-context result for empty recall", async () => {
    const pack = await buildContextPack(new MockStore([]), "missing topic", {
      budgetChars: 500,
      now: NOW,
    });

    expect(pack.status).toBe("insufficient-context");
    expect(pack.entries).toEqual([]);
    expect(pack.markdown).toContain("Status: insufficient-context");
    expect(pack.markdown).toContain("No strong Memory evidence");
    expect(pack.markdown.length).toBeLessThanOrEqual(500);
  });

  test("surfaces superseded and contradictory evidence as warnings", async () => {
    const store = new MockStore(
      [
        node(1, "decision", "Old deploy decision", "Decision: deploy jwt changes on Fridays."),
        node(2, "decision", "Current deploy decision", "Decision: deploy jwt changes on Tuesdays."),
        node(3, "problem", "Token cache conflict", "Pitfall: token cache settings conflict with Tuesday deploys."),
      ],
      new Map([[1, 2]]),
      [
        {
          label: "CONTRADICTS",
          from: 2,
          to: 3,
          properties: { reason: "cache guidance disagrees with deploy window" },
        },
      ],
    );

    const pack = await buildContextPack(store, "jwt deploy", { budgetChars: 2_000, now: NOW });

    expect(pack.warnings).toEqual([
      expect.objectContaining({ kind: "superseded", rids: [1, 2] }),
      expect.objectContaining({ kind: "contradiction", rids: [2, 3] }),
    ]);
    expect(pack.entries.map((entry) => entry.citation.rid)).not.toContain(1);
    expect(pack.markdown).toContain("## Warnings");
    expect(pack.markdown).toContain("superseded by memory_nodes:2");
    expect(pack.markdown).toContain("contradicts memory_nodes:3");
  });

  test("excludes superseded pinned nodes from core context while warning about them", async () => {
    const store = new MockStore(
      [
        node(1, "decision", "Old pinned JWT decision", "Decision: jwt deploys on Fridays.", {
          importance: 0.95,
        }),
        node(2, "decision", "Current JWT decision", "Decision: jwt deploys on Tuesdays.", {
          importance: 0.6,
        }),
      ],
      new Map([[1, 2]]),
    );

    const pack = await buildContextPack(store, "jwt deploy", { budgetChars: 2_000, now: NOW });

    expect(pack.coreContext.map((entry) => entry.citation.rid)).not.toContain(1);
    expect(pack.entries.map((entry) => entry.citation.rid)).not.toContain(1);
    expect(pack.warnings).toEqual([
      expect.objectContaining({ kind: "superseded", rids: [1, 2] }),
    ]);
    expect(pack.markdown).toContain("memory_nodes:1 is superseded by memory_nodes:2");
  });

  test("does not let pinned nodes bypass recall scope eligibility", async () => {
    const store = new MockStore([
      node(1, "decision", "Pinned session JWT secret", "Decision: jwt session-only secret.", {
        importance: 0.95,
        scope: "session",
        scope_id: "session-a",
      }),
      node(2, "decision", "Project JWT decision", "Decision: jwt project work uses signed fixtures.", {
        importance: 0.6,
      }),
    ]);

    const projectPack = await buildContextPack(store, "jwt", { budgetChars: 2_000, now: NOW });
    expect(projectPack.entries.map((entry) => entry.citation.rid)).toEqual([2]);
    expect(projectPack.coreContext).toEqual([]);

    const sessionPack = await buildContextPack(store, "jwt", {
      budgetChars: 2_000,
      now: NOW,
      scope: { level: "session", id: "session-a" },
    });
    expect(sessionPack.coreContext.map((entry) => entry.citation.rid)).toEqual([1]);
  });

  test("keeps deterministic ranking order while enforcing the caller budget", async () => {
    const store = new MockStore([
      node(1, "decision", "High rank decision", "Decision: jwt deploy jwt rollout uses canaries."),
      node(2, "decision", "Lower rank decision", "Decision: jwt rollout keeps logs quiet."),
    ]);

    const fullPack = await buildContextPack(store, "jwt deploy", {
      budgetChars: 2_000,
      now: NOW,
    });
    expect(fullPack.entries.map((entry) => entry.citation.rid)).toEqual([1, 2]);

    const budgeted = await buildContextPack(store, "jwt deploy", {
      budgetChars: 360,
      now: NOW,
    });
    expect(budgeted.markdown.length).toBeLessThanOrEqual(360);
    expect(budgeted.entries.map((entry) => entry.citation.rid)).toEqual([1]);
    expect(budgeted.omittedEntries).toBe(1);
    expect(budgeted.warnings).toEqual([
      expect.objectContaining({ kind: "budget", rids: [2] }),
    ]);
  });

  test("accounts for core context before ordinary recalled sections in the budget", async () => {
    const store = new MockStore([
      node(1, "decision", "Pinned budget JWT decision", "Decision: jwt budget must preserve core context.", {
        importance: 0.95,
      }),
      node(2, "decision", "Ordinary budget JWT decision", "Decision: jwt budget may omit ordinary context."),
    ]);
    const fullPack = await buildContextPack(store, "jwt budget", {
      budgetChars: 2_000,
      now: NOW,
    });
    const budget = fullPack.markdown.indexOf("[M2]") - 1;

    const budgeted = await buildContextPack(store, "jwt budget", {
      budgetChars: budget,
      now: NOW,
    });

    expect(budgeted.markdown.length).toBeLessThanOrEqual(budget);
    expect(budgeted.coreContext.map((entry) => entry.citation.rid)).toEqual([1]);
    expect(budgeted.entries.map((entry) => entry.citation.rid)).toEqual([1]);
    expect(budgeted.omittedEntries).toBe(1);
    expect(budgeted.warnings).toEqual([
      expect.objectContaining({ kind: "budget", rids: [2] }),
    ]);
  });
});

describe("context pack compression (#827)", () => {
  const CODE_CONTENT = [
    'import { signToken } from "./auth.js";',
    "export function verifyAuthToken(token: string): AuthResult {",
    "  const decoded = decodeJwt(token);",
    '  if (!decoded) throw new Error("rejected bad token");',
    "  return { valid: true, subject: decoded.sub };",
    "}",
  ].join("\n");

  test("preserves load-bearing code (signatures/imports/types) and drops the body", async () => {
    const store = new MockStore([
      node(1, "symbol", "verifyAuthToken implementation", CODE_CONTENT),
    ]);

    const pack = await buildContextPack(store, "auth token verifyAuthToken", {
      budgetChars: 4_000,
      now: NOW,
    });

    const entry = pack.entries.find((e) => e.citation.rid === 1);
    expect(entry).toBeDefined();
    expect(entry?.compressed).toBe(true);
    expect(entry?.compressedKind).toBe("code");
    // Planted needle in the signature + the import survive compression.
    expect(entry?.excerpt).toContain("verifyAuthToken");
    expect(entry?.excerpt).toContain("signToken");
    // Pure body lines are dropped.
    expect(entry?.excerpt).not.toContain("rejected bad token");
    expect(pack.markdown).toContain("verifyAuthToken");
  });

  test("each compressed entry carries an expand handle that round-trips to the full node", async () => {
    const store = new MockStore([
      node(1, "symbol", "verifyAuthToken implementation", CODE_CONTENT),
    ]);

    const pack = await buildContextPack(store, "auth token verifyAuthToken", {
      budgetChars: 4_000,
      now: NOW,
    });

    const entry = pack.entries.find((e) => e.citation.rid === 1);
    expect(entry?.compressed).toBe(true);
    expect(entry?.expandHandle).toBe("memory:recall 1");
    expect(pack.markdown).toContain("memory:recall 1");

    // The handle round-trips back to the full node via the recall-by-rid path.
    const rid = parseExpandHandle(entry?.expandHandle ?? "");
    expect(rid).toBe(1);
    const full = await store.getNode(rid!);
    expect(full?.properties.content).toBe(CODE_CONTENT);
    expect(full?.properties.content).toContain("rejected bad token");
  });

  test("safety fallback: a forced compression error emits the original entry unchanged", async () => {
    const store = new MockStore([
      node(1, "symbol", "verifyAuthToken implementation", CODE_CONTENT),
    ]);
    const throwing: ContentCompressor = () => {
      throw new Error("forced compression failure");
    };

    const pack = await buildContextPack(store, "auth token verifyAuthToken", {
      budgetChars: 4_000,
      now: NOW,
      compressor: throwing,
    });

    const entry = pack.entries.find((e) => e.citation.rid === 1);
    expect(entry).toBeDefined();
    expect(entry?.compressed).toBe(false);
    expect(entry?.compressedKind).toBeUndefined();
    // The original (un-truncated-by-compression) excerpt is emitted as-is.
    expect(entry?.excerpt.length).toBeGreaterThan(0);
    expect(pack.markdown).not.toContain("Expand:");
  });

  test("compresses richer recall sets to pack more facts than truncation would", async () => {
    const long = (label: string) => "x".repeat(400) + ` ${label} config detail`;
    const structuredNodes = [1, 2, 3, 4, 5].map((rid) =>
      node(
        rid,
        "concept",
        `Config record ${rid}`,
        JSON.stringify({ summary: long(`s${rid}`), detail: long(`d${rid}`) }),
      ),
    );
    const store = new MockStore(structuredNodes);

    // Baseline: legacy truncation — slice content to the old 240-char width.
    const truncate: ContentCompressor = (n) => ({
      text: String(n.properties.content ?? "").slice(0, 240),
      kind: "prose",
      lossy: false,
    });

    const budgetChars = 1_400;
    const truncated = await buildContextPack(store, "config record detail", {
      budgetChars,
      now: NOW,
      compressor: truncate,
    });
    const compressed = await buildContextPack(store, "config record detail", {
      budgetChars,
      now: NOW,
    });

    expect(compressed.entries.length).toBeGreaterThan(truncated.entries.length);
    expect(compressed.omittedEntries).toBeLessThan(truncated.omittedEntries);
    const compressedEntry = compressed.entries[0];
    expect(compressedEntry.compressed).toBe(true);
    expect(compressedEntry.compressedKind).toBe("structured");
  });
});
