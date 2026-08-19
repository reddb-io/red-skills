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
import { contextRecommendations, contextStatusReport, countMarkdownFiles, enabledHookNames, entryLooksLikeCache, exists, formatOutcomes, graphFreshnessStatus, healthRecommendations, healthReport, healthState, newestMtimeMs, plural, printGovernance, printLintReport, printPrivacyReport, reportStatusState, runContextStatus, runGovernance, runGovernanceViewer, runHealth, runHealthViewer, runLint, runPrivacy, runRecallTelemetry, runStatus, scanProjectFreshness, shouldSkipFreshnessPath, skillEventFromFlags, storeExists, toPosix, yesNo } from './status.js';
import type { CheckName, ContextCheck } from './status.js';
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag, stringFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export interface SkillImprovementProposalSummary {
  skill: string;
  category: string;
  reason: string;
  skillPath: string;
  recentFailures: number;
  dominantErrorStage: string | null;
  dominantErrorClass: string | null;
  patchDrafted: boolean;
  score: number;
  priority: "high" | "medium" | "low";
  scoreReasons: string[];
  fingerprint: string;
  evidenceSource: string;
  evidenceRoute: string;
  dominantErrorPattern: string;
  telemetryWindow: string;
  cardStatus: SkillTelemetryEvidenceCardStatus;
  reusedExisting: boolean;
  path: string | null;
  written: boolean;
}

export interface SkillTelemetryEvidenceCardArtifact {
  id: string;
  contract: "memory.evidence-card.experimental.v1";
  kind: "skill_telemetry";
  skill: string;
  skillPath: string;
  status: SkillTelemetryEvidenceCardStatus;
  signalFingerprint: string;
  fingerprint: string;
  path: string;
  proposalPath: string;
  reusedExisting: boolean;
  written: boolean;
}

export interface SkillImprovementBuildResult {
  proposals: SkillImprovementProposalSummary[];
  evidenceCards: SkillTelemetryEvidenceCardArtifact[];
}

export async function buildSkillImprovementProposals(
  rootDir: string,
  recommendations: readonly {
    name: string;
    source_kind: string;
    category: string;
    reason: string;
    path: string;
    curatable: boolean;
  }[],
  rollups: readonly SkillRollup[],
  recentEvents: readonly SkillEventSummary[],
  writeProposal: boolean,
): Promise<SkillImprovementBuildResult> {
  const candidates = recommendations.filter((rec) => rec.curatable && rec.category === "frequently-failing");
  const proposals: SkillImprovementProposalSummary[] = [];
  const evidenceCards: SkillTelemetryEvidenceCardArtifact[] = [];
  const proposalDir = join(rootDir, ".red", "memory", "proposals");
  const evidenceCardDir = join(rootDir, ".red", "memory", "inbox", "evidence");
  if (writeProposal && candidates.length > 0) {
    await mkdir(proposalDir, { recursive: true });
    await mkdir(evidenceCardDir, { recursive: true });
  }

  const pendingProposals = writeProposal ? await listPendingProposalFiles(rootDir) : [];

  for (const rec of candidates) {
    const evidence = recentFailureEvidence(rec.name, recentEvents);
    const dominantErrorStage = topValues(evidence.map((event) => event.error_stage))[0] ?? null;
    const dominantErrorClass = topValues(evidence.map((event) => event.error_class))[0] ?? null;
    const dominantErrorCode = topValues(evidence.map((event) => event.error_code))[0] ?? null;
    const relSkillPath = isAbsolute(rec.path) ? toPosix(relative(rootDir, rec.path)) : rec.path;
    const evidenceSource = skillTelemetryEvidenceSource(rec.name, evidence);
    const evidenceRoute = skillTelemetryEvidenceRoute(rec.category, relSkillPath);
    const dominantErrorPattern = skillTelemetryDominantErrorPattern({
      dominantErrorStage,
      dominantErrorClass,
      dominantErrorCode,
    });
    const telemetryWindow = skillTelemetryWindow(evidence);
    const signalFingerprint = skillTelemetrySignalFingerprint({
      evidenceSource,
      evidenceRoute,
      dominantErrorPattern,
      telemetryWindow,
    });
    const fingerprint = proposalFingerprint({
      skill: rec.name,
      category: rec.category,
      skillPath: relSkillPath,
      dominantErrorStage,
      dominantErrorClass,
    });
    let proposalPath: string | null = null;
    let reusedExisting = false;
    if (writeProposal) {
      const existing = pendingProposals.find((proposal) => proposal.fingerprint === fingerprint);
      if (existing) {
        proposalPath = resolve(rootDir, existing.path);
        reusedExisting = true;
      } else {
        const file = `skill-improvement-${slugify(rec.name)}-${fingerprint.slice("sha256:".length, "sha256:".length + 12)}.md`;
        proposalPath = join(proposalDir, file);
      }
    }

    const reusableCard =
      writeProposal && proposalPath
        ? await findReusableSkillTelemetryEvidenceCard(rootDir, evidenceCardDir, signalFingerprint)
        : null;
    const cardlessBody = await renderSkillImprovementProposal(rootDir, rec, evidence, fingerprint, null);
    const patchDrafted = cardlessBody.includes("```json memory-skill-patch");
    const priority = computeProposalPriority({
      reason: rec.reason,
      recentFailures: evidence.length,
      dominantErrorStage,
      dominantErrorClass,
      patchDrafted,
    });
    const existingCardCount = writeProposal
      ? await countSkillTelemetryEvidenceCardsForSignal(evidenceCardDir, signalFingerprint)
      : 0;
    const cardRevision = reusableCard ? reusableCard.revision : existingCardCount;
    const card = buildSkillTelemetryEvidenceCard({
      rootDir,
      rec,
      rollup: rollups.find((r) => r.source_kind === rec.source_kind && r.name === rec.name && r.path === rec.path),
      evidence,
      dominantErrorStage,
      dominantErrorClass,
      proposalFingerprint: fingerprint,
      signalFingerprint,
      evidenceSource,
      evidenceRoute,
      dominantErrorPattern,
      telemetryWindow,
      cardRevision,
      reusableCard,
      priority,
    });
    if (writeProposal && proposalPath) {
      card.proposal.path = toPosix(relative(rootDir, proposalPath));
    }
    const body =
      writeProposal && proposalPath
        ? await renderSkillImprovementProposal(rootDir, rec, evidence, fingerprint, card)
        : cardlessBody;
    if (writeProposal && proposalPath) {
      const cardPath = join(evidenceCardDir, card.file);
      const cardReusedExisting = existsSync(cardPath);
      await writeFile(proposalPath, body, "utf8");
      await writeFile(cardPath, renderEvidenceCardYaml(card), "utf8");
      evidenceCards.push({
        id: card.id,
        contract: "memory.evidence-card.experimental.v1",
        kind: "skill_telemetry",
        skill: rec.name,
        skillPath: rec.path,
        status: card.status,
        signalFingerprint: card.signal_fingerprint,
        fingerprint: card.fingerprint,
        path: cardPath,
        proposalPath,
        reusedExisting: cardReusedExisting,
        written: true,
      });
    }
    proposals.push({
      skill: rec.name,
      category: rec.category,
      reason: rec.reason,
      skillPath: rec.path,
      recentFailures: evidence.length,
      dominantErrorStage,
      dominantErrorClass,
      patchDrafted,
      score: priority.score,
      priority: priority.priority,
      scoreReasons: priority.reasons,
      fingerprint,
      evidenceSource,
      evidenceRoute,
      dominantErrorPattern,
      telemetryWindow,
      cardStatus: card.status,
      reusedExisting,
      path: proposalPath,
      written: writeProposal,
    });
  }
  return {
    proposals: sortProposalSummaries(proposals),
    evidenceCards: evidenceCards.sort((a, b) => a.skill.localeCompare(b.skill) || a.path.localeCompare(b.path)),
  };
}

export type SkillTelemetryEvidenceCardStatus =
  | "captured"
  | "routed"
  | "proposed"
  | "approved"
  | "rejected"
  | "promoted"
  | "archived";

export interface ExistingSkillTelemetryEvidenceCardRef {
  file: string;
  id: string;
  fingerprint: string;
  status: SkillTelemetryEvidenceCardStatus;
  createdAt: string | null;
  proposalPath: string | null;
  revision: number;
  review: SkillTelemetryEvidenceCard["review"];
}

export async function countSkillTelemetryEvidenceCardsForSignal(
  evidenceCardDir: string,
  signalFingerprint: string,
): Promise<number> {
  return (await listSkillTelemetryEvidenceCardsForSignal(evidenceCardDir, signalFingerprint)).length;
}

export async function findReusableSkillTelemetryEvidenceCard(
  rootDir: string,
  evidenceCardDir: string,
  signalFingerprint: string,
): Promise<ExistingSkillTelemetryEvidenceCardRef | null> {
  const cards = await listSkillTelemetryEvidenceCardsForSignal(evidenceCardDir, signalFingerprint);
  for (const card of cards) {
    if (!isUnresolvedSkillTelemetryEvidenceCardStatus(card.status)) continue;
    if (skillTelemetryReviewHasHumanDecision(card.review)) continue;
    if (card.proposalPath && !existsSync(resolve(rootDir, card.proposalPath))) continue;
    return card;
  }
  return null;
}

export async function listSkillTelemetryEvidenceCardsForSignal(
  evidenceCardDir: string,
  signalFingerprint: string,
): Promise<ExistingSkillTelemetryEvidenceCardRef[]> {
  let entries;
  try {
    entries = await readdir(evidenceCardDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const signalLine = `signal_fingerprint: ${yamlScalar(signalFingerprint)}`;
  const cards: ExistingSkillTelemetryEvidenceCardRef[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const body = await readFile(join(evidenceCardDir, entry.name), "utf8");
    if (!body.includes('kind: "skill_telemetry"') || !body.includes(signalLine)) continue;
    const status = parseSkillTelemetryEvidenceCardStatus(firstTopLevelYamlScalarField(body, "status"));
    cards.push({
      file: entry.name,
      id: firstTopLevelYamlScalarField(body, "id") ?? "",
      fingerprint: firstTopLevelYamlScalarField(body, "fingerprint") ?? "",
      status,
      createdAt: firstTopLevelYamlScalarField(body, "created_at"),
      proposalPath: lastYamlScalarField(body, "path"),
      revision: Number(lastYamlScalarField(body, "revision") ?? "0") || 0,
      review: {
        reviewer: lastYamlScalarField(body, "reviewer"),
        reviewed_at: lastYamlScalarField(body, "reviewed_at"),
        decision: lastYamlScalarField(body, "decision"),
        notes: lastYamlScalarField(body, "notes"),
      },
    });
  }
  return cards.sort((a, b) => b.revision - a.revision || a.file.localeCompare(b.file));
}

export function firstTopLevelYamlScalarField(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(key)}:\\s*([^\\n]*)$`, "m"));
  if (!match) return null;
  return parseYamlScalar(match[1]);
}

export function lastYamlScalarField(body: string, key: string): string | null {
  const matches = [...body.matchAll(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*([^\\n]*)$`, "gm"))];
  const match = matches.at(-1);
  if (!match) return null;
  return parseYamlScalar(match[1]);
}

export function parseYamlScalar(value: string): string | null {
  const raw = value.trim();
  if (raw === "" || raw === "null") return null;
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw;
  }
}

export function parseSkillTelemetryEvidenceCardStatus(value: string | null): SkillTelemetryEvidenceCardStatus {
  if (
    value === "captured" ||
    value === "routed" ||
    value === "proposed" ||
    value === "approved" ||
    value === "rejected" ||
    value === "promoted" ||
    value === "archived"
  ) {
    return value;
  }
  return "proposed";
}

export function isUnresolvedSkillTelemetryEvidenceCardStatus(status: SkillTelemetryEvidenceCardStatus): boolean {
  return status === "captured" || status === "routed" || status === "proposed";
}

export function skillTelemetryReviewHasHumanDecision(review: SkillTelemetryEvidenceCard["review"]): boolean {
  return Boolean(review.reviewed_at || review.decision);
}

export function proposalFingerprint(input: {
  skill: string;
  category: string;
  skillPath: string;
  dominantErrorStage: string | null;
  dominantErrorClass: string | null;
}): string {
  const payload = JSON.stringify({
    skill: input.skill,
    category: input.category,
    skillPath: input.skillPath,
    dominantErrorStage: input.dominantErrorStage ?? "",
    dominantErrorClass: input.dominantErrorClass ?? "",
  });
  return `sha256:${createHash("sha256").update(payload).digest("hex")}`;
}

export function skillTelemetryEvidenceSource(skillName: string, evidence: readonly SkillEventSummary[]): string {
  const sourceKinds = topValues(evidence.map((event) => event.source_kind));
  return `skill-telemetry:${skillName}:${sourceKinds.length > 0 ? sourceKinds.join("+") : "unknown-source"}`;
}

export function skillTelemetryEvidenceRoute(category: string, skillPath: string): string {
  return `skill-improvement:${category}:${skillPath}`;
}

export function skillTelemetryDominantErrorPattern(input: {
  dominantErrorStage: string | null;
  dominantErrorClass: string | null;
  dominantErrorCode: string | null;
}): string {
  return [
    `stage=${input.dominantErrorStage ?? ""}`,
    `class=${input.dominantErrorClass ?? ""}`,
    `code=${input.dominantErrorCode ?? ""}`,
  ].join("|");
}

export function skillTelemetryWindow(evidence: readonly SkillEventSummary[]): string {
  const timestamps = evidence.map((event) => event.timestamp).filter(Boolean).sort();
  if (timestamps.length === 0) return "none";
  return `${timestamps[0]}..${timestamps[timestamps.length - 1]} count=${timestamps.length}`;
}

export function skillTelemetrySignalFingerprint(input: {
  evidenceSource: string;
  evidenceRoute: string;
  dominantErrorPattern: string;
  telemetryWindow: string;
}): string {
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        evidenceSource: input.evidenceSource,
        evidenceRoute: input.evidenceRoute,
        dominantErrorPattern: input.dominantErrorPattern,
        telemetryWindow: input.telemetryWindow,
      }),
    )
    .digest("hex")}`;
}

export interface SkillTelemetryEvidenceCard {
  contract: "memory.evidence-card.experimental.v1";
  id: string;
  kind: "skill_telemetry";
  status: SkillTelemetryEvidenceCardStatus;
  created_at: string;
  updated_at: string;
  signal_fingerprint: string;
  fingerprint: string;
  file: string;
  refresh: {
    evidence_source: string;
    evidence_route: string;
    dominant_error_pattern: string;
    telemetry_window: string;
    revision: number;
  };
  source: {
    kind: "skill_telemetry";
    source_kind: string;
    runner: string;
    skill: {
      name: string;
      path: string;
    };
    rollup_ref: string;
    recent_event_refs: string[];
  };
  signal: {
    category: string;
    reason: string;
    recent_failures: number;
    dominant_error_stage: string | null;
    dominant_error_class: string | null;
  };
  route: {
    kind: "skill_proposal";
    target_skill_name: string;
    target_skill_path: string;
    suggested_section_or_anchor: string;
    route_decision: "write_approval_gated_proposal";
    route_reason: string;
  };
  blast_radius: {
    axes: {
      external_audience: boolean;
      customer_commercial_security: boolean;
      shared_workflow_context: boolean;
    };
    derived_level: "medium";
    reason: string;
  };
  judge: {
    checklist: {
      source_refs_not_raw_dump: boolean;
      enough_recent_failures: boolean;
      privacy_posture_recorded: boolean;
      blast_radius_recorded: boolean;
      route_quality_recorded: boolean;
    };
    verdict: "proposal_ready";
    confidence: "high" | "medium";
    reason: string;
  };
  privacy: {
    redaction: "not_required";
    findings: string[];
  };
  review: {
    reviewer: string | null;
    reviewed_at: string | null;
    decision: string | null;
    notes: string | null;
  };
  proposal: {
    path: string;
    fingerprint: string;
  };
}

export function buildSkillTelemetryEvidenceCard(input: {
  rootDir: string;
  rec: { name: string; source_kind: string; category: string; reason: string; path: string };
  rollup?: SkillRollup;
  evidence: readonly SkillEventSummary[];
  dominantErrorStage: string | null;
  dominantErrorClass: string | null;
  proposalFingerprint: string;
  signalFingerprint: string;
  evidenceSource: string;
  evidenceRoute: string;
  dominantErrorPattern: string;
  telemetryWindow: string;
  cardRevision: number;
  reusableCard: ExistingSkillTelemetryEvidenceCardRef | null;
  priority: { score: number; priority: "high" | "medium" | "low"; reasons: string[] };
}): SkillTelemetryEvidenceCard {
  const relSkillPath = isAbsolute(input.rec.path)
    ? toPosix(relative(input.rootDir, input.rec.path))
    : input.rec.path;
  const runner = topValues(input.evidence.map((event) => event.runner))[0] ?? "unknown";
  const recentEventRefs = input.evidence.map((event) => `skill-event:${event.event_id}`);
  const fingerprint =
    input.reusableCard?.fingerprint ||
    `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        contract: "memory.evidence-card.experimental.v1",
        signalFingerprint: input.signalFingerprint,
        cardRevision: input.cardRevision,
      }),
    )
    .digest("hex")}`;
  const short = fingerprint.slice("sha256:".length, "sha256:".length + 12);
  const id = input.reusableCard?.id || `skill-telemetry:${slugify(input.rec.name)}:${short}`;
  const now = new Date().toISOString();
  const rollupRef =
    input.rollup != null
      ? `skill-rollup:${contentHash(input.rollup.source_kind, input.rollup.name, input.rollup.path)}`
      : `skill-rollup:${contentHash(input.rec.source_kind, input.rec.name, input.rec.path)}`;

  const card: SkillTelemetryEvidenceCard = {
    contract: "memory.evidence-card.experimental.v1",
    id,
    kind: "skill_telemetry",
    status: "proposed",
    created_at: input.reusableCard?.createdAt || now,
    updated_at: now,
    signal_fingerprint: input.signalFingerprint,
    fingerprint,
    file: input.reusableCard?.file || `skill-telemetry-${slugify(input.rec.name)}-${short}.yaml`,
    refresh: {
      evidence_source: input.evidenceSource,
      evidence_route: input.evidenceRoute,
      dominant_error_pattern: input.dominantErrorPattern,
      telemetry_window: input.telemetryWindow,
      revision: input.cardRevision,
    },
    source: {
      kind: "skill_telemetry",
      source_kind: input.rec.source_kind,
      runner,
      skill: {
        name: input.rec.name,
        path: relSkillPath,
      },
      rollup_ref: rollupRef,
      recent_event_refs: recentEventRefs,
    },
    signal: {
      category: input.rec.category,
      reason: input.rec.reason,
      recent_failures: input.evidence.length,
      dominant_error_stage: input.dominantErrorStage,
      dominant_error_class: input.dominantErrorClass,
    },
    route: {
      kind: "skill_proposal",
      target_skill_name: input.rec.name,
      target_skill_path: relSkillPath,
      suggested_section_or_anchor: suggestedSectionOrAnchor(input.dominantErrorStage, input.dominantErrorClass),
      route_decision: "write_approval_gated_proposal",
      route_reason: `Repeated failing Skill telemetry should become a reviewed Skill improvement proposal for ${input.rec.name}.`,
    },
    blast_radius: {
      axes: {
        external_audience: false,
        customer_commercial_security: false,
        shared_workflow_context: true,
      },
      derived_level: "medium",
      reason:
        "The card routes to a Skill behavior proposal. It does not affect external users or customer/commercial/security behavior directly, but it can change shared agent workflow guidance after review.",
    },
    judge: {
      checklist: {
        source_refs_not_raw_dump: recentEventRefs.length > 0 && rollupRef.length > 0,
        enough_recent_failures: input.evidence.length >= 2,
        privacy_posture_recorded: true,
        blast_radius_recorded: true,
        route_quality_recorded: true,
      },
      verdict: "proposal_ready",
      confidence: input.priority.priority === "high" ? "high" : "medium",
      reason: `Telemetry supports a ${input.priority.priority}-priority approval-gated proposal: ${input.priority.reasons.join("; ")}.`,
    },
    privacy: {
      redaction: "not_required",
      findings: [],
    },
    review: input.reusableCard?.review || {
      reviewer: null,
      reviewed_at: null,
      decision: null,
      notes: null,
    },
    proposal: {
      path: "",
      fingerprint: input.proposalFingerprint,
    },
  };
  return redactSensitiveValue(card) as SkillTelemetryEvidenceCard;
}

export function suggestedSectionOrAnchor(
  dominantErrorStage: string | null,
  dominantErrorClass: string | null,
): string {
  if (dominantErrorStage) return `stage:${dominantErrorStage}`;
  if (dominantErrorClass) return `error_class:${dominantErrorClass}`;
  return "safe-tail-anchor";
}

export function renderEvidenceCardYaml(card: SkillTelemetryEvidenceCard): string {
  return `${yamlValue(card)}\n`;
}

export function yamlValue(value: unknown, indent = 0): string {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return value
      .map((item) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          const rendered = yamlValue(item, indent + 2);
          return `${pad}-\n${rendered}`;
        }
        return `${pad}- ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  if (isPlainObject(value)) {
    return Object.entries(value)
      .map(([key, item]) => {
        if (isPlainObject(item) || Array.isArray(item)) {
          const rendered = yamlValue(item, indent + 2);
          return `${pad}${key}:\n${rendered}`;
        }
        return `${pad}${key}: ${yamlScalar(item)}`;
      })
      .join("\n");
  }
  return `${pad}${yamlScalar(value)}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

export function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

export async function renderSkillImprovementProposal(
  rootDir: string,
  rec: { name: string; category: string; reason: string; path: string },
  evidence: SkillEventSummary[],
  fingerprint: string,
  evidenceCard: SkillTelemetryEvidenceCard | null,
): Promise<string> {
  const relSkillPath = isAbsolute(rec.path) ? toPosix(relative(rootDir, rec.path)) : rec.path;
  const evidenceBlock = evidenceCard ? "" : renderRecentFailureEvidence(evidence);
  const patchBlock = await renderDraftSkillPatchBlock(rootDir, rec, relSkillPath, evidence);
  const evidenceCardBlock = evidenceCard
    ? `\n## Evidence Card\n\n- Evidence card id: ${evidenceCard.id}\n- Evidence card path: ${toPosix(join(".red", "memory", "inbox", "evidence", evidenceCard.file))}\n`
    : "";
  return `# Skill Improvement Proposal: ${rec.name}

Status: approval-gated
Generated: ${new Date().toISOString()}
Fingerprint: ${fingerprint}

## Evidence

- Skill: ${rec.name}
- Category: ${rec.category}
- Reason: ${rec.reason}
- Skill path: ${relSkillPath}
${evidenceCardBlock}

## Hypothesis

Telemetry indicates this skill is repeatedly failing. The most likely root cause is missing prerequisite checks, ambiguous execution steps, incomplete verification guidance, or outdated tool instructions.
${evidenceBlock}
## Proposed Patch

Do not apply blindly. Review ${relSkillPath} and patch the smallest section that addresses the observed failure pattern.

Suggested patch targets:

1. Add or tighten prerequisite checks before the failure stage.
2. Add a troubleshooting note for the observed failure mode.
3. Add an explicit verification command or expected output.
4. Add a pitfall warning if the failure is caused by a common misuse.
${patchBlock}
## Validation Plan

1. Re-run the task or fixture that produced the failure.
2. Run any repo-specific metadata and skill validators.
3. Record a new Skill result event after validation.
4. Keep this proposal with the review notes, or delete it if rejected.

## Apply Policy

This proposal is intentionally approval-gated. The Memory plugin wrote this proposal file only; it did not patch, archive, delete, or rewrite the Skill.
`;
}

export function recentFailureEvidence(skillName: string, events: readonly SkillEventSummary[]): SkillEventSummary[] {
  return events
    .filter((event) => event.name === skillName && event.event_type === "result" && event.status === "failed")
    .slice(0, 5);
}

export function renderRecentFailureEvidence(evidence: readonly SkillEventSummary[]): string {
  if (evidence.length === 0) return "";
  const lines = evidence.map((event) => {
    const details = [
      event.error_stage ? `error_stage=${event.error_stage}` : null,
      event.error_class ? `error_class=${event.error_class}` : null,
      event.error_code ? `error_code=${event.error_code}` : null,
    ].filter(Boolean);
    return `- ${event.timestamp} runner=${event.runner}${details.length > 0 ? ` ${details.join(" ")}` : ""}`;
  });
  return `\n## Recent Failure Evidence\n\n${lines.join("\n")}\n`;
}

export function semanticTroubleshootingNote(reason: string, evidence: readonly SkillEventSummary[]): string {
  const stages = topValues(evidence.map((event) => event.error_stage));
  const classes = topValues(evidence.map((event) => event.error_class));
  const stage = stages[0];
  const klass = classes[0];
  const guidance = stage
    ? `Add verification guidance for the \`${stage}\` stage, including the expected signal and the recovery step when it fails.`
    : "Add the smallest concrete prerequisite, pitfall, or verification guidance that prevents the repeated failure.";
  const klassLine = klass ? `\n- Dominant error class: ${klass}.` : "";
  return `\n\n## Telemetry troubleshooting note\n\n- Failure signal: ${reason}.${klassLine}\n- ${guidance}\n`;
}

export function topValues(values: readonly (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

export async function renderDraftSkillPatchBlock(
  rootDir: string,
  rec: { name: string; category: string; reason: string; path: string },
  relSkillPath: string,
  evidence: readonly SkillEventSummary[],
): Promise<string> {
  const targetPath = isAbsolute(rec.path) ? rec.path : resolve(rootDir, rec.path);
  try {
    assertInsideRoot(rootDir, targetPath, "patch target");
    const current = await readFile(targetPath, "utf8");
    const oldString = semanticSectionAnchor(current, evidence) ?? uniqueTailAnchor(current);
    if (!oldString) {
      return "\nNo structured patch block was generated because the skill file did not have a safe unique insertion anchor. Add a `json memory-skill-patch` block manually after review.\n";
    }
    const note = semanticTroubleshootingNote(rec.reason, evidence);
    const patch = {
      path: relSkillPath,
      oldString,
      newString: `${oldString}${note}`,
    };
    return `\nDraft structured patch block. Edit before applying if the generic note is not precise enough:\n\n\`\`\`json memory-skill-patch\n${JSON.stringify(patch, null, 2)}\n\`\`\`\n`;
  } catch (err) {
    return `\nNo structured patch block was generated because the skill file could not be read safely: ${err instanceof Error ? err.message : String(err)}. Add a \`json memory-skill-patch\` block manually after review.\n`;
  }
}

export function semanticSectionAnchor(text: string, evidence: readonly SkillEventSummary[]): string | null {
  const stage = topValues(evidence.map((event) => event.error_stage))[0];
  const klass = topValues(evidence.map((event) => event.error_class))[0];
  const headings = semanticHeadingCandidates(stage, klass);
  for (const heading of headings) {
    const section = markdownSectionByHeading(text, heading);
    if (section && countOccurrences(text, section) === 1) return section;
  }
  return null;
}

export function semanticHeadingCandidates(stage: string | undefined, klass: string | undefined): RegExp[] {
  const candidates: RegExp[] = [];
  const s = (stage ?? "").toLowerCase();
  const k = (klass ?? "").toLowerCase();
  if (s.includes("setup") || s.includes("prereq") || s.includes("init") || s.includes("install")) {
    candidates.push(/^(prerequisites?|setup|installation|initialization)$/i);
  }
  if (s.includes("verify") || s.includes("validat") || s.includes("test") || s.includes("check")) {
    candidates.push(/^(verification|validation|testing|tests?|quality gates?)$/i);
  }
  if (s.includes("execute") || s.includes("run") || s.includes("tool") || s.includes("command")) {
    candidates.push(/^(what-to-do|execution|usage|commands?|workflow|steps?)$/i);
  }
  if (s.includes("cleanup") || s.includes("rollback") || s.includes("recover")) {
    candidates.push(/^(cleanup|rollback|recovery|recovering)$/i);
  }
  if (k.includes("timeout") || k.includes("rate") || k.includes("lock") || k.includes("permission")) {
    candidates.push(/^(common pitfalls|pitfalls|troubleshooting|known issues|failure modes?)$/i);
  }
  candidates.push(/^(common pitfalls|pitfalls|troubleshooting)$/i);
  return candidates;
}

export function markdownSectionByHeading(text: string, headingPattern: RegExp): string | null {
  const lineMatches = [...text.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)];
  for (let i = 0; i < lineMatches.length; i++) {
    const match = lineMatches[i];
    const title = match[1]?.trim();
    if (!title || !headingPattern.test(title)) continue;
    const start = match.index ?? 0;
    const next = lineMatches[i + 1];
    const end = next?.index ?? text.replace(/\s+$/u, "").length;
    const section = text.slice(start, end).replace(/\s+$/u, "");
    return section.length > 0 ? section : null;
  }
  return null;
}

export function uniqueTailAnchor(text: string): string | null {
  const trimmed = text.replace(/\s+$/u, "");
  if (trimmed.length === 0) return null;
  const maxAnchorChars = 1200;
  const lines = trimmed.split("\n");
  for (let lineCount = 1; lineCount <= Math.min(lines.length, 40); lineCount++) {
    const candidate = lines.slice(-lineCount).join("\n");
    if (candidate.length > maxAnchorChars) break;
    if (countOccurrences(text, candidate) === 1) return candidate;
  }
  const tail = trimmed.slice(-maxAnchorChars);
  return countOccurrences(text, tail) === 1 ? tail : null;
}

export function reportImproveState(
  json: boolean,
  state: "uninitialized" | "no-op" | "unavailable",
  reason: string,
  proposals: SkillImprovementProposalSummary[],
): void {
  if (json) {
    console.log(JSON.stringify({ state, reason, proposals, evidenceCards: [] }, null, 2));
    return;
  }
  console.log(`memory: skill improvement — ${state}`);
  console.log(`  ${reason}`);
}
