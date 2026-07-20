import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyAttemptLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildAttemptLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseAttemptLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningAttempt, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeAttemptLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningAttemptPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { asGraphRecallResult, capsuleSourceFlag, collectRepeatedFlag, formatVectorRecallDiagnostic, printContextPackToon, printDashboardToon, printLegacyGraphRecall, printLegacyMarkdownRecall, printRecallToon, runAutocure, runCapsule, runClassify, runContextPack, runContextPackViewer, runDashboard, runFederate, runPreflight, runReadiness, runReadinessViewer, runReasoningReplay, runRecall, runRecommend, runSmartSearch, runSmartSearchViewer, runWhatif } from './recall.js';
import type { ContextPackToonEntry, DashboardToonSection, RecallToonItem } from './recall.js';
import { currentGitCommit, graphStateMetadata, printRoutingGuide, publicFindingDiagnostic, publicSafeRefusalMessage, routingAgentFlag, runAgentIntegrationStatus, runAgentIntegrationStatusViewer, runAsk, runCapabilities, runHandoff, runHandoffViewer, runLearningDebt, runLearningDebtViewer, runMemoryDecay, runMemoryDecayViewer, runMemoryLayers, runMemoryLayersViewer, runMemoryMergePass, runMemoryMergePassExecute, runMemoryMergePassUnmerge, runOnboardingMap, runOnboardingMapExport, runOnboardingMapViewer, runReferenceRadar, runRoutingGuide, runRoutingGuideViewer, runSession, runSessionEnd, runSessionShow, runSessionStart, runTidyReview, runTidyReviewAccept, runTidyReviewDismiss, runTidyReviewRefresh, runWorkbench, runWorkFrontier, runWorkFrontierViewer, runWorking } from './reports.js';
import type { OnboardingMapExportShape, PublicCodebaseMapMetadata } from './reports.js';
import { flagsForRegistryTransport, formatAssetBytes, operationNeedsGraphStore, printClaimCheck, registryCliOperationFor, repeatedFlags, runAssets, runAssetsViewer, runBackup, runClaimCheck, runDocs, runDocsBacklinks, runDocsBacklinksViewer, runDocsBundle, runDocsBundleViewer, runDocsCoverage, runDocsCoverageViewer, runDocsEvidencePack, runDocsEvidencePackViewer, runDocsRead, runDocsReferenceGraph, runDocsReferenceGraphViewer, runDocsRelated, runDocsRelatedViewer, runDocsRestore, runDocsSearchViewer, runHooks, runHooksCoverageViewer, runRegistryCliOperation, runServe } from './docs.js';
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
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runAttempt, runAttemptLearn, runAttemptLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

const MEMORY_CLI_FLAG_SCHEMA = {
  change: { kind: "value", type: "array", coerce: (raw: string) => raw },
  "changed-files": {
    kind: "value",
    type: "array",
    aliases: ["changed-file"] as string[],
    coerce: (raw: string) => raw,
  },
  citation: { kind: "value", type: "array", coerce: (raw: string) => raw },
  "privacy-note": { kind: "value", type: "array", coerce: (raw: string) => raw },
  tag: { kind: "value", type: "array", coerce: (raw: string) => raw },
} as const;

export async function main(): Promise<void> {
  const args = parseLooseArgs(process.argv.slice(2), MEMORY_CLI_FLAG_SCHEMA);
  if (args.command === "--version" || args.command === "-v" || args.command === "version" || args.flags.version === true || args.flags.v === true) {
    const info = readBuildInfo("memory");
    process.stdout.write(args.flags.json ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
    return;
  }
  const registryOperation = registryCliOperationFor(args.command, args.positional);
  if (
    registryOperation &&
    registryOperation.outputKind.kind === "viewer" &&
    (registryOperation.id !== "memory.dashboard" || stringFlag(args.flags, "out") !== undefined) &&
    args.flags.json !== true
  ) {
    return runRegistryCliOperation(registryOperation, args);
  }
  switch (args.command) {
    case "init":
      return runInit(args);
    case "store":
      return runStore(args);
    case "store-evidence":
      return runStoreEvidence(args);
    case "commit":
      return runCommit(args);
    case "inbox":
      return runInbox(args);
    case "evidence":
      return runEvidence(args);
    case "classify":
      return runClassify(args);
    case "recall":
      return runRecall(args);
    case "smart-search":
      return runSmartSearch(args);
    case "reasoning-replay":
      return runReasoningReplay(args);
    case "whatif":
      return runWhatif(args);
    case "federate":
      return runFederate(args);
    case "autocure":
      return runAutocure(args);
    case "smart-search-viewer":
      return runSmartSearchViewer(args);
    case "capsule":
      return runCapsule(args);
    case "context-pack":
      return runContextPack(args);
    case "context-pack-viewer":
      return runContextPackViewer(args);
    case "recommend":
      return runRecommend(args);
    case "claim-check":
      return runClaimCheck(args);
    case "preflight":
      return runPreflight(args);
    case "readiness":
      return runReadiness(args);
    case "readiness-viewer":
      return runReadinessViewer(args);
    case "capabilities":
      return runCapabilities(args);
    case "assets":
      return runAssets(args);
    case "assets-viewer":
      return runAssetsViewer(args);
    case "references-radar":
      return runReferenceRadar(args);
    case "layers":
      return runMemoryLayers(args);
    case "layers-viewer":
      return runMemoryLayersViewer(args);
    case "handoff":
      return runHandoff(args);
    case "handoff-viewer":
      return runHandoffViewer(args);
    case "frontier":
      return runWorkFrontier(args);
    case "frontier-viewer":
      return runWorkFrontierViewer(args);
    case "decay":
      return runMemoryDecay(args);
    case "decay-viewer":
      return runMemoryDecayViewer(args);
    case "merge-pass":
      return runMemoryMergePass(args);
    case "tidy-review":
      return runTidyReview(args);
    case "dashboard":
      return runDashboard(args);
    case "workbench":
      return runWorkbench(args);
    case "session":
      return runSession(args);
    case "working":
      return runWorking(args);
    case "learning-debt":
      return runLearningDebt(args);
    case "learning-debt-viewer":
      return runLearningDebtViewer(args);
    case "onboarding-map":
      return runOnboardingMap(args);
    case "onboarding-map-viewer":
      return runOnboardingMapViewer(args);
    case "routing-guide":
      return runRoutingGuide(args);
    case "routing-guide-viewer":
      return runRoutingGuideViewer(args);
    case "integration-status":
      return runAgentIntegrationStatus(args);
    case "integration-status-viewer":
      return runAgentIntegrationStatusViewer(args);
    case "ask":
      return runAsk(args);
    case "docs":
      return runDocs(args);
    case "bootstrap":
      return runBootstrap(args);
    case "backup":
      return runBackup(args);
    case "serve":
      return runServe(args);
    case "provenance":
      return runProvenance(args);
    case "ingest":
      return runIngest(args);
    case "refresh":
      return runRefresh(args);
    case "event":
      return runSkillEvent(args);
    case "curate":
      return runCurate(args);
    case "improve":
      return runImprove(args);
    case "health":
      return runHealth(args);
    case "health-viewer":
      return runHealthViewer(args);
    case "recall-telemetry":
      return runRecallTelemetry(args);
    case "governance":
      return runGovernance(args);
    case "governance-viewer":
      return runGovernanceViewer(args);
    case "hooks":
      return runHooks(args);
    case "lint":
      return runLint(args);
    case "privacy":
      return runPrivacy(args);
    case "status":
      return runStatus(args);
    case "attempt":
      return runAttempt(args);
    case "extract":
      return runExtract(args);
    case "extraction":
      return runExtraction(args);
    case "map":
      return runMap(args);
    case "code-drift":
      return runCodeDrift(args);
    case "code-curate":
      return runCodeCurate(args);
    case "search":
      return runSearch(args);
    case "map-context":
      return runMapContext(args);
    case "neighbors":
      return runNeighbors(args);
    case "traverse":
      return runTraverse(args);
    case "path":
      return runPath(args);
    case "path-explain":
      return runPathExplain(args);
    case "path-explain-viewer":
      return runPathExplainViewer(args);
    case "confidence":
      return runConfidence(args);
    case "conflicts":
      return runConflicts(args);
    case "supersede":
      return runSupersede(args);
    case "resolve-conflict":
      return runResolveConflict(args);
    case "timeline":
      return runTimeline(args);
    case "communities":
      return runCommunities(args);
    case "communities-viewer":
      return runCommunitiesViewer(args);
    case "community-digest":
      return runCommunityDigest(args);
    case "hub-report":
      return runHubReport(args);
    case "suggested-questions":
      return runSuggestedQuestions(args);
    case "global-search":
      return runGlobalSearch(args);
    case "structural-impact":
      return runStructuralImpact(args);
    case "structural-impact-viewer":
      return runStructuralImpactViewer(args);
    case "pre-pr-review":
      return runPrePrReview(args);
    case "pre-pr-review-viewer":
      return runPrePrReviewViewer(args);
    case "vector":
      return runVector(args);
    case "stats":
      return runStats(args);
    case "doctor":
      return runDoctor(args);
    case "export":
    case "graph":
      return runExport(args);
    case "map-contract":
      if (!registryOperation) throw new Error("map-contract operation is not registered");
      return runRegistryCliOperation(registryOperation, args);
    case "architecture-overview":
      return runArchitectureOverview(args);
    case "hook":
      return runHook(args);
    case "vcs":
      return runVcs(args);
    case "drift-guard":
      return runDriftGuard(args);
    case "import":
      return runImport(args);
    case "promote":
      return runPromoteCmd(args);
    case "afk-finalize":
      return runAfkFinalize(args);
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return;
    default:
      throw new Error(`unknown command: ${args.command}\n\n${USAGE}`);
  }
}
