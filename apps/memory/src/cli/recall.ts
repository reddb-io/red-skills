import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { currentGitCommit, graphStateMetadata, printRoutingGuide, publicFindingDiagnostic, publicSafeRefusalMessage, routingAgentFlag, runAgentIntegrationStatus, runAgentIntegrationStatusViewer, runAsk, runCapabilities, runHandoff, runHandoffViewer, runLearningDebt, runLearningDebtViewer, runMemoryDecay, runMemoryDecayViewer, runMemoryLayers, runMemoryLayersViewer, runMemoryMergePass, runMemoryMergePassExecute, runMemoryMergePassUnmerge, runOnboardingMap, runOnboardingMapExport, runOnboardingMapViewer, runReferenceRadar, runRoutingGuide, runRoutingGuideViewer, runSession, runSessionEnd, runSessionShow, runSessionStart, runTidyReview, runTidyReviewAccept, runTidyReviewDismiss, runTidyReviewRefresh, runWorkbench, runWorkFrontier, runWorkFrontierViewer, runWorking } from './reports.js';
import type { OnboardingMapExportShape, PublicCodebaseMapMetadata } from './reports.js';
import { flagsForRegistryTransport, formatAssetBytes, operationNeedsGraphStore, printClaimCheck, registryCliOperationFor, runAssets, runAssetsViewer, runBackup, runClaimCheck, runDocs, runDocsBacklinks, runDocsBacklinksViewer, runDocsBundle, runDocsBundleViewer, runDocsCoverage, runDocsCoverageViewer, runDocsEvidencePack, runDocsEvidencePackViewer, runDocsRead, runDocsReferenceGraph, runDocsReferenceGraphViewer, runDocsRelated, runDocsRelatedViewer, runDocsRestore, runDocsSearchViewer, runHooks, runHooksCoverageViewer, runRegistryCliOperation, runServe } from './docs.js';
import { driftGuardAuditLog, driftGuardChangedFiles, driftGuardHeadMessage, driftGuardRecordEvent, gitDiffPaths, readSkillCuratorReport, refreshPaths, runBootstrap, runCurate, runDriftGuard, runIngest, runRefresh, runSkillEvent, splitPathList } from './vcs-ingest.js';
import { assertInsideProposalTree, assertInsideRoot, countOccurrences, firstProposalField, isArchiveReason, listPendingProposalFiles, parseSkillPatchBlock, proposalRoot, runImprove, runImproveApply, runImproveProposals, runImproveProposalsArchive, runImproveProposalsList, runImproveProposalsShow, summarizeProposalFile } from './improve-commands.js';
import type { ProposalFileSummary, SkillPatchBlock } from './improve-commands.js';
import { buildSkillImprovementProposals, buildSkillTelemetryEvidenceCard, countSkillTelemetryEvidenceCardsForSignal, findReusableSkillTelemetryEvidenceCard, firstTopLevelYamlScalarField, isPlainObject, isUnresolvedSkillTelemetryEvidenceCardStatus, lastYamlScalarField, listSkillTelemetryEvidenceCardsForSignal, markdownSectionByHeading, parseSkillTelemetryEvidenceCardStatus, parseYamlScalar, proposalFingerprint, recentFailureEvidence, renderDraftSkillPatchBlock, renderEvidenceCardYaml, renderRecentFailureEvidence, renderSkillImprovementProposal, reportImproveState, semanticHeadingCandidates, semanticSectionAnchor, semanticTroubleshootingNote, skillTelemetryDominantErrorPattern, skillTelemetryEvidenceRoute, skillTelemetryEvidenceSource, skillTelemetryReviewHasHumanDecision, skillTelemetrySignalFingerprint, skillTelemetryWindow, suggestedSectionOrAnchor, topValues, uniqueTailAnchor, yamlScalar, yamlValue } from './improve-build.js';
import type { ExistingSkillTelemetryEvidenceCardRef, SkillImprovementBuildResult, SkillImprovementProposalSummary, SkillTelemetryEvidenceCard, SkillTelemetryEvidenceCardArtifact, SkillTelemetryEvidenceCardStatus } from './improve-build.js';
import { contextRecommendations, contextStatusReport, countMarkdownFiles, enabledHookNames, entryLooksLikeCache, exists, formatOutcomes, graphFreshnessStatus, healthRecommendations, healthReport, healthState, newestMtimeMs, plural, printGovernance, printLintReport, printPrivacyReport, reportStatusState, runContextStatus, runGovernance, runGovernanceViewer, runHealth, runHealthViewer, runLint, runPrivacy, runRecallTelemetry, runStatus, scanProjectFreshness, shouldSkipFreshnessPath, skillEventFromFlags, storeExists, toPosix, yesNo } from './status.js';
import type { CheckName, ContextCheck } from './status.js';
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag, stringFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export async function runClassify(args: ParsedArgs): Promise<void> {
  const candidate = args.positional.join(" ").trim();
  const result = classifyCandidateMemory(candidate);
  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory classify: ${result.kind}`);
  console.log(`  tier: ${result.recommendedTier}`);
  console.log(`  scope: ${result.recommendedScope}`);
  if (result.safetyWarnings.length > 0) {
    console.log(`  warnings: ${result.safetyWarnings.join("; ")}`);
  }
  console.log(`  ${result.explanation}`);
}

export async function runRecall(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to recall — pass a query: memory recall <query>");
  const config = await requireConfig(rootDir);
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : 10;
  const requestedLayer = parseLayerFlag(args.flags.layer);
  // Today only L3 is populated; explicit non-L3 requests return empty rather
  // than silently falling back to L3 (PRD #174 prepares the L1/L2 surfaces).
  const layerFiltersOut = requestedLayer != null && requestedLayer !== "L3";

  if (config.mode === "graph") {
    const asOf = stringFlag(args.flags, "as-of");
    if (!asOf && shouldUseResidentMemory(rootDir, config)) {
      try {
        const residentResult = await residentMemoryRequest(rootDir, config, "recall", {
          query,
          limit,
          includeSuperseded: args.flags["include-superseded"] === true,
          scope: scopeFlags(args.flags),
          ranking: config.recallRanking,
        });
        const { hits: rawHits, diagnostics } = asGraphRecallResult(residentResult);
        const hits = layerFiltersOut ? [] : rawHits;
        if (args.flags.json === true) {
          printLegacyGraphRecall(query, hits, diagnostics);
          return;
        }
        if (hits.length === 0) {
          printRecallToon({
            items: [],
            query,
            store: "graph",
            ranking: "hybrid-rrf",
            vector: diagnostics.vector,
          });
          return;
        }
        printRecallToon({
          items: hits.map((hit) => ({
            id: hit.id,
            score: hit.score,
            kind: hit.node_type,
            content: `${hit.label} ${hit.excerpt}`.trim(),
          })),
          query,
          store: "graph",
          ranking: "hybrid-rrf",
          vector: diagnostics.vector,
        });
        return;
      } catch {
        // Fail open: if the resident cannot start or answer, keep the legacy
        // embedded path so CLI calls and hooks do not break the agent turn.
      }
    }
    const store = asOf
      ? await HistoricalMemoryStore.open({ uri: resolveStoreUri(rootDir, config), ref: asOf })
      : await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const { hits: rawHits, diagnostics } = await graphRecallResult(store, query, limit, {
        includeSuperseded: args.flags["include-superseded"] === true,
        scope: scopeFlags(args.flags),
        now: asOf ? 0 : undefined,
        ranking: config.recallRanking,
      });
      const hits = layerFiltersOut ? [] : rawHits;
      if (args.flags.json === true) {
        printLegacyGraphRecall(query, hits, diagnostics);
        return;
      }
      if (hits.length === 0) {
        printRecallToon({
          items: [],
          query,
          store: "graph",
          ranking: "hybrid-rrf",
          vector: diagnostics.vector,
        });
        return;
      }
      printRecallToon({
        items: hits.map((hit) => ({
          id: hit.id,
          score: hit.score,
          kind: hit.node_type,
          content: `${hit.label} ${hit.excerpt}`.trim(),
        })),
        query,
        store: "graph",
        ranking: "hybrid-rrf",
        vector: diagnostics.vector,
      });
    } finally {
      await store.close();
    }
    return;
  }

  const hits = layerFiltersOut
    ? []
    : await recall(resolveNotesDir(rootDir, config), query, limit);
  if (args.flags.json === true) {
    printLegacyMarkdownRecall(query, hits);
    return;
  }
  if (hits.length === 0) {
    printRecallToon({
      items: [],
      query,
      store: "markdown",
      ranking: "term-count",
    });
    return;
  }
  printRecallToon({
    items: hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      kind: "note",
      content: hit.excerpt,
    })),
    query,
    store: "markdown",
    ranking: "term-count",
  });
}

export function asGraphRecallResult(value: unknown): GraphRecallResult {
  if (!value || typeof value !== "object" || !Array.isArray((value as { hits?: unknown }).hits)) {
    throw new Error("resident returned invalid memory recall result");
  }
  return value as GraphRecallResult;
}

export type RecallToonItem = {
  id: string;
  score: number;
  kind: string;
  content: string;
};

export function printRecallToon(opts: {
  items: RecallToonItem[];
  query: string;
  store: "markdown" | "graph";
  ranking: string;
  vector?: {
    status: "unavailable" | "available" | "contributed";
    candidates: number;
    contributed: number;
    reason?: string;
  };
}): void {
  const zero = opts.items.length === 0;
  console.log(
    renderToonOutput({
      rowsKey: "items",
      rows: opts.items,
      fields: ["id", "score", "kind", "content"],
      summary: {
        status: zero ? "0 results" : `${opts.items.length} results`,
        results: opts.items.length,
        query: opts.query,
        store: opts.store,
        ranking: opts.ranking,
        ...(opts.vector ? { vector: opts.vector } : {}),
      },
      extra: zero
        ? {
            next: 'try `memory store "..."` to add governed context, then rerun recall',
          }
        : {},
    }),
  );
}

export function printLegacyMarkdownRecall(query: string, hits: Array<{ id: string; score: number; excerpt: string }>): void {
  if (hits.length === 0) {
    console.log(`memory: no matches for "${query}"`);
    return;
  }
  console.log(`memory: ${hits.length} match(es) for "${query}"`);
  for (const hit of hits) {
    console.log(`  [${hit.score}] ${hit.id}`);
    console.log(`        ${hit.excerpt}`);
  }
}

export function printLegacyGraphRecall(
  query: string,
  hits: GraphRecallHit[],
  diagnostics: { vector: Parameters<typeof formatVectorRecallDiagnostic>[0] },
): void {
  if (hits.length === 0) {
    console.log(`memory: no matches for "${query}"`);
    console.log(`  ${formatVectorRecallDiagnostic(diagnostics.vector)}`);
    return;
  }
  console.log(`memory: ${hits.length} match(es) for "${query}"`);
  console.log(`  ${formatVectorRecallDiagnostic(diagnostics.vector)}`);
  for (const hit of hits) {
    console.log(`  [${hit.score}] ${hit.id} (${hit.node_type}) ${hit.label}`);
    console.log(`        ${hit.excerpt}`);
    for (const line of renderSignalProvenance(hit.signal_provenance)) {
      console.log(`        ${line}`);
    }
    if (hit.hooks && hit.hooks.length > 0) {
      const parts = hit.hooks.map((h) => `${h.lifecycle}=${h.exit_code}`);
      console.log(`        hooks: ${parts.join(", ")}`);
    }
    if (hit.superseded_by != null) {
      const window = [
        hit.valid_from != null ? `valid_from=${hit.valid_from}` : "",
        hit.valid_until != null ? `valid_until=${hit.valid_until}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `        lineage: superseded_by=memory_nodes:${hit.superseded_by}${window ? ` ${window}` : ""}`,
      );
    }
  }
}

export async function runFederate(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = (stringFlag(args.flags, "query") ?? args.positional.join(" ")).trim();
  if (!query) {
    throw new Error(
      'nothing to federate — pass --query "<topic>" or memory federate <topic>',
    );
  }
  const report = await buildFederationReport(rootDir, query, {
    limit: intFlag(args.flags, "limit"),
    perRootLimit: intFlag(args.flags, "per-root-limit"),
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `memory federate: "${report.query}" — ${report.results.length} hit(s) across ${report.roots_queried} root(s)`,
  );
  if (report.roots_queried === 0) {
    console.log("  no federation roots configured (.red/memory/federation.yaml)");
    return;
  }
  for (const root of report.roots) {
    const tag = root.status === "ok" ? `${root.hits} hit(s)` : root.status;
    console.log(`  root ${root.origin_repo}: ${tag}`);
  }
  for (const result of report.results) {
    console.log(`  [${result.score}] @${result.origin_repo} ${result.id}`);
    console.log(`        ${result.excerpt}`);
  }
}

export async function runAutocure(args: ParsedArgs): Promise<void> {
  const apply = args.flags.apply === true;
  const { store } = await openGraphStore(args);
  try {
    const report = await runAutoCure(store, {
      apply,
      staleDays: intFlag(args.flags, "stale-days"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const mode = report.dry_run ? "dry-run" : "apply";
    console.log(
      `memory autocure (${mode}): ${report.actions_proposed.length} proposed, ${report.actions_applied.length} applied, ${report.skipped_claim_guarded.length} skipped (claim-guarded)`,
    );
    console.log(
      `  entropy: ${report.entropy_before} -> ${report.entropy_after} (nodes=${report.totals.nodes}, edges=${report.totals.edges}, claim_guarded=${report.totals.claim_guarded})`,
    );
    for (const [kind, counts] of Object.entries(report.by_kind)) {
      if (counts.proposed === 0 && counts.applied === 0) continue;
      console.log(`  ${kind}: proposed=${counts.proposed} applied=${counts.applied}`);
    }
    for (const action of report.actions_proposed.slice(0, 10)) {
      const target = `${action.target.node_type}:${action.target.label}#${action.target.rid}`;
      const peer = action.with
        ? ` -> ${action.with.node_type}:${action.with.label}#${action.with.rid}`
        : "";
      console.log(`  [${action.kind}] ${target}${peer}`);
      console.log(`        ${action.reason}`);
    }
    if (report.skipped_claim_guarded.length > 0) {
      console.log("  claim-guarded (skipped):");
      for (const action of report.skipped_claim_guarded.slice(0, 10)) {
        console.log(`    ${action.kind} on #${action.target.rid}`);
      }
    }
    if (report.dry_run) {
      console.log("\nRe-run with --apply to mutate (claim-guarded nodes still skipped).");
    }
  } finally {
    await store.close();
  }
}

export async function runReasoningReplay(args: ParsedArgs): Promise<void> {
  const task = (stringFlag(args.flags, "task") ?? args.positional.join(" ")).trim();
  if (!task) {
    throw new Error(
      "nothing to replay — pass --task \"<descriptor>\" or memory reasoning-replay <descriptor>",
    );
  }
  const { store } = await openGraphStore(args);
  try {
    const report = await buildReasoningReplay(store, task, {
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory reasoning-replay: "${report.task}" — ${report.results.length}/${report.total_workers} attempt(s)`,
    );
    if (report.results.length === 0) {
      console.log("  no past attempts in the reasoning tier yet");
      return;
    }
    for (const result of report.results) {
      console.log(
        `  [${result.similarity.toFixed(4)}] ${result.worker_id}  ${result.when}`,
      );
      console.log(`        ${result.summary}`);
    }
  } finally {
    await store.close();
  }
}

export async function runWhatif(args: ParsedArgs): Promise<void> {
  const changeFlag = args.flags.change;
  const rawChanges =
    args.repeatedFlags?.change ?? (typeof changeFlag === "string" ? [changeFlag] : []);
  const positionalChanges = args.positional.filter((p) => p.length > 0);
  const sources = [...rawChanges, ...positionalChanges];
  if (sources.length === 0) {
    throw new Error(
      'nothing to evaluate — pass one or more --change "<descriptor>" or memory whatif "<descriptor>" ["<descriptor>" ...]',
    );
  }
  const changes: WhatifChange[] = sources.map(parseWhatifChange);
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWhatifReport(store, changes, {
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory whatif: ${report.changes.length} change(s) — breakage_likelihood ${report.breakage_likelihood.toFixed(3)} (self_confidence ${report.self_confidence.toFixed(2)})`,
    );
    console.log(
      `  affected: ${report.affected.files.length} file(s), ${report.affected.symbols.length} symbol(s), ${report.affected.tests.length} test(s)`,
    );
    for (const file of report.affected.files.slice(0, 8)) {
      console.log(`    file  ${file}`);
    }
    for (const symbol of report.affected.symbols.slice(0, 8)) {
      console.log(`    sym   ${symbol}`);
    }
    if (report.historical_attempts.length === 0) {
      console.log("  no similar past attempts in the reasoning tier");
    } else {
      console.log(`  historical attempts (${report.historical_attempts.length}):`);
      for (const attempt of report.historical_attempts) {
        console.log(
          `    [${attempt.similarity.toFixed(3)}] ${attempt.worker_id} (${attempt.outcome})  ${attempt.when}`,
        );
      }
    }
  } finally {
    await store.close();
  }
}

export async function runSmartSearch(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to search — pass a query: memory smart-search <query>");
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemorySmartSearch(store, query, {
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      recall: {
        scope: scopeFlags(args.flags),
        includeSuperseded: args.flags["include-superseded"] === true,
      },
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory smart-search: "${query}"`);
    console.log(
      `  recall=${report.summary.recall_hits} docs=${report.summary.doc_hits} vector=${report.summary.vector_hits} (${report.summary.vector_status})`,
    );
    for (const result of report.top_results.slice(0, 8)) {
      const ref = result.ref.path ?? result.ref.label ?? result.ref.rid ?? result.id;
      console.log(
        `  #${result.rank} ${result.kind} [${result.score.toFixed(3)}] ${ref} (${result.sources.join("+")})`,
      );
      console.log(`      ${result.excerpt}`);
    }
    for (const action of report.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

export async function runSmartSearchViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) {
    throw new Error("nothing to render — pass a query: memory smart-search-viewer <query>");
  }
  const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/smart-search-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemorySmartSearch(store, query, {
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      recall: {
        scope: scopeFlags(args.flags),
        includeSuperseded: args.flags["include-superseded"] === true,
      },
    });
    const artifact = buildMemorySmartSearchViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: smart-search viewer written ${outPath}`);
    console.log(`  results: ${report.top_results.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export function formatVectorRecallDiagnostic(d: {
  status: "unavailable" | "available" | "contributed";
  candidates: number;
  contributed: number;
  reason?: string;
}): string {
  if (d.status === "contributed") {
    return `vector retrieval contributed ${d.contributed} candidate(s)`;
  }
  if (d.status === "available") {
    return "vector retrieval available; 0 candidate(s) contributed";
  }
  const reason = d.reason ? `: ${d.reason}` : "";
  return `vector retrieval unavailable${reason}`;
}

export async function runContextPack(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to pack — pass a goal: memory context-pack <goal>");
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `context-pack needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const budgetChars =
    typeof args.flags.budget === "string" ? Number(args.flags.budget) : undefined;
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : undefined;
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const skillRollups = await readSkillRollups(store);
    const pack = await buildContextPack(store, goal, {
      budgetChars,
      limit,
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    await appendContextPackGenerationEvent(store, {
      pack,
      surface: "cli",
      metadata: { command: "context-pack", json: args.flags.json === true },
    });
    // Recall telemetry from a real run (#828): additive, never blocks the pack.
    await appendRecallObservationEvent(
      store,
      recallObservationFromContextPack(pack, { surface: "context-pack" }),
    );
    if (args.flags.json === true) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }
    printContextPackToon(pack);
  } finally {
    await store.close();
  }
}

export type ContextPackToonEntry = {
  section: string;
  title: string;
  nodeType: string;
  importance: number;
  confidence: string;
  trust: number;
  citation: string;
  reason: string;
  excerpt: string;
  expandHandle: string;
};

export function printContextPackToon(pack: ContextPack): void {
  const rows: ContextPackToonEntry[] = pack.entries.map((entry) => ({
    section: entry.section,
    title: entry.title,
    nodeType: entry.nodeType,
    importance: entry.importance,
    confidence: entry.confidence,
    trust: entry.trust,
    citation: entry.citation.urn,
    reason: entry.reason,
    excerpt: entry.excerpt,
    expandHandle: entry.expandHandle,
  }));
  console.log(
    renderToonOutput({
      rowsKey: "entries",
      rows,
      fields: [
        "section",
        "title",
        "nodeType",
        "importance",
        "confidence",
        "trust",
        "citation",
        "reason",
        "excerpt",
        "expandHandle",
      ],
      summary: {
        status: pack.status,
        goal: pack.goal,
        entries: pack.entries.length,
        coreContext: pack.coreContext.length,
        warnings: pack.warnings.length,
        omittedEntries: pack.omittedEntries,
        budgetChars: pack.budgetChars,
        usedChars: pack.usedChars,
      },
      extra: {
        warnings: pack.warnings.map((warning) => ({
          kind: warning.kind,
          message: warning.message,
        })),
        ...(pack.entries.length === 0
          ? {
              next: 'run `memory store "..." --root <root>` or `memory ingest . --root <root>`, then rerun context-pack',
            }
          : {}),
      },
    }),
  );
}

export async function runCapsule(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to package — pass a goal: memory capsule <goal>");
  const { store } = await openGraphStore(args);
  try {
    const source = capsuleSourceFlag(args.flags);
    const skillRollups = source === "context-pack" ? await readSkillRollups(store) : [];
    const capsule = await buildMemoryCapsule(store, goal, {
      source,
      budgetChars: intFlag(args.flags, "budget"),
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(capsule, null, 2));
      return;
    }
    process.stdout.write(capsule.markdown);
  } finally {
    await store.close();
  }
}

export function capsuleSourceFlag(flags: ParsedArgs["flags"]): MemoryCapsuleSourceKind {
  const source = stringFlag(flags, "source") ?? "context-pack";
  if (source === "context-pack" || source === "handoff") return source;
  throw new Error(`invalid capsule source "${source}" — expected context-pack or handoff`);
}

export async function runContextPackViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const goal = args.positional.join(" ").trim();
  if (!goal) {
    throw new Error("nothing to inspect — pass a goal: memory context-pack-viewer <goal>");
  }
  const { store } = await openGraphStore(args);
  try {
    const skillRollups = await readSkillRollups(store);
    const pack = await buildContextPack(store, goal, {
      budgetChars: intFlag(args.flags, "budget"),
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    const artifact = buildContextPackViewerArtifact(pack);
    const safeName = slugify(goal).slice(0, 60) || "context-pack";
    const outPath = resolve(
      stringFlag(args.flags, "out") ??
        join(rootDir, `.red/memory/context-pack-${safeName}.html`),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    await appendContextPackGenerationEvent(store, {
      pack,
      surface: "cli-viewer",
      metadata: { command: "context-pack-viewer", out_path: outPath },
    });
    console.log(`memory: context pack viewer written ${outPath}`);
    console.log(`  status: ${pack.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runRecommend(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind !== "skills") {
    throw new Error("recommend needs a kind — supported: memory recommend skills <task>");
  }
  const task = args.positional.slice(1).join(" ").trim();
  if (!task) throw new Error("nothing to recommend — pass a task: memory recommend skills <task>");

  const { store } = await openGraphStore(args);
  try {
    const skillRollups = await readSkillRollups(store);
    const report = await buildSkillRecommendations(store, task, {
      limit: intFlag(args.flags, "limit"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory: skill recommendations for "${task}"`);
    process.stdout.write(renderSkillRecommendationsSection(report));
  } finally {
    await store.close();
  }
}

export async function runPreflight(args: ParsedArgs): Promise<void> {
  const task = args.positional.join(" ").trim();
  if (!task) throw new Error("nothing to brief — pass a task: memory preflight <task>");
  const { store } = await openGraphStore(args);
  try {
    const brief = await buildPreflightBrief(store, task, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(brief, null, 2));
      return;
    }
    process.stdout.write(brief.markdown);
  } finally {
    await store.close();
  }
}

export async function runReadiness(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to assess — pass a goal: memory readiness <goal>");
  const { store } = await openGraphStore(args);
  try {
    const envelope = await buildReadinessEnvelope(store, goal, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(envelope, null, 2));
      return;
    }
    printReadinessEnvelope(envelope);
  } finally {
    await store.close();
  }
}

export async function runReadinessViewer(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) {
    throw new Error("nothing to inspect — pass a goal: memory readiness-viewer <goal>");
  }
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/readiness-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const envelope = await buildReadinessEnvelope(store, goal, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    const artifact = buildReadinessViewerArtifact(envelope);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: readiness viewer written ${outPath}`);
    console.log(`  goal: ${envelope.request.goal}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDashboard(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const dashboard = await buildMemoryOperationalDashboard(store, rootDir, {
      staleDays: intFlag(args.flags, "stale-days"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(dashboard, null, 2));
      return;
    }
    const outFlag = stringFlag(args.flags, "out");
    if (outFlag !== undefined) {
      const outPath = resolve(outFlag);
      const artifact = buildMemoryOperationalDashboardArtifact(dashboard);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, artifact.html, "utf8");
      console.log(`memory: operational dashboard written ${outPath}`);
      console.log(`  state: ${dashboard.state}`);
      console.log(`  contract: ${artifact.contract.consumes}`);
      return;
    }
    printDashboardToon(dashboard);
  } finally {
    await store.close();
  }
}

export type DashboardToonSection = {
  area: string;
  status: string;
  metric: string;
  value: number;
  detail: string;
};

export function printDashboardToon(dashboard: MemoryOperationalDashboard): void {
  const sections: DashboardToonSection[] = [
    {
      area: "stats",
      status: dashboard.state,
      metric: "nodes",
      value: dashboard.stats.nodes,
      detail: `${dashboard.stats.docs} docs; ${dashboard.stats.edges} edges`,
    },
    {
      area: "vector",
      status: dashboard.vector.overall,
      metric: "ready",
      value: dashboard.vector.ready,
      detail: `${dashboard.vector.total} total; ${dashboard.vector.unavailable} unavailable; ${dashboard.vector.failed} failed`,
    },
    {
      area: "docs",
      status: dashboard.docs.ungrounded > 0 ? "attention" : "ready",
      metric: "grounded",
      value: dashboard.docs.grounded,
      detail: `${dashboard.docs.total} total; ${dashboard.docs.warnings} warning(s)`,
    },
    {
      area: "hooks",
      status: dashboard.hooks.actionable_gaps > 0 ? "attention" : "ready",
      metric: "wired_events",
      value: dashboard.hooks.wired_events,
      detail: `${dashboard.hooks.enabled_events} enabled; ${dashboard.hooks.actionable_gaps} actionable gap(s)`,
    },
    {
      area: "extraction",
      status: dashboard.extraction.inferred_available ? "ready" : "unavailable",
      metric: "inferred_facts",
      value: dashboard.extraction.inferred_facts,
      detail: dashboard.extraction.egress ?? "no inferred extraction egress",
    },
    {
      area: "stale",
      status: dashboard.stale.stale_nodes > 0 ? "attention" : "ready",
      metric: "stale_nodes",
      value: dashboard.stale.stale_nodes,
      detail: `${dashboard.stale.total_nodes} total; ${dashboard.stale.stale_days} day policy`,
    },
    {
      area: "decay",
      status: dashboard.decay.status,
      metric: "review",
      value: dashboard.decay.review,
      detail: `${dashboard.decay.keep} keep; ${dashboard.decay.deprecate} deprecate; ${dashboard.decay.expire} expire`,
    },
  ];
  const empty = dashboard.stats.nodes === 0 && dashboard.stats.docs === 0;
  console.log(
    renderToonOutput({
      rowsKey: "sections",
      rows: sections,
      fields: ["area", "status", "metric", "value", "detail"],
      summary: {
        status: empty ? "empty" : dashboard.state,
        state: dashboard.state,
        nodes: dashboard.stats.nodes,
        edges: dashboard.stats.edges,
        docs: dashboard.stats.docs,
        warnings: dashboard.warnings.length,
        actions: dashboard.recommended_next_actions.length + (empty ? 1 : 0),
        schema: dashboard.schema_version,
      },
      extra: {
        warnings: dashboard.warnings.map((message) => ({ message })),
        next: [
          ...dashboard.recommended_next_actions.map((action) => ({ action })),
          ...(empty
            ? [{ action: "run `memory ingest . --root <root>` to populate dashboard evidence" }]
            : []),
        ],
      },
    }),
  );
}
