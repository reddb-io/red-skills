import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { asGraphRecallResult, capsuleSourceFlag, formatVectorRecallDiagnostic, printContextPackToon, printDashboardToon, printLegacyGraphRecall, printLegacyMarkdownRecall, printRecallToon, runAutocure, runCapsule, runClassify, runContextPack, runContextPackViewer, runDashboard, runFederate, runPreflight, runReadiness, runReadinessViewer, runReasoningReplay, runRecall, runRecommend, runSmartSearch, runSmartSearchViewer, runWhatif } from './recall.js';
import type { ContextPackToonEntry, DashboardToonSection, RecallToonItem } from './recall.js';
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

export async function runWorkbench(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const workbench = await buildMemoryWorkbench(store, rootDir, {
      staleDays: intFlag(args.flags, "stale-days"),
      sessionId: stringFlag(args.flags, "session"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(workbench, null, 2));
      return;
    }
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/workbench.html"),
    );
    const artifact = buildMemoryWorkbenchArtifact(workbench);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: workbench written ${outPath}`);
    console.log(`  state: ${workbench.dashboard.state}`);
    console.log(`  contract: ${artifact.contract.consumes.join(", ")}`);
  } finally {
    await store.close();
  }
}

export async function runCapabilities(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const catalog = await buildMemoryCapabilityCatalog(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }
    console.log(
      `memory capabilities: ${catalog.summary.ready}/${catalog.summary.total} ready, ${catalog.summary.red_db_backed} RedDB-backed`,
    );
    for (const item of catalog.capabilities) {
      console.log(`  ${item.category}/${item.id}: ${item.status}`);
      if (item.cli.length > 0) console.log(`      cli: ${item.cli.join(", ")}`);
      if (item.mcp.length > 0) console.log(`      mcp: ${item.mcp.join(", ")}`);
    }
  } finally {
    await store.close();
  }
}

export async function runReferenceRadar(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const radar = await buildMemoryReferenceRadar(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(radar, null, 2));
      return;
    }
    console.log(
      `memory references radar: ${radar.summary.references} reference(s), ${radar.summary.degraded_or_not_configured} gap signal(s)`,
    );
    console.log(`  note: ${radar.note}`);
    for (const reference of radar.references) {
      console.log(
        `  ${reference.repository}: ${reference.posture} score=${reference.score.toFixed(3)} capabilities=${reference.relevant_capabilities}`,
      );
      for (const gap of reference.gaps) {
        console.log(`      gap: ${gap.capability_id} (${gap.status}) -> ${gap.next_action}`);
      }
    }
  } finally {
    await store.close();
  }
}

export async function runMemoryLayers(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryLayersReport(store);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory layers: ${report.summary.ready_layers}/${report.summary.total_layers} ready, ${report.summary.red_db_backed_layers} RedDB-backed`,
    );
    for (const layer of report.layers) {
      console.log(`  ${layer.id}: ${layer.status}`);
      const counts = Object.entries(layer.counts)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      if (counts) console.log(`      ${counts}`);
    }
  } finally {
    await store.close();
  }
}

export async function runMemoryLayersViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/layers-viewer.html"),
    );
    const report = await buildMemoryLayersReport(store);
    const artifact = buildMemoryLayersViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: layers viewer written ${outPath}`);
    console.log(
      `  ready: ${report.summary.ready_layers}/${report.summary.total_layers}`,
    );
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runHandoff(args: ParsedArgs): Promise<void> {
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryHandoff(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(report.markdown);
  } finally {
    await store.close();
  }
}

export async function runHandoffViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryHandoff(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildMemoryHandoffViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/handoff-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: handoff viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runWorkFrontier(args: ParsedArgs): Promise<void> {
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWorkFrontier(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(report.markdown);
  } finally {
    await store.close();
  }
}

export async function runWorkFrontierViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWorkFrontier(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildWorkFrontierViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/work-frontier.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: work frontier viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runMemoryDecay(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryDecayReport(store, {
      stale_days: intFlag(args.flags, "stale-days"),
      deprecate_days: intFlag(args.flags, "deprecate-days"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(report.markdown);
  } finally {
    await store.close();
  }
}

export async function runMemoryDecayViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryDecayReport(store, {
      stale_days: intFlag(args.flags, "stale-days"),
      deprecate_days: intFlag(args.flags, "deprecate-days"),
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildMemoryDecayViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/decay.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: decay viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runMemoryMergePass(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "execute") return runMemoryMergePassExecute(args);
  if (action === "unmerge") return runMemoryMergePassUnmerge(args);
  if (action && action !== "report") {
    throw new Error(
      "memory merge-pass action must be one of: report, execute, unmerge",
    );
  }

  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryMergePassReport(store, {
      min_score: numberFlag(args.flags, "min-score"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(report.markdown);
  } finally {
    await store.close();
  }
}

export async function runMemoryMergePassExecute(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory merge-pass execute requires explicit --yes approval");
  }
  const { store } = await openGraphStore(args);
  try {
    const result = await executeMemoryMergeBatch(store, {
      candidate_ranks: commaIntegerFlag(args.flags, "candidate-ranks"),
      approver: stringFlag(args.flags, "approver") ?? "",
      batch_id: stringFlag(args.flags, "batch-id"),
      reason: stringFlag(args.flags, "reason"),
      min_score: numberFlag(args.flags, "min-score"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory merge-pass execute: batch ${result.batch_id} merged ${result.summary.merged}/${result.summary.requested} candidate(s)`,
    );
    for (const edge of result.merged_edges) {
      console.log(
        `  ${edge.label} memory_nodes:${edge.duplicate_rid} -> memory_nodes:${edge.canonical_rid} rank=${edge.candidate_rank} score=${edge.score.toFixed(4)}`,
      );
    }
  } finally {
    await store.close();
  }
}

export async function runMemoryMergePassUnmerge(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory merge-pass unmerge requires explicit --yes approval");
  }
  const { store } = await openGraphStore(args);
  try {
    const result = await unmergeMemoryMergeBatch(
      store,
      stringFlag(args.flags, "batch-id") ?? "",
    );
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory merge-pass unmerge: batch ${result.batch_id} removed ${result.summary.removed}/${result.summary.found} edge(s)`,
    );
    for (const edge of result.removed_edges) {
      console.log(
        `  ${edge.removed ? "removed" : "missing"} ${edge.label} memory_nodes:${edge.duplicate_rid} -> memory_nodes:${edge.canonical_rid}`,
      );
    }
  } finally {
    await store.close();
  }
}

export async function runTidyReview(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "refresh") return runTidyReviewRefresh(args);
  if (action === "accept") return runTidyReviewAccept(args);
  if (action === "dismiss") return runTidyReviewDismiss(args);
  throw new Error("memory tidy-review action must be one of: refresh, accept, dismiss");
}

export async function runTidyReviewRefresh(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const result = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: config.provider,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory tidy-review refresh: ${result.summary.recommendations} open/current recommendation(s), ${result.summary.stale} stale`,
    );
    for (const artifact of result.artifacts) {
      console.log(`  ${artifact.status} ${artifact.artifact_id}`);
    }
    for (const artifact of result.stale_artifacts) {
      console.log(`  stale ${artifact.artifact_id}`);
    }
  } finally {
    await store.close();
  }
}

export async function runTidyReviewAccept(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory tidy-review accept requires explicit --yes approval");
  }
  const id = args.positional[1] ?? "";
  const { store } = await openGraphStore(args);
  try {
    const result = await acceptGovernanceTidyRecommendation(store, {
      id,
      approver: stringFlag(args.flags, "approver") ?? "",
      reason: stringFlag(args.flags, "reason"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory tidy-review accept: ${result.edge.label} memory_nodes:${result.edge.from_rid} -> memory_nodes:${result.edge.to_rid}`,
    );
    console.log(`  artifact: ${result.artifact_id}`);
  } finally {
    await store.close();
  }
}

export async function runTidyReviewDismiss(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory tidy-review dismiss requires explicit --yes approval");
  }
  const id = args.positional[1] ?? "";
  const { store } = await openGraphStore(args);
  try {
    const result = await dismissGovernanceTidyRecommendation(store, {
      id,
      approver: stringFlag(args.flags, "approver") ?? "",
      reason: stringFlag(args.flags, "reason"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`memory tidy-review dismiss: ${result.artifact_id}`);
  } finally {
    await store.close();
  }
}

export async function runSessionShow(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const id = await sessionCurrent(rootDir);
  if (args.flags.json === true) {
    console.log(JSON.stringify({ session_id: id }, null, 2));
    return;
  }
  console.log(id ?? "none");
}

export async function runSessionStart(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const explicit = stringFlag(args.flags, "id");
  const id = await sessionStart(rootDir, explicit ? { id: explicit } : {});
  if (args.flags.json === true) {
    console.log(JSON.stringify({ session_id: id }, null, 2));
    return;
  }
  console.log(`memory: session started — ${id}`);
}

export async function runSessionEnd(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  await sessionEnd(rootDir);
  if (args.flags.json === true) {
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }
  console.log("memory: session ended");
}

export async function runSession(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "show") return runSessionShow(args);
  if (action === "start") return runSessionStart(args);
  if (action === "end") return runSessionEnd(args);
  if (action !== "timeline" && action !== "timeline-viewer") {
    throw new Error(
      "session needs an action — supported: memory session show|start|end|timeline|timeline-viewer",
    );
  }
  const { store } = await openGraphStore(args);
  try {
    const timeline = await buildSessionTimeline(store, {
      sessionId: stringFlag(args.flags, "session"),
      limit: intFlag(args.flags, "limit"),
    });
    if (action === "timeline-viewer") {
      const rootDir = rootOf(args.flags);
      const outPath = resolve(
        stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/session-timeline.html"),
      );
      const artifact = buildSessionTimelineViewerArtifact(timeline);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, artifact.html, "utf8");
      console.log(`memory: session timeline viewer written ${outPath}`);
      console.log(`  events: ${timeline.summary.events}`);
      console.log(`  contract: ${artifact.contract.consumes}`);
      return;
    }
    if (args.flags.json === true) {
      console.log(JSON.stringify(timeline, null, 2));
      return;
    }
    const scope = timeline.filter.session_id ? ` for ${timeline.filter.session_id}` : "";
    console.log(`memory: session timeline${scope} — ${timeline.summary.events} event(s)`);
    for (const entry of timeline.entries) {
      console.log(
        `  ${entry.occurred_at} ${entry.session_id} ${entry.actor} ${entry.title} [${entry.outcome}]`,
      );
      if (entry.detail) console.log(`      ${entry.detail}`);
    }
    for (const action of timeline.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

export async function runWorking(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (
    action !== "append" &&
    action !== "get" &&
    action !== "raw" &&
    action !== "evict"
  ) {
    throw new Error(
      "working needs an action — supported: memory working append|get|raw|evict",
    );
  }
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    if (action === "append") {
      const type = stringFlag(args.flags, "type");
      const value = stringFlag(args.flags, "value");
      if (!type) throw new Error("working append requires --type <event-type>");
      if (value == null) throw new Error("working append requires --value <text>");
      const event = await workingAppendEvent(store, rootDir, { type, value });
      if (args.flags.json === true) {
        console.log(JSON.stringify(event, null, 2));
        return;
      }
      console.log(
        `memory: working append ok — session=${event.session_id} type=${event.type} seq=${event.sequence}`,
      );
      return;
    }
    if (action === "get") {
      const type = stringFlag(args.flags, "type");
      const events = await workingListEvents(store, rootDir, type ? { type } : {});
      if (args.flags.json === true) {
        console.log(JSON.stringify({ events }, null, 2));
        return;
      }
      const scope = type ? ` type=${type}` : "";
      console.log(`memory: working get${scope} — ${events.length} event(s)`);
      for (const e of events) {
        console.log(`  #${e.sequence} ${new Date(e.created_at).toISOString()} ${e.type}  ${e.value}`);
      }
      return;
    }
    if (action === "evict") {
      const config = await readConfig(rootDir);
      const defaults = resolveL2Policy(config);
      const ttlMs = intFlag(args.flags, "ttl-ms") ?? defaults.ttlMs;
      const byteBudget = intFlag(args.flags, "byte-budget") ?? defaults.byteBudget;
      const report = await evictL2(store, { ttlMs, byteBudget });
      if (args.flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `memory: working evict — scanned=${report.scanned_nodes} evicted=${report.evicted.length} (ttl_ms=${ttlMs} byte_budget=${byteBudget})`,
      );
      for (const rec of report.evicted) {
        console.log(`  ${rec.reason}  rid=${rec.rid}  session=${rec.session_id}  ${rec.label}  bytes=${rec.bytes}`);
      }
      for (const s of report.by_session) {
        if (s.byte_budget_triggered) {
          console.log(
            `  session=${s.session_id}: ${s.bytes_before}B → ${s.bytes_after}B (${s.evicted} event(s) evicted by budget)`,
          );
        }
      }
      return;
    }
    // action === "raw"
    const setVal = stringFlag(args.flags, "set");
    if (setVal != null) {
      const result = await workingSetRaw(store, rootDir, setVal);
      if (args.flags.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `memory: working raw set — session=${result.session_id} bytes=${Buffer.byteLength(result.value, "utf8")}`,
      );
      return;
    }
    const got = await workingGetRaw(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(got, null, 2));
      return;
    }
    if (!got) {
      console.log("memory: working raw — (none)");
      return;
    }
    console.log(got.value);
  } finally {
    await store.close();
  }
}

export async function runLearningDebt(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `learning-debt needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await buildLearningDebtReport(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
      skillTelemetryEnabled: telemetryEnabled,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(report.markdown);
  } finally {
    await store.close();
  }
}

export async function runLearningDebtViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `learning-debt-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await buildLearningDebtReport(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
      skillTelemetryEnabled: telemetryEnabled,
    });
    const artifact = buildLearningDebtViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/learning-debt-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: learning debt viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runOnboardingMap(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  if (args.positional[0] === "export") {
    return runOnboardingMapExport(args, rootDir);
  }
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(map.markdown);
  } finally {
    await store.close();
  }
}

export async function runOnboardingMapViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const outPath =
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/onboarding-map-viewer.html");
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    const artifact = buildOnboardingMapViewerArtifact(map);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: onboarding map viewer written ${outPath}`);
    console.log(`  status: ${artifact.map.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runRoutingGuide(args: ParsedArgs): Promise<void> {
  const guide = buildMemoryRoutingGuide({ agent: routingAgentFlag(args.flags) });
  if (args.flags.json === true) {
    console.log(JSON.stringify(guide, null, 2));
    return;
  }
  printRoutingGuide(guide);
}

export async function runRoutingGuideViewer(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const guide = buildMemoryRoutingGuide({ agent: routingAgentFlag(args.flags) });
  const artifact = buildMemoryRoutingGuideViewerArtifact(guide);
  const outPath =
    stringFlag(args.flags, "out") ??
    join(rootDir, ".red/memory", `routing-guide-${guide.agent}.html`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  console.log(`memory: routing guide viewer written ${outPath}`);
  console.log(`  agent: ${guide.agent}`);
  console.log(`  contract: ${artifact.contract.consumes}`);
}

export async function runAgentIntegrationStatus(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await buildMemoryAgentIntegrationStatus(rootDir, {
    agent: routingAgentFlag(args.flags),
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`memory: agent integration status (${report.schema_version})`);
  console.log(
    `  ready=${report.summary.ready} partial=${report.summary.partial} missing=${report.summary.missing}`,
  );
  for (const agent of report.agents) {
    console.log(`  ${agent.agent}: ${agent.state} (${agent.target_files.map((file) => file.path).join(", ")})`);
  }
}

export async function runAgentIntegrationStatusViewer(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await buildMemoryAgentIntegrationStatus(rootDir, {
    agent: routingAgentFlag(args.flags),
  });
  const artifact = buildMemoryAgentIntegrationStatusViewerArtifact(report);
  const outPath =
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/agent-integration-status.html");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  console.log(`memory: agent integration status viewer written ${outPath}`);
  console.log(`  ready: ${report.summary.ready}/${report.summary.agents}`);
  console.log(`  contract: ${artifact.contract.consumes}`);
}

export function routingAgentFlag(flags: Record<string, string | boolean>): MemoryRoutingAgent | undefined {
  const value = stringFlag(flags, "agent");
  if (value == null) return undefined;
  if (
    value === "codex" ||
    value === "claude" ||
    value === "cursor" ||
    value === "gemini" ||
    value === "aider" ||
    value === "opencode" ||
    value === "generic"
  ) {
    return value;
  }
  throw new Error("routing-guide --agent must be codex, claude, cursor, gemini, aider, opencode, or generic");
}

export function printRoutingGuide(guide: MemoryRoutingGuide): void {
  console.log(`memory: routing guide (${guide.schemaVersion}, agent=${guide.agent})`);
  console.log(`target files: ${guide.targetFiles.join(", ")}`);
  console.log("");
  process.stdout.write(guide.installSnippet);
}

export interface PublicCodebaseMapMetadata {
  schemaVersion: 1;
  kind: "memory.codebase-map.public-export";
  publicSafe: true;
  generatedAt: string;
  source: {
    gitCommit: string | null;
    graphState: {
      nodes: number;
      edges: number;
      maxRid: number;
      fingerprint: string;
    };
  };
  privacy: {
    scanned: true;
    status: PrivacyReport["status"];
    findings: number;
    findingKinds: string[];
    redacted: boolean;
    strict: boolean;
    warnings: string[];
  };
  artifacts: {
    json: string;
    markdown: string;
  };
}

export async function runOnboardingMapExport(args: ParsedArgs, rootDir: string): Promise<void> {
  if (args.flags["public-safe"] !== true) {
    throw new Error(
      "onboarding-map export writes demo/comparison artifacts and requires --public-safe",
    );
  }

  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map export needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const target = args.positional[1] ?? ".red/memory/public-codebase-map";
  const outDir = isAbsolute(target) ? target : resolve(rootDir, target);
  const strict = args.flags.strict === true;
  const privacy = await scanPrivacy(resolve(rootDir));
  if (privacy.status !== "ok") {
    throw new Error(
      `public-safe export refused: privacy scan could not guarantee safe output (${privacy.warnings.join("; ") || privacy.status})`,
    );
  }
  if (strict && privacy.findings.length > 0) {
    throw new Error(publicSafeRefusalMessage(privacy.findings));
  }

  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    const safeMap = redactSensitiveValue(map) as OnboardingMapExportShape;
    const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
    const redacted = privacy.findings.length > 0;
    const artifacts = {
      jsonPath: join(outDir, "codebase-map.json"),
      markdownPath: join(outDir, "codebase-map.md"),
      metadataPath: join(outDir, "public-export-metadata.json"),
    };
    const metadata: PublicCodebaseMapMetadata = {
      schemaVersion: 1,
      kind: "memory.codebase-map.public-export",
      publicSafe: true,
      generatedAt: new Date().toISOString(),
      source: {
        gitCommit: await currentGitCommit(rootDir),
        graphState: graphStateMetadata(nodes, edges),
      },
      privacy: {
        scanned: true,
        status: privacy.status,
        findings: privacy.findings.length,
        findingKinds: [...new Set(privacy.findings.map((finding) => finding.kind))].sort(),
        redacted,
        strict,
        warnings: privacy.warnings,
      },
      artifacts: {
        json: "codebase-map.json",
        markdown: "codebase-map.md",
      },
    };

    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeFile(artifacts.jsonPath, `${JSON.stringify(safeMap, null, 2)}\n`, "utf8"),
      writeFile(artifacts.markdownPath, safeMap.markdown, "utf8"),
      writeFile(artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    ]);

    const payload = {
      publicSafe: true,
      redacted,
      privacy: {
        scanned: true,
        status: privacy.status,
        findings: privacy.findings.length,
        diagnostics: privacy.findings.map(publicFindingDiagnostic),
        warnings: privacy.warnings,
      },
      artifacts,
      metadata,
    };
    if (args.flags.json === true) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const evidenceItems =
      safeMap.summary.concepts +
      safeMap.summary.workflows +
      safeMap.summary.decisions +
      safeMap.summary.risks +
      safeMap.summary.validations;
    console.log(`memory: public-safe codebase map export — ${evidenceItems} evidence item(s)`);
    if (privacy.findings.length > 0) {
      console.log(`  warning: redacted ${privacy.findings.length} privacy finding(s)`);
      for (const finding of privacy.findings.slice(0, 10)) {
        const diagnostic = publicFindingDiagnostic(finding);
        console.log(`  - ${diagnostic.kind} ${diagnostic.location}: ${diagnostic.excerpt}`);
      }
    }
    console.log(`  json:     ${artifacts.jsonPath}`);
    console.log(`  markdown: ${artifacts.markdownPath}`);
    console.log(`  metadata: ${artifacts.metadataPath}`);
  } finally {
    await store.close();
  }
}

export type OnboardingMapExportShape = Awaited<ReturnType<typeof buildOnboardingMap>>;

export function publicSafeRefusalMessage(findings: PrivacyFinding[]): string {
  const lines = [
    `public-safe export refused: privacy scan found ${findings.length} sensitive-looking value(s); rerun without --strict to write redacted artifacts.`,
  ];
  for (const finding of findings.slice(0, 10)) {
    const diagnostic = publicFindingDiagnostic(finding);
    lines.push(`- ${diagnostic.kind} ${diagnostic.location}: ${diagnostic.excerpt}`);
  }
  if (findings.length > 10) lines.push(`- ... and ${findings.length - 10} more`);
  return lines.join("\n");
}

export function publicFindingDiagnostic(finding: PrivacyFinding): {
  kind: PrivacyFinding["kind"];
  location: string;
  excerpt: string;
} {
  return {
    kind: finding.kind,
    location: finding.location,
    excerpt: finding.excerpt,
  };
}

export async function currentGitCommit(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

export function graphStateMetadata(
  nodes: Array<{ rid: number; node_type: string }>,
  edges: Record<string, unknown>[],
): PublicCodebaseMapMetadata["source"]["graphState"] {
  const structural = {
    nodes: nodes
      .map((node) => ({ rid: node.rid, node_type: node.node_type }))
      .sort((a, b) => a.rid - b.rid),
    edges: edges
      .map((edge) => ({
        rid: Number(edge.rid ?? edge.red_entity_id ?? 0),
        label: String(edge.label ?? edge.LABEL ?? ""),
        from: Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM ?? 0),
        to: Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO ?? 0),
      }))
      .sort(
        (a, b) =>
          a.rid - b.rid || a.label.localeCompare(b.label) || a.from - b.from || a.to - b.to,
      ),
  };
  return {
    nodes: structural.nodes.length,
    edges: structural.edges.length,
    maxRid: Math.max(0, ...structural.nodes.map((node) => node.rid)),
    fingerprint: createHash("sha256").update(JSON.stringify(structural)).digest("hex"),
  };
}

export async function runAsk(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const question = args.positional.join(" ").trim();
  if (!question) throw new Error("nothing to ask — pass a question: memory ask <question>");
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `ask needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const result = await ask(store, question, { rootDir });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`memory ask: ${result.status}`);
    if (result.answer) console.log(result.answer);
    if (result.error) console.log(`provider: unavailable (${result.error})`);
    console.log(`citations: ${result.citations.length}`);
    for (const item of [...result.evidence.active, ...result.evidence.superseded]) {
      const source = item.source ? ` source=${item.source}` : "";
      console.log(
        `  ${item.citation} memory_nodes:${item.rid} ${item.title} (${item.confidence}, ${item.status}${source})`,
      );
    }
    if (result.evidence.contradictory.length > 0) {
      console.log(`contradictions: ${result.evidence.contradictory.length}`);
      for (const item of result.evidence.contradictory) {
        const state = item.resolved ? `resolved active=${item.activeRid}` : "unresolved";
        const reason = item.reason ? ` reason=${item.reason}` : "";
        console.log(`  ${item.from.citation} contradicts ${item.to.citation} (${state}${reason})`);
      }
    }
    console.log(`gap analysis: ${result.gap_analysis.status}`);
    console.log(`  ${result.gap_analysis.summary}`);
    for (const gap of result.gap_analysis.gaps) console.log(`  gap: ${gap}`);
    for (const action of result.gap_analysis.next_actions) console.log(`  next: ${action}`);
    if (result.what_i_dont_know.length > 0) {
      console.log(`what I don't know: ${result.what_i_dont_know.length}`);
      for (const item of result.what_i_dont_know) console.log(`  - ${item}`);
    }
    if (result.federation_hits.length > 0) {
      console.log(`federation hits: ${result.federation_hits.length}`);
      for (const hit of result.federation_hits) {
        console.log(
          `  ${hit.origin_repo}${hit.id ? `:${hit.id}` : ""} score=${hit.score} local=${hit.confidence_local} remote=${hit.confidence_remote}`,
        );
      }
    }
    if (result.cost) {
      console.log(
        `cost: ${result.cost.provider}/${result.cost.model} prompt=${result.cost.prompt_tokens} completion=${result.cost.completion_tokens} usd=${result.cost.cost_usd}`,
      );
    }
  } finally {
    await store.close();
  }
}
