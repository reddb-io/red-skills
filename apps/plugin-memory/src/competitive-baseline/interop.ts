import { competitiveInteropFixtures } from "../competitive-fixtures.js";
import type { CompetitiveInteropDecisionKind } from "../competitive-fixtures.js";
import type {
  CompetitiveInteropMappingDecision,
  CompetitiveInteropOptions,
  CompetitiveInteropReport,
} from "./types.js";

function decisionCount(
  decisions: CompetitiveInteropMappingDecision[],
  decision: CompetitiveInteropDecisionKind,
): number {
  return decisions
    .filter((item) => item.decision === decision)
    .reduce((sum, item) => sum + item.count, 0);
}

export function evaluateCompetitiveInteropReport(
  opts: CompetitiveInteropOptions = {},
): CompetitiveInteropReport {
  const fixtures = opts.fixtures ?? competitiveInteropFixtures;
  const artifacts = fixtures.map((fixture) => {
    const decisions = fixture.mapping.map((item) => ({ ...item }));
    return {
      competitor: fixture.competitor,
      artifactName: fixture.artifactName,
      source: fixture.source,
      counts: {
        sourceNodes: fixture.nodes.length,
        sourceEdges: fixture.edges.length,
        preservedConcepts: decisionCount(decisions, "preserved"),
        approximatedConcepts: decisionCount(decisions, "approximated"),
        droppedConcepts: decisionCount(decisions, "dropped"),
      },
      decisions,
      caveats: [...fixture.caveats],
    };
  });

  return {
    schemaVersion: "memory.reference_interop.v1",
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    liveServices: "not-required",
    artifacts,
    claimGuards: {
      fullParityClaimed: false,
      unsupportedClaims: [],
    },
  };
}

export function renderCompetitiveInteropJson(report: CompetitiveInteropReport): string {
  return `${JSON.stringify(
    {
      schema_version: report.schemaVersion,
      generated_at: report.generatedAt,
      live_services: report.liveServices,
      artifacts: report.artifacts.map((artifact) => ({
        competitor: artifact.competitor,
        artifact_name: artifact.artifactName,
        source: artifact.source,
        counts: artifact.counts,
        mapping_decisions: artifact.decisions.map((decision) => ({
          source_concept: decision.sourceConcept,
          memory_concept: decision.memoryConcept,
          decision: decision.decision,
          count: decision.count,
          rationale: decision.rationale,
        })),
        caveats: artifact.caveats,
      })),
      claim_guards: {
        full_parity_claimed: report.claimGuards.fullParityClaimed,
        unsupported_claims: report.claimGuards.unsupportedClaims,
      },
    },
    null,
    2,
  )}\n`;
}

export function renderCompetitiveInteropHuman(report: CompetitiveInteropReport): string {
  const lines = [
    "# Memory reference interop report",
    "",
    `Live services: ${report.liveServices}`,
    "Does not claim full Graphify or Neo4j parity; checked fixtures describe shape mapping only.",
  ];

  for (const artifact of report.artifacts) {
    lines.push(
      "",
      `## ${artifact.competitor}`,
      `Artifact: ${artifact.artifactName} (${artifact.source})`,
      `Counts: nodes=${artifact.counts.sourceNodes} edges=${artifact.counts.sourceEdges} preserved=${artifact.counts.preservedConcepts} approximated=${artifact.counts.approximatedConcepts} dropped=${artifact.counts.droppedConcepts}`,
      "",
      "Preserved",
    );
    for (const decision of artifact.decisions.filter((item) => item.decision === "preserved")) {
      lines.push(`- ${decision.sourceConcept} -> ${decision.memoryConcept}: ${decision.rationale}`);
    }
    lines.push("", "Approximated");
    for (const decision of artifact.decisions.filter((item) => item.decision === "approximated")) {
      lines.push(`- ${decision.sourceConcept} -> ${decision.memoryConcept}: ${decision.rationale}`);
    }
    lines.push("", "Dropped");
    for (const decision of artifact.decisions.filter((item) => item.decision === "dropped")) {
      lines.push(`- ${decision.sourceConcept}: ${decision.rationale}`);
    }
    if (artifact.caveats.length > 0) {
      lines.push("", `Caveats: ${artifact.caveats.join(" ")}`);
    }
  }

  lines.push("", "## Claim guards");
  if (report.claimGuards.unsupportedClaims.length === 0) {
    lines.push("No unsupported full-parity claims were asserted.");
  } else {
    lines.push(`Unsupported claims: ${report.claimGuards.unsupportedClaims.join(", ")}`);
  }

  return `${lines.join("\n")}\n`;
}
