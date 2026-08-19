import type {
  CompetitiveEvalFixture,
  CompetitiveInteropArtifactFixture,
  CompetitiveInteropCompetitor,
  CompetitiveInteropDecisionKind,
} from "../competitive-fixtures.js";
import type { VectorRecallDiagnostics } from "../engine.js";
import type { LiveBaselineRunResult } from "../live-baseline-adapters.js";

type Claim = "advantage" | "parity" | "mixed" | "conceded-gap" | "not-claimed";

export interface GraphifyOutSummary {
  corpus: string;
  nodes: number;
  edges: number;
  communities: number;
  inferredEdges: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  measuredPathP50Ms: number;
}

export interface CompetitorBaseline {
  name: "memory" | "graphify" | "agent-memory";
  footprintScore: number;
  lifecycleScore: number;
  engineFeatures: {
    ttl: boolean;
    cache: boolean;
    louvain: boolean;
    geospatial: boolean;
    ask: boolean;
  };
  recallLatencyP50Ms?: number;
  nerExtractionQuality: "deterministic-or-llm" | "mixed-static-graph" | "python-ml-stack";
}

export interface BaselineAssertion {
  id: string;
  pass: boolean;
  detail: string;
}

export interface ComparisonRow {
  axis: string;
  memory: string;
  graphify: string;
  agentMemory: string;
  framing: string;
  claim: Claim;
}

export interface CompetitiveBaselineReport {
  generatedAt: string;
  graphifyOut: GraphifyOutSummary;
  competitors: CompetitorBaseline[];
  rows: ComparisonRow[];
  assertions: BaselineAssertion[];
  failedAssertions: BaselineAssertion[];
}

export interface CompetitiveEvalOptions {
  fixture?: CompetitiveEvalFixture;
  liveBaselines?: LiveBaselineRunResult[];
  now?: number;
  generatedAt?: string;
}

export interface CompetitiveEvalRecallCase {
  id: string;
  query: string;
  expectedRids: number[];
  returnedRids: number[];
  recallAtK: number;
  precisionAtK: number;
  reciprocalRank: number;
  latencyMs: number;
}

export interface CompetitiveEvalContextPackCase {
  id: string;
  goal: string;
  rawCorpusChars: number;
  packChars: number;
  reductionRatio: number;
  status: string;
  omittedEntries: number;
}

export interface CompetitiveEvalPolicyCase {
  id: string;
  expectedKind: string;
  actualKind: string;
  pass: boolean;
}

export interface FoundationGateAxis {
  id:
    | "retrieval"
    | "readiness"
    | "trust-governance"
    | "governed-write"
    | "skill-evolution"
    | "operator-surface"
    | "multi-agent-integration";
  score: number;
  maxScore: number;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface FoundationEvidenceGateReport {
  command: "pnpm --filter @reddb-io/benchmark-memory references:eval";
  evidenceBase: {
    name: string;
    source: "checked-in";
    nodes: number;
    edges: number;
    redDbBacked: true;
  };
  retrieval: {
    score: number;
    maxScore: number;
    hybridRecall: {
      queryCount: number;
      meanRecallAtK: number;
      vector: VectorRecallDiagnostics & {
        projectionOverall: string;
        projectionTotal: number;
      };
    };
    asOfRecall: {
      status: "available" | "unavailable";
      refKind: "commit";
      nodes: number;
      recalled: number;
      error?: string;
    };
  };
  readiness: {
    score: number;
    maxScore: number;
    status: string;
    contractVersion: string;
    consumerTargets: string[];
  };
  trustGovernance: {
    score: number;
    maxScore: number;
    claimCheck: string;
    privacyFindings: number;
    vcsTimeTravel: string;
    eventLog: {
      status: string;
      totalEvents: number;
      kinds: Record<string, number>;
    };
  };
  skillEvolution: {
    score: number;
    maxScore: number;
    telemetryEvents: number;
    communities: {
      count: number;
      assignments: number;
    };
  };
  operatorSurface: {
    score: number;
    maxScore: number;
    docCoverage: {
      totalDocs: number;
      groundedDocs: number;
      docsWithReferences: number;
      vectorOverall: string;
    };
    hookCoverage: {
      enabledEvents: number;
      wiredEvents: number;
      totalEvents: number;
      gaps: number;
    };
    dashboard: {
      contractVersion: string;
      consumes: string;
      htmlBytes: number;
      state: string;
    };
    capabilityCatalog: {
      total: number;
      categories: number;
      redDbBacked: number;
      ready: number;
      notConfigured: number;
    };
  };
  multiAgentIntegration: {
    score: number;
    maxScore: number;
    supportedAgents: number;
    readyAgents: number;
    partialAgents: number;
    missingAgents: number;
    mcpTools: number;
    cliFallbacks: number;
    hookCapableAgents: number;
    hookReadyAgents: number;
    sources: {
      routingGuide: "memory.routing_guide.v1";
      integrationStatus: "memory.agent_integration_status.v1";
    };
  };
  composite: {
    score: number;
    maxScore: number;
    status: "ready-foundation" | "review-foundation";
    axes: FoundationGateAxis[];
  };
  agentmemoryLiveBaseline: {
    state: "adapter-ready";
    implemented: true;
    note: string;
  };
}

export interface CompetitiveEvalReport {
  generatedAt: string;
  fixture: {
    name: string;
    source: "checked-in";
    nodes: number;
    edges: number;
  };
  recall: {
    queryCount: number;
    meanRecallAtK: number;
    meanPrecisionAtK: number;
    meanReciprocalRank: number;
    latency: {
      p50Ms: number;
      maxMs: number;
    };
    cases: CompetitiveEvalRecallCase[];
  };
  contextPacks: {
    packCount: number;
    meanReductionRatio: number;
    cases: CompetitiveEvalContextPackCase[];
  };
  policy: {
    totalCandidates: number;
    classificationAccuracy: number;
    cases: CompetitiveEvalPolicyCase[];
    lintCaseCount: number;
    lintFindings: string[];
  };
  foundationGate: FoundationEvidenceGateReport;
  claimGuards: {
    unsupportedLiveCompetitorClaims: string[];
    unmeasuredLiveBaselines: string[];
  };
}

export interface CompetitiveEvalV2Dimension {
  id:
    | "retrieval"
    | "readiness"
    | "trust-governance"
    | "governed-write"
    | "skill-evolution"
    | "operator-surface"
    | "multi-agent-integration"
    | "intelligence";
  score: number;
  maxScore: number;
  status: "pass" | "warn" | "fail";
  detail: string;
  evidence: string[];
  metrics: Record<string, string | number>;
  subChecks?: Array<{
    id: string;
    status: "pass" | "warn" | "fail";
    detail: string;
  }>;
}

export interface CompetitiveEvalV2Report {
  schemaVersion: "memory.reference_eval.v2";
  generatedAt: string;
  fixture: CompetitiveEvalReport["fixture"];
  liveServices: "not-required" | "opt-in";
  liveBaselines: LiveBaselineRunResult[];
  composite: {
    score: number;
    maxScore: number;
    normalizedScore: number;
    status: "pass" | "warn" | "fail";
  };
  dimensions: CompetitiveEvalV2Dimension[];
  claimGuards: {
    status: "pass" | "fail";
    unsupportedPublicClaims: string[];
    unsupportedLiveCompetitorClaims: string[];
    unmeasuredLiveBaselines: string[];
  };
}

export interface CompetitiveInteropMappingDecision {
  sourceConcept: string;
  memoryConcept: string | null;
  decision: CompetitiveInteropDecisionKind;
  count: number;
  rationale: string;
}

export interface CompetitiveInteropArtifactReport {
  competitor: CompetitiveInteropCompetitor;
  artifactName: string;
  source: "checked-in";
  counts: {
    sourceNodes: number;
    sourceEdges: number;
    preservedConcepts: number;
    approximatedConcepts: number;
    droppedConcepts: number;
  };
  decisions: CompetitiveInteropMappingDecision[];
  caveats: string[];
}

export interface CompetitiveInteropReport {
  schemaVersion: "memory.reference_interop.v1";
  generatedAt: string;
  liveServices: "not-required";
  artifacts: CompetitiveInteropArtifactReport[];
  claimGuards: {
    fullParityClaimed: false;
    unsupportedClaims: string[];
  };
}

export interface CompetitiveInteropOptions {
  fixtures?: CompetitiveInteropArtifactFixture[];
  generatedAt?: string;
}
