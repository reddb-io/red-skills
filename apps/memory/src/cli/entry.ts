import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseFlags, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, routeCommand, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, UnknownCommandError, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CommandSpec, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, FlagSchema, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, RouterSchema, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
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
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

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

/**
 * Flags the binary itself answers, before any command. They are the binary's,
 * not a command's: a named command owns every flag that follows it, so
 * `memory recall "topic" --version` recalls rather than printing a version.
 */
const MEMORY_BINARY_FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  json: { kind: "boolean" },
} as const satisfies FlagSchema;

/**
 * Every command the binary routes. Registry-owned commands (the read-only
 * operation registry) are folded in at module load, so a registered operation
 * is routable without being restated here.
 */
const MEMORY_CLI_COMMANDS: Record<string, CommandSpec> = {
  ...Object.fromEntries(
    [...REGISTRY_CLI_OPERATIONS.keys()].map((command) => [command.split(" ")[0]!, {}]),
  ),
  ...Object.fromEntries(
    [
      "init", "store", "store-evidence", "commit", "inbox", "evidence", "classify", "recall",
      "smart-search", "reasoning-replay", "whatif", "federate", "autocure", "smart-search-viewer",
      "capsule", "context-pack-viewer", "recommend", "claim-check", "preflight", "readiness",
      "readiness-viewer", "capabilities", "assets", "assets-viewer", "references-radar", "layers",
      "layers-viewer", "handoff", "handoff-viewer", "frontier", "frontier-viewer", "decay",
      "decay-viewer", "merge-pass", "tidy-review", "workbench", "session", "working",
      "learning-debt", "learning-debt-viewer", "onboarding-map", "onboarding-map-viewer",
      "routing-guide", "routing-guide-viewer", "integration-status", "integration-status-viewer",
      "ask", "docs", "bootstrap", "backup", "serve", "provenance", "ingest", "refresh", "event",
      "curate", "improve", "health", "health-viewer", "recall-telemetry", "governance",
      "governance-viewer", "hooks", "lint", "privacy", "status", "worker", "extract", "extraction",
      "map", "code-drift", "code-curate", "search", "map-context", "neighbors", "traverse", "path",
      "path-explain", "path-explain-viewer", "confidence", "conflicts", "supersede",
      "resolve-conflict", "timeline", "communities", "communities-viewer", "community-digest",
      "global-search", "structural-impact", "structural-impact-viewer", "pre-pr-review",
      "pre-pr-review-viewer", "vector", "stats", "doctor", "architecture-overview", "hook", "vcs",
      "drift-guard", "import", "promote", "afk-finalize", "version",
    ].map((command) => [command, {}]),
  ),
  export: { aliases: ["graph"] },
  help: {},
};

/**
 * `help` is the default so a bare `memory` prints usage, and a typo'd command
 * errors instead of silently becoming one — the binary never guesses a verb.
 */
const MEMORY_CLI_ROUTER: RouterSchema<string> = {
  commands: MEMORY_CLI_COMMANDS,
  default: "help",
  keepArgvOnDefault: true,
  errorOnUnknownCommand: true,
};

function printVersion(json: boolean): void {
  const info = readBuildInfo("memory");
  process.stdout.write(json ? `${JSON.stringify(info)}\n` : `${renderVersion(info)}\n`);
}

/** Name the flag the caller actually typed, canonicalised through the contract. */
function unknownBinaryFlag(argv: readonly string[]): string | undefined {
  const { flags } = parseLooseArgs(["memory", ...argv], MEMORY_BINARY_FLAGS);
  const unknown = Object.keys(flags).find((name) => !(name in MEMORY_BINARY_FLAGS));
  if (unknown === undefined) return undefined;
  return unknown.length === 1 ? `-${unknown}` : `--${unknown}`;
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  let routed;
  try {
    routed = routeCommand(argv, MEMORY_CLI_ROUTER);
  } catch (error) {
    if (!(error instanceof UnknownCommandError)) throw error;
    throw new Error(`unknown command: ${error.token} — run \`memory help\` for the command list`);
  }
  const { command, args: routedArgs } = routed;
  if (command === "help" || command === "version") {
    // Answered before config, enablement, or any store: "which build is this?"
    // and "what can it do?" must stay answerable in a directory that never ran
    // `memory init`, which is exactly where they get asked.
    const { values } = parseFlags(routedArgs, MEMORY_BINARY_FLAGS);
    if (command === "version" || values.version === true) return printVersion(values.json === true);
    if (command === "help" && values.help !== true) {
      const unknown = unknownBinaryFlag(routedArgs);
      if (unknown !== undefined) {
        throw new Error(`unknown flag: ${unknown} — run \`memory help\` for usage`);
      }
    }
    console.log(USAGE);
    return;
  }
  const args = parseLooseArgs(argv, MEMORY_CLI_FLAG_SCHEMA);
  const registryOperation = registryCliOperationFor(args.command, args.positional);
  if (registryOperation) return runRegistryCliOperation(registryOperation, args);
  switch (command) {
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
    case "worker":
      return runWorker(args);
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
    // `graph` is routed here as an alias of `export` by the router.
    case "export":
      return runExport(args);
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
    default:
      // The router refuses an unknown command before dispatch; this catches a
      // command declared to the router but left without a handler.
      throw new Error(`unknown command: ${command}\n\n${USAGE}`);
  }
}
