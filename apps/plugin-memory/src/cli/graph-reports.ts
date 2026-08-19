import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { asGraphRecallResult, capsuleSourceFlag, formatVectorRecallDiagnostic, printContextPackToon, printDashboardToon, printLegacyGraphRecall, printLegacyMarkdownRecall, printRecallToon, runAutocure, runCapsule, runClassify, runContextPack, runContextPackViewer, runDashboard, runFederate, runPreflight, runReadiness, runReadinessViewer, runReasoningReplay, runRecall, runRecommend, runSmartSearch, runSmartSearchViewer, runWhatif } from './recall.js';
import type { ContextPackToonEntry, DashboardToonSection, RecallToonItem } from './recall.js';
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
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export async function runConfidence(args: ParsedArgs): Promise<void> {
  const nodeArg = stringFlag(args.flags, "node") ?? args.positional[0];
  if (!nodeArg) {
    throw new Error("pass a node rid: memory confidence --node <rid>");
  }
  const { store } = await openGraphStore(args);
  try {
    const report = await buildConfidenceReport(store, nodeArg);
    if (!report) {
      throw new Error(`memory: no node with rid=${nodeArg}`);
    }
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderConfidenceMarkdown(report));
  } finally {
    await store.close();
  }
}

export async function runConflicts(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const conflicts = await listContradictions(store, {
      includeResolved: args.flags["include-resolved"] === true,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify({ conflicts }, null, 2));
      return;
    }
    printConflicts(conflicts);
  } finally {
    await store.close();
  }
}

export async function runSupersede(args: ParsedArgs): Promise<void> {
  const [oldArg, newArg] = args.positional;
  if (!oldArg || !newArg) {
    throw new Error("pass two node rids: memory supersede <old-rid> <new-rid>");
  }
  const oldRid = parseRid(oldArg, "old-rid");
  const newRid = parseRid(newArg, "new-rid");
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const { store } = await openGraphStore(args);
  try {
    await resolveConflict(store, { activeRid: newRid, supersededRid: oldRid, reason });
    console.log(`memory: superseded ${oldRid} -> ${newRid}`);
    if (reason) console.log(`  reason: ${reason}`);
  } finally {
    await store.close();
  }
}

export async function runResolveConflict(args: ParsedArgs): Promise<void> {
  const activeArg = typeof args.flags.active === "string" ? args.flags.active : args.positional[0];
  const supersededArg =
    typeof args.flags.superseded === "string" ? args.flags.superseded : args.positional[1];
  if (!activeArg || !supersededArg) {
    throw new Error(
      "pass active and superseded rids: memory resolve-conflict <active-rid> <superseded-rid>",
    );
  }
  const activeRid = parseRid(activeArg, "active-rid");
  const supersededRid = parseRid(supersededArg, "superseded-rid");
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const { store } = await openGraphStore(args);
  try {
    await resolveConflict(store, { activeRid, supersededRid, reason });
    console.log(`memory: resolved conflict with active ${activeRid}; superseded ${supersededRid}`);
    if (reason) console.log(`  reason: ${reason}`);
  } finally {
    await store.close();
  }
}

export async function runTimeline(args: ParsedArgs): Promise<void> {
  const topic = args.positional.join(" ").trim();
  if (!topic) throw new Error("pass a topic or rid: memory timeline <topic|rid>");
  const { store } = await openGraphStore(args);
  try {
    const timeline = await supersessionTimeline(store, topic);
    if (args.flags.json === true) {
      console.log(JSON.stringify(timeline, null, 2));
      return;
    }
    printTimelineToon(timeline, { includeAudit: args.flags["include-audit"] === true });
  } finally {
    await store.close();
  }
}

export async function runCommunities(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation("memory.communities", { store }, {
      cache: args.flags["no-cache"] === true ? "off" : "read-write",
    })) as CommunityAnalyticsReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderCommunitiesToon(report));
  } finally {
    await store.close();
  }
}

export function renderCommunitiesToon(report: CommunityAnalyticsReport): string {
  return renderToonOutput({
    rowsKey: "communities",
    rows: report.communities.map((community) => ({
      id: community.id,
      label: community.short_label ?? community.id,
      count: community.count,
      cohesion_score: community.cohesion_score,
      internal_edge_weight: community.internal_edge_weight,
      external_edge_weight: community.external_edge_weight,
      labels: community.labels.join(","),
    })),
    fields: [
      "id",
      "label",
      "count",
      "cohesion_score",
      "internal_edge_weight",
      "external_edge_weight",
      "labels",
    ],
    extra: {
      bridge_nodes: report.bridge_nodes.slice(0, 20).map((node) => ({
        rid: node.rid,
        label: node.label,
        community_id: node.community_id,
        connected_community_count: node.connected_community_count,
        connected_community_ids: node.connected_community_ids.join(","),
        cross_community_edge_count: node.cross_community_edge_count,
        cross_community_weight: node.cross_community_weight,
      })),
      bridge_edges: report.bridge_edges.slice(0, 20).map((edge) => ({
        from_label: edge.from_label,
        to_label: edge.to_label,
        from_community_id: edge.from_community_id,
        to_community_id: edge.to_community_id,
        weight: edge.weight,
      })),
      graph: {
        hash: report.graph_hash,
        cache: report.cached ? "hit" : "miss",
        assignments: report.assignments.length,
        ranked_nodes: report.node_analytics.length,
        inter_community_edges: report.inter_community_edges.length,
      },
    },
    summary: {
      status: report.summary.status,
      next: report.summary.next,
    },
  });
}

export async function runCommunitiesViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/communities-viewer.html");
  const { store } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation("memory.communities", { store }, {
      cache: args.flags["no-cache"] === true ? "off" : "read-write",
    })) as CommunityAnalyticsReport;
    const artifact = buildCommunitiesViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: communities viewer written ${outPath}`);
    console.log(`  communities: ${artifact.report.communities.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runCommunityDigest(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation(
      "memory.community-digest",
      { store, providerConfig: config.provider },
      {
        cache: args.flags["no-cache"] === true ? "off" : "read-write",
      },
    )) as CommunityDigestReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory: ${report.community_count} community digest(s)`);
    console.log(`  graph hash: ${report.graph_hash}`);
    console.log(`  cache: ${report.cached ? "hit" : "miss"}`);
    console.log(
      `  provider: ${report.provider.status}${
        report.provider.error ? ` (${report.provider.error})` : ""
      }`,
    );
    for (const digest of report.digests) {
      console.log(`  ${digest.short_label ?? digest.community_id}: ${digest.size} node(s)`);
      console.log(`        community: ${digest.community_id}`);
      console.log(`        top label: ${digest.top_label}`);
      console.log(`        top type: ${digest.top_node_type}`);
      if (digest.top_engineering_code) {
        console.log(`        top code: ${digest.top_engineering_code}`);
      }
      if (digest.narrative_summary) {
        console.log(`        summary: ${digest.narrative_summary}`);
      }
    }
    console.log(
      `  labeling: generated ${report.summary.labeling.generated}, reused ${report.summary.labeling.reused}, estimated tokens ${report.summary.labeling.token_cost.total_tokens}`,
    );
  } finally {
    await store.close();
  }
}

export async function runHubReport(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const rankBy = parseHubRankBy(stringFlag(args.flags, "rank-by") ?? stringFlag(args.flags, "rank_by"));
    const report = (await executeReadOnlyMemoryOperation("memory.hub-report", { store }, {
      limit: intFlag(args.flags, "limit"),
      rank_by: rankBy,
    })) as HubReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderHubReportToon(report, { wide: args.flags.wide === true }));
  } finally {
    await store.close();
  }
}

export async function runSuggestedQuestions(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation(
      "memory.suggested-questions",
      { store, providerConfig: config.provider },
      {
        limit: intFlag(args.flags, "limit"),
      },
    )) as SuggestedQuestionsReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderSuggestedQuestionsToon(report));
  } finally {
    await store.close();
  }
}

export function parseHubRankBy(value: string | undefined): HubRankBy {
  if (value == null) return "total";
  if (value === "total" || value === "in" || value === "out") return value;
  throw new Error('--rank-by must be "total", "in", or "out"');
}

export function renderHubReportToon(report: HubReport, opts: { wide: boolean }): string {
  const fields: readonly (keyof HubReportRow & string)[] = opts.wide
    ? [
        "rid",
        "label",
        "title",
        "node_type",
        "community_id",
        "total_degree",
        "in_degree",
        "out_degree",
        "seal_mix",
        "seal_count",
        "seals",
      ]
    : ["label", "title", "community_id", "total_degree", "in_degree", "out_degree", "seal_mix"];
  const rows = report.hubs.map((hub) => ({ ...hub }));
  return renderToonOutput({
    rowsKey: "hubs",
    rows,
    fields,
    summary: report.summary.empty
      ? {
          state: "empty_graph",
          message: "No graph nodes found.",
          nodes: report.summary.nodes,
          edges: report.summary.edges,
          next: report.next,
        }
      : {
          rank_by: report.rank_by,
          reported: report.summary.reported,
          nodes: report.summary.nodes,
          edges: report.summary.edges,
          max_total_degree: report.summary.max_total_degree,
          communities: report.summary.communities,
          next: report.next,
        },
    extra: {
      schema_version: report.schema_version,
      graph_hash: report.graph_hash,
    },
  });
}

export function renderSuggestedQuestionsToon(report: SuggestedQuestionsReport): string {
  const rows: Array<Record<string, any>> = report.questions.map((question) => ({
    id: question.id,
    signal_type: question.signal_type,
    question: question.question,
    rationale: question.rationale,
    references: question.references.map((ref) => ({ ...ref })),
  }));
  return renderToonOutput({
    rowsKey: "questions",
    rows,
    fields: [
      "id",
      "signal_type",
      "question",
      "rationale",
      "references",
    ],
    summary: {
      status: report.summary.status,
      nodes: report.summary.nodes,
      edges: report.summary.edges,
      signals: report.summary.signals,
      questions: report.summary.questions,
      provider_status: report.provider.status,
      provider_error: report.provider.error ?? null,
      next: report.summary.next,
    },
    extra: {
      schema_version: report.schema_version,
      graph_hash: report.graph_hash,
      signals: report.signals.map((signal) => ({
        signal_id: signal.signal_id,
        signal_type: signal.signal_type,
        title: signal.title,
        score: signal.score,
        references: signal.references.map((ref) => ({ ...ref })),
      })),
    } as Record<string, any>,
  });
}

export function parseRid(value: string, name: string): number {
  const rid = Number(value);
  if (!Number.isInteger(rid) || rid <= 0) throw new Error(`${name} must be a positive integer`);
  return rid;
}

export function printConflicts(conflicts: ContradictionSummary[]): void {
  if (conflicts.length === 0) {
    console.log("memory: no unresolved contradictions");
    return;
  }
  console.log(`memory: ${conflicts.length} likely contradiction(s)`);
  for (const conflict of conflicts) {
    const status = conflict.resolved ? `resolved -> ${conflict.activeRid}` : "unresolved";
    console.log(
      `  [${status}] ${conflict.from.rid} ${conflict.from.label} <-> ${conflict.to.rid} ${conflict.to.label}`,
    );
    if (conflict.reason) console.log(`        ${conflict.reason}`);
  }
}

export function printTimeline(timeline: TopicTimeline, opts: { includeAudit: boolean }): void {
  if (timeline.entries.length === 0) {
    console.log(`memory: no timeline entries for "${timeline.topic}"`);
    return;
  }
  console.log(`memory: timeline for "${timeline.topic}"`);
  for (const entry of timeline.entries) {
    const marker = entry.status === "active" ? "active" : `superseded -> ${entry.activeRid}`;
    console.log(`  [${marker}] ${entry.rid} (${entry.nodeType}) ${entry.label}`);
    if (entry.content) console.log(`        ${entry.content.slice(0, 200)}`);
  }
  if (opts.includeAudit) {
    if (timeline.auditLinks.length === 0) {
      console.log("  audit: no contradiction or supersession links");
      return;
    }
    console.log("  audit:");
    for (const edge of timeline.auditLinks) {
      const reason = edge.reason ? ` - ${edge.reason}` : "";
      console.log(`    ${edge.label} ${edge.fromRid} -> ${edge.toRid}${reason}`);
    }
  }
}

export type TimelineToonEntry = {
  rid: number;
  status: string;
  activeRid: number;
  nodeType: string;
  label: string;
  title: string;
  content: string;
};

export function printTimelineToon(timeline: TopicTimeline, opts: { includeAudit: boolean }): void {
  const rows: TimelineToonEntry[] = timeline.entries.map((entry) => ({
    rid: entry.rid,
    status: entry.status,
    activeRid: entry.activeRid,
    nodeType: entry.nodeType,
    label: entry.label,
    title: entry.title,
    content: entry.content,
  }));
  const zero = rows.length === 0;
  console.log(
    renderToonOutput({
      rowsKey: "entries",
      rows,
      fields: ["rid", "status", "activeRid", "nodeType", "label", "title", "content"],
      summary: {
        status: zero ? "0 entries" : `${rows.length} entries`,
        topic: timeline.topic,
        entries: rows.length,
        active: rows.filter((entry) => entry.status === "active").length,
        superseded: rows.filter((entry) => entry.status === "superseded").length,
        auditLinks: timeline.auditLinks.length,
      },
      extra: {
        ...(opts.includeAudit
          ? {
              auditLinks: timeline.auditLinks.map((edge) => ({
                label: edge.label,
                fromRid: edge.fromRid,
                toRid: edge.toRid,
                reason: edge.reason,
              })),
            }
          : {}),
        ...(zero
          ? {
              next: "store or ingest topic evidence, then rerun `memory timeline <topic>`",
            }
          : {}),
      },
    }),
  );
}

export async function runStructuralImpact(args: ParsedArgs): Promise<void> {
  const target: StructuralImpactTarget = {
    file: typeof args.flags.file === "string" ? args.flags.file : undefined,
    symbol: typeof args.flags.symbol === "string" ? args.flags.symbol : undefined,
  };
  if (!target.file && !target.symbol) {
    throw new Error("pass --file <path>, --symbol <name>, or both");
  }
  const { store } = await openGraphStore(args);
  try {
    const impact = await structuralImpactReader(store)(target);
    printStructuralImpact(target, impact);
  } finally {
    await store.close();
  }
}

export async function runPrePrReview(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `pre-pr-review needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const comparison = stringFlag(args.flags, "range") ?? stringFlag(args.flags, "comparison");
  const changedFiles = await readChangedFiles(rootDir, comparison);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const review = await buildPrePrMemoryReview(store, { changedFiles, comparison });
    if (args.flags.json === true) {
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    printPrePrReview(review);
  } finally {
    await store.close();
  }
}

export async function runPrePrReviewViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `pre-pr-review-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const comparison = stringFlag(args.flags, "range") ?? stringFlag(args.flags, "comparison");
  const changedFiles = await readChangedFiles(rootDir, comparison);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/pre-pr-review-viewer.html"),
  );
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const review = await buildPrePrMemoryReview(store, { changedFiles, comparison });
    const artifact = buildPrePrReviewViewerArtifact(review);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: pre-PR review viewer written ${outPath}`);
    console.log(`  changed files: ${review.changedFiles.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runStructuralImpactViewer(args: ParsedArgs): Promise<void> {
  const target: StructuralImpactTarget = {
    file: typeof args.flags.file === "string" ? args.flags.file : undefined,
    symbol: typeof args.flags.symbol === "string" ? args.flags.symbol : undefined,
  };
  if (!target.file && !target.symbol) {
    throw new Error("pass --file <path>, --symbol <name>, or both");
  }
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/structural-impact-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const impact = await structuralImpactReader(store)(target);
    const artifact = buildStructuralImpactViewerArtifact(target, impact);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: structural impact viewer written ${outPath}`);
    console.log(`  target: ${target.file ?? ""}${target.symbol ? ` ${target.symbol}` : ""}`.trim());
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export function printStructuralImpact(target: StructuralImpactTarget, impact: StructuralImpact): void {
  const label = [target.file ? `file ${target.file}` : "", target.symbol ? `symbol ${target.symbol}` : ""]
    .filter(Boolean)
    .join(", ");
  const lines: string[] = [];

  for (const edge of impact.imports) {
    lines.push(`${edge.from.properties.title} imports ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.importedBy) {
    lines.push(`${edge.from.properties.title} imports this target through ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.calls) {
    lines.push(`${edge.from.properties.title} calls ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.calledBy) {
    lines.push(`${edge.from.properties.title} calls this target`);
  }
  for (const edge of impact.usesTypes) {
    lines.push(`${edge.from.properties.title} uses type ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.usedByTypes) {
    lines.push(`${edge.from.properties.title} uses this target as a type`);
  }
  for (const edge of impact.references) {
    lines.push(`${edge.from.properties.title} references ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.referencedBy) {
    lines.push(`${edge.from.properties.title} references this target`);
  }
  for (const node of impact.defines) {
    lines.push(`${impact.definedIn?.properties.title ?? target.file ?? "target file"} defines ${node.properties.title}`);
  }
  if (impact.definedIn && target.symbol) {
    lines.push(`${target.symbol} is defined in ${impact.definedIn.properties.title}`);
  }

  if (lines.length === 0) {
    console.log(`memory: no structural impact for ${label}`);
    return;
  }
  console.log(`memory: structural impact for ${label}`);
  for (const line of lines) console.log(`  ${line}`);
}

export async function readChangedFiles(rootDir: string, comparison?: string): Promise<string[]> {
  const args = comparison
    ? ["diff", "--name-only", "--diff-filter=ACMRTUXB", comparison, "--"]
    : ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"];
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return parseChangedFiles(stdout);
  } catch (err) {
    if (comparison) throw err;
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--"],
      { cwd: rootDir },
    );
    return parseChangedFiles(stdout);
  }
}

export function parseChangedFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function printPrePrReview(review: PrePrMemoryReview): void {
  const scope = review.comparison ? ` for ${review.comparison}` : "";
  console.log(`memory: pre-PR review${scope}`);
  if (review.changedFiles.length === 0) {
    console.log("changed files: no diff evidence");
  } else {
    console.log(`changed files: ${review.changedFiles.length}`);
    for (const file of review.changedFiles) console.log(`  ${file}`);
  }

  printPrePrSection("impacted concepts", review.impactedConcepts);
  printPrePrSection("related decisions", review.relatedDecisions);
  printPrePrSection("known failures", review.knownFailures);
  printPrePrSection("suggested validations", review.suggestedValidations);
  printPrePrSection("risks", review.risks);

  if (review.missingEvidence.length > 0) {
    console.log(`missing evidence: ${review.missingEvidence.join(", ")}`);
  }
  if (review.evidence.length > 0) {
    console.log("evidence:");
    for (const item of review.evidence) {
      const source = item.source ? ` source=${item.source}` : "";
      console.log(
        `  ${item.marker} ${item.urn} ${item.title} (${item.nodeType}, ${item.confidence}${source})`,
      );
    }
  }
}

export function printPrePrSection(title: string, section: PrePrReviewSection): void {
  console.log(`${title}:`);
  if (section.items.length === 0) {
    console.log("  missing evidence");
    return;
  }
  for (const item of section.items) {
    const citations = item.evidence.map((e) => e.marker).join(" ");
    console.log(`  - ${item.title} ${citations}`);
    console.log(`    ${item.summary}`);
  }
}

export function printReadinessEnvelope(envelope: MemoryReadinessEnvelope): void {
  console.log(`memory: readiness — ${envelope.status}`);
  console.log(`  goal: ${envelope.request.goal}`);
  console.log(
    `  evidence: ${envelope.retrieval.recall.active_evidence_count}/${envelope.retrieval.recall.evidence_count} active`,
  );
  console.log(
    `  vector: ${envelope.retrieval.vector.overall} (${envelope.retrieval.vector.ready}/${envelope.retrieval.vector.total} ready)`,
  );
  console.log(
    `  trust: provenance=${envelope.trust.provenance.nodes_with_provenance}/${envelope.trust.provenance.total_nodes} ` +
      `superseded=${envelope.trust.supersession.superseded_nodes} ` +
      `contradictions=${envelope.trust.contradictions.unresolved} ` +
      `privacy-findings=${envelope.trust.privacy.findings}`,
  );
  console.log(
    `  vcs: ${envelope.vcs.time_travel} (${envelope.vcs.collections
      .map((collection) => `${collection.name}:${collection.status}`)
      .join(", ")})`,
  );
  console.log(
    `  telemetry: ${envelope.operations.event_log.total_events} event(s) ` +
      `community-signals=${envelope.communities.communities}/${envelope.communities.assignments}`,
  );
  if (envelope.evidence.missing.missing) {
    console.log(
      `  missing evidence: ${envelope.evidence.missing.active_count}/${envelope.evidence.missing.expected_minimum} active`,
    );
    for (const message of envelope.evidence.missing.messages) console.log(`    ${message}`);
  }
  if (envelope.evidence.contradictions.length > 0) {
    console.log(`  contradictions: ${envelope.evidence.contradictions.length}`);
    for (const warning of envelope.evidence.contradictions) console.log(`    ${warning.message}`);
  }
  if (envelope.evidence.superseded.length > 0) {
    console.log(`  superseded evidence: ${envelope.evidence.superseded.length}`);
  }
  if (envelope.evidence.stale.length > 0) {
    console.log(`  stale evidence: ${envelope.evidence.stale.length}`);
  }
  if (envelope.skills.signal_status === "available" && envelope.skills.recommendations.length > 0) {
    console.log(
      `  skills: ${envelope.skills.recommendations.map((item) => item.name).join(", ")}`,
    );
  } else {
    console.log(`  skills: ${envelope.skills.status}`);
  }
  console.log(
    `  learning debt: ${envelope.learning_debt.status}` +
      (envelope.learning_debt.status === "available"
        ? ` (${envelope.learning_debt.debt_status})`
        : ""),
  );
  if (envelope.next_actions.length > 0) {
    console.log("  next actions:");
    for (const action of envelope.next_actions) console.log(`    - ${action}`);
  }
}
