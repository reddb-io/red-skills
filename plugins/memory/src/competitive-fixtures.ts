import type { StoredNode } from "./graph-store.js";
import type { MemoryScope, Tier } from "./schema.js";

export interface CompetitiveRecallFixture {
  id: string;
  query: string;
  expectedRids: number[];
  k: number;
}

export interface CompetitiveContextPackFixture {
  id: string;
  goal: string;
  budgetChars: number;
}

export interface CompetitiveCandidateFixture {
  id: string;
  text: string;
  expectedKind: string;
  expectedTier: Tier;
  expectedScope: MemoryScope;
  expectedWarnings: string[];
}

export interface CompetitivePolicyMemoryFixture {
  id: string;
  title: string;
  body: string;
  scope?: MemoryScope;
  tier?: Tier;
  createdAt?: number;
}

export interface CompetitiveLiveBaselineFixture {
  competitor: "agent-memory";
  metric: string;
  configured: boolean;
  assertedClaim: boolean;
}

export interface CompetitiveEvalFixture {
  name: string;
  source: "checked-in";
  nodes: StoredNode[];
  edges: Record<string, unknown>[];
  recall: CompetitiveRecallFixture[];
  contextPacks: CompetitiveContextPackFixture[];
  candidates: CompetitiveCandidateFixture[];
  policyMemories: CompetitivePolicyMemoryFixture[];
  liveBaselines: CompetitiveLiveBaselineFixture[];
}

const NOW = 1_700_000_000_000;

function node(
  rid: number,
  node_type: StoredNode["node_type"],
  title: string,
  content: string,
  tags: string[],
): StoredNode {
  return {
    rid,
    label: title.toLowerCase().replace(/\W+/g, "-"),
    node_type,
    properties: {
      title,
      content,
      tags,
      confidence: "EXTRACTED",
      source: "competitive-fixture",
      importance: 0.9,
      tier: "durable",
      scope: "project",
      created_at: NOW,
      updated_at: NOW,
    },
  };
}

export const competitiveEvalFixture: CompetitiveEvalFixture = {
  name: "memory-moat-claims",
  source: "checked-in",
  nodes: [
    node(
      1,
      "concept",
      "Release gate policy",
      "Project rule: Memory README moat claims must be backed by executable eval output. Before changing comparison copy, run pnpm test, typecheck, and the competitive eval command, then cite the measured harness result instead of unsupported copy.",
      ["release", "readme", "claims"],
    ),
    node(
      2,
      "decision",
      "Context pack budget decision",
      "Decision: context packs should compile recalled graph evidence into cited, budgeted Markdown. They are useful when the packed context is materially smaller than the naive full-memory prompt while keeping the relevant constraints and prior decisions.",
      ["context-pack", "budget", "reduction"],
    ),
    node(
      3,
      "problem",
      "Policy lint storage pitfall",
      "Pitfall: durable Memory should not store current progress updates, raw task logs, imperative instructions, or credential placeholders. Candidate memories should be classified before persistence and lint should flag policy violations.",
      ["policy", "lint", "credential", "progress"],
    ),
    node(
      4,
      "workflow",
      "Do not claim live competitor wins",
      "Do not claim apples-to-apples wins against service-backed competitors unless the live baseline is configured and measured. Mark those comparisons as unmeasured when the harness only has checked-in local fixtures.",
      ["competitor", "live-baseline", "claims"],
    ),
    node(
      5,
      "concept",
      "Graphify fixture baseline",
      "The checked graphify-out baseline records 551 nodes, 1329 edges, 34 communities, 491 inferred edges, and an 841 ms path p50. Claims against graphify in this repo must stay tied to this checked fixture.",
      ["graphify", "latency", "fixture"],
    ),
    node(
      6,
      "concept",
      "Agent-memory live baseline gap",
      "Apples-to-apples recall latency or extraction-quality claims against neo4j-labs agent-memory require a live Neo4j baseline. Without that configured live service, the README may only mark the comparison as unmeasured or conceded.",
      ["agent-memory", "neo4j", "live-baseline"],
    ),
  ],
  edges: [
    { from: 1, to: 2, label: "REFERENCES" },
    { from: 2, to: 3, label: "REFERENCES" },
    { from: 4, to: 6, label: "REFERENCES" },
    { from: 5, to: 1, label: "REFERENCES" },
  ],
  recall: [
    {
      id: "readme-claims-release-gate",
      query: "release memory README claims",
      expectedRids: [1],
      k: 3,
    },
    {
      id: "live-competitor-latency",
      query: "live Neo4j competitor latency claim",
      expectedRids: [4, 6],
      k: 4,
    },
    {
      id: "policy-credential-progress",
      query: "policy credential progress memory",
      expectedRids: [3],
      k: 3,
    },
  ],
  contextPacks: [
    {
      id: "readme-moat-update",
      goal: "Update README with measured memory moat claims",
      budgetChars: 950,
    },
  ],
  candidates: [
    {
      id: "stable-project-rule",
      text: "Project rule: competitive README rows must cite the eval harness output.",
      expectedKind: "store",
      expectedTier: "durable",
      expectedScope: "project",
      expectedWarnings: [],
    },
    {
      id: "temporary-progress",
      text: "Current progress: tests are running for the eval harness implementation.",
      expectedKind: "ephemeral",
      expectedTier: "ephemeral",
      expectedScope: "session",
      expectedWarnings: [],
    },
    {
      id: "secret-like-token",
      text: "api_key = sk_fixture_1234567890abcdef1234567890",
      expectedKind: "redact",
      expectedTier: "ephemeral",
      expectedScope: "session",
      expectedWarnings: ["likely-secret"],
    },
    {
      id: "decision-rationale",
      text: "Decision rationale: use checked fixtures because live competitors require external services.",
      expectedKind: "reasoning",
      expectedTier: "reasoning",
      expectedScope: "project",
      expectedWarnings: [],
    },
    {
      id: "branch-specific",
      text: "On branch eval-harness, the fixture names are temporary until the PR lands.",
      expectedKind: "scope-narrowly",
      expectedTier: "durable",
      expectedScope: "branch",
      expectedWarnings: [],
    },
  ],
  policyMemories: [
    {
      id: "lint-good",
      title: "Stable eval rule",
      body: "Project rule: checked fixtures back competitive comparison claims.",
      scope: "project",
      tier: "durable",
      createdAt: NOW,
    },
    {
      id: "lint-progress",
      title: "Current progress update",
      body: "Current progress: tests are running and the eval harness is halfway complete.",
      createdAt: NOW - 30 * 86_400_000,
    },
    {
      id: "lint-secret",
      title: "Remember to inspect credentials",
      body: "Remember to always inspect api_key: REDACTED before storing memory.",
      scope: "project",
      tier: "durable",
      createdAt: NOW,
    },
  ],
  liveBaselines: [
    {
      competitor: "agent-memory",
      metric: "recall latency",
      configured: false,
      assertedClaim: false,
    },
  ],
};
