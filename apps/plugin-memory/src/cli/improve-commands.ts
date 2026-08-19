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
import { buildSkillImprovementProposals, buildSkillTelemetryEvidenceCard, countSkillTelemetryEvidenceCardsForSignal, findReusableSkillTelemetryEvidenceCard, firstTopLevelYamlScalarField, isPlainObject, isUnresolvedSkillTelemetryEvidenceCardStatus, lastYamlScalarField, listSkillTelemetryEvidenceCardsForSignal, markdownSectionByHeading, parseSkillTelemetryEvidenceCardStatus, parseYamlScalar, proposalFingerprint, recentFailureEvidence, renderDraftSkillPatchBlock, renderEvidenceCardYaml, renderRecentFailureEvidence, renderSkillImprovementProposal, reportImproveState, semanticHeadingCandidates, semanticSectionAnchor, semanticTroubleshootingNote, skillTelemetryDominantErrorPattern, skillTelemetryEvidenceRoute, skillTelemetryEvidenceSource, skillTelemetryReviewHasHumanDecision, skillTelemetrySignalFingerprint, skillTelemetryWindow, suggestedSectionOrAnchor, topValues, uniqueTailAnchor, yamlScalar, yamlValue } from './improve-build.js';
import type { ExistingSkillTelemetryEvidenceCardRef, SkillImprovementBuildResult, SkillImprovementProposalSummary, SkillTelemetryEvidenceCard, SkillTelemetryEvidenceCardArtifact, SkillTelemetryEvidenceCardStatus } from './improve-build.js';
import { contextRecommendations, contextStatusReport, countMarkdownFiles, enabledHookNames, entryLooksLikeCache, exists, formatOutcomes, graphFreshnessStatus, healthRecommendations, healthReport, healthState, newestMtimeMs, plural, printGovernance, printLintReport, printPrivacyReport, reportStatusState, runContextStatus, runGovernance, runGovernanceViewer, runHealth, runHealthViewer, runLint, runPrivacy, runRecallTelemetry, runStatus, scanProjectFreshness, shouldSkipFreshnessPath, skillEventFromFlags, storeExists, toPosix, yesNo } from './status.js';
import type { CheckName, ContextCheck } from './status.js';
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag, stringFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export /**
 * memory improve skills — proposal-gated self-improvement surface.
 *
 * This is the first non-read-only step in the Skill self-improvement loop. It
 * still NEVER edits a skill directly. It reads Skill telemetry, turns supported
 * recommendations into concrete Markdown proposals, and writes those proposals
 * only when explicitly asked with --write-proposal. Applying a proposal remains a
 * separate human-reviewed action.
 */
async function runImprove(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind === "apply") return runImproveApply(args);
  if (kind === "proposals") return runImproveProposals(args);
  if (kind !== "skills") {
    throw new Error("improve needs a kind — supported: memory improve skills|proposals|apply");
  }

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const writeProposal = args.flags["write-proposal"] === true;
  const config = await readConfig(rootDir);
  if (!config) {
    return reportImproveState(json, "uninitialized", "memory is not initialized here", []);
  }
  if (config.mode !== "graph") {
    return reportImproveState(json, "no-op", `needs graph mode, this project is "${config.mode}"`, []);
  }
  if (!skillTelemetryEnabled(config)) {
    return reportImproveState(
      json,
      "unavailable",
      "skill telemetry is not enabled, re-run `memory init --mode graph --skill-telemetry`",
      [],
    );
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  let report;
  let recent: SkillEventSummary[];
  let rollups: SkillRollup[];
  try {
    rollups = await readSkillRollups(store);
    recent = await readRecentSkillEvents(store, 50);
    report = curateSkills(rollupsToCuratorInput(rollups), {
      staleDays: intFlag(args.flags, "stale-days"),
    });
  } finally {
    await store.close();
  }

  const { proposals, evidenceCards } = await buildSkillImprovementProposals(
    rootDir,
    report.recommendations,
    rollups,
    recent,
    writeProposal,
  );
  const state = proposals.length === 0 ? "no-candidates" : writeProposal ? "proposal-written" : "proposal-ready";

  if (json) {
    console.log(JSON.stringify({ state, proposals, evidenceCards }, null, 2));
    return;
  }

  console.log(`memory: skill improvement — ${state}`);
  if (proposals.length === 0) {
    console.log("  no proposal candidates found from current telemetry evidence");
    return;
  }
  for (const proposal of proposals) {
    console.log(`  ${proposal.skill}: ${proposal.category} — ${proposal.reason}`);
    if (proposal.path) console.log(`    proposal: ${proposal.path}`);
  }
  if (evidenceCards.length > 0) {
    console.log("\n  evidence cards:");
    for (const card of evidenceCards) console.log(`    ${card.skill}: ${card.path}`);
  }
  console.log("\nProposal-gated: skill files were not patched. Review and apply manually.");
}

export interface ProposalFileSummary {
  file: string;
  path: string;
  status: "pending" | "archived";
  skill: string | null;
  category: string | null;
  reason: string | null;
  skillPath: string | null;
  generated: string | null;
  fingerprint: string | null;
  bytes: number;
  mtimeMs: number;
}

export async function runImproveProposals(args: ParsedArgs): Promise<void> {
  const action = args.positional[1] ?? "list";
  switch (action) {
    case "list":
      return runImproveProposalsList(args);
    case "show":
      return runImproveProposalsShow(args);
    case "archive":
      return runImproveProposalsArchive(args);
    default:
      throw new Error("memory improve proposals supports: list|show|archive");
  }
}

export async function runImproveProposalsList(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposals = await listPendingProposalFiles(rootDir);
  const result = {
    state: proposals.length > 0 ? "pending" : "empty",
    proposals,
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory: ${proposals.length} pending proposal ${plural(proposals.length, "file")}`);
  for (const proposal of proposals) {
    console.log(`  ${proposal.file}${proposal.skill ? ` — ${proposal.skill}` : ""}`);
  }
}

export async function runImproveProposalsShow(args: ParsedArgs): Promise<void> {
  const proposalArg = args.positional[2];
  if (!proposalArg) throw new Error("memory improve proposals show needs a proposal file");
  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposalPath = resolve(rootDir, proposalArg);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  assertInsideProposalTree(rootDir, proposalPath);
  const body = await readFile(proposalPath, "utf8");
  const proposal = await summarizeProposalFile(rootDir, proposalPath, body);
  if (json) {
    console.log(JSON.stringify({ state: "shown", proposal, body }, null, 2));
    return;
  }
  console.log(body);
}

export async function runImproveProposalsArchive(args: ParsedArgs): Promise<void> {
  const proposalArg = args.positional[2];
  if (!proposalArg) throw new Error("memory improve proposals archive needs a proposal file");
  if (args.flags.yes !== true) {
    throw new Error("memory improve proposals archive requires explicit --yes approval");
  }
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : "";
  if (!isArchiveReason(reason)) {
    throw new Error("memory improve proposals archive requires --reason applied|rejected|stale");
  }
  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposalPath = resolve(rootDir, proposalArg);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  assertInsideProposalTree(rootDir, proposalPath);
  const archiveDir = join(proposalRoot(rootDir), "archive", reason);
  await mkdir(archiveDir, { recursive: true });
  const destination = join(archiveDir, proposalPath.split(sep).pop() ?? "proposal.md");
  assertInsideRoot(rootDir, destination, "archive target");
  await rename(proposalPath, destination);
  const result = {
    state: "archived",
    reason,
    proposal: toPosix(relative(rootDir, proposalPath)),
    archivePath: toPosix(relative(rootDir, destination)),
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory: archived proposal ${result.proposal}`);
  console.log(`  reason: ${reason}`);
  console.log(`  archive: ${result.archivePath}`);
}

export async function listPendingProposalFiles(rootDir: string): Promise<ProposalFileSummary[]> {
  const dir = proposalRoot(rootDir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const summaries: ProposalFileSummary[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const filePath = join(dir, entry.name);
    const body = await readFile(filePath, "utf8");
    summaries.push(await summarizeProposalFile(rootDir, filePath, body));
  }
  return summaries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

export async function summarizeProposalFile(rootDir: string, proposalPath: string, body: string): Promise<ProposalFileSummary> {
  const info = await stat(proposalPath);
  return {
    file: proposalPath.split(sep).pop() ?? toPosix(relative(rootDir, proposalPath)),
    path: toPosix(relative(rootDir, proposalPath)),
    status: toPosix(relative(proposalRoot(rootDir), proposalPath)).startsWith("archive/") ? "archived" : "pending",
    skill: firstProposalField(body, /^# Skill Improvement Proposal:\s*(.+)$/m) ?? firstProposalField(body, /^- Skill:\s*(.+)$/m),
    category: firstProposalField(body, /^- Category:\s*(.+)$/m),
    reason: firstProposalField(body, /^- Reason:\s*(.+)$/m),
    skillPath: firstProposalField(body, /^- Skill path:\s*(.+)$/m),
    generated: firstProposalField(body, /^Generated:\s*(.+)$/m),
    fingerprint: firstProposalField(body, /^Fingerprint:\s*(.+)$/m),
    bytes: info.size,
    mtimeMs: info.mtimeMs,
  };
}

export function firstProposalField(body: string, pattern: RegExp): string | null {
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

export function proposalRoot(rootDir: string): string {
  return join(rootDir, ".red", "memory", "proposals");
}

export function assertInsideProposalTree(rootDir: string, filePath: string): void {
  const rel = relative(proposalRoot(rootDir), filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("proposal file must stay inside .red/memory/proposals");
  }
}

export function isArchiveReason(reason: string): reason is "applied" | "rejected" | "stale" {
  return reason === "applied" || reason === "rejected" || reason === "stale";
}

export interface SkillPatchBlock {
  path: string;
  oldString: string;
  newString: string;
}

export async function runImproveApply(args: ParsedArgs): Promise<void> {
  const proposalArg = args.positional[1];
  if (!proposalArg) throw new Error("memory improve apply needs a proposal file");
  if (args.flags.yes !== true) {
    throw new Error("memory improve apply requires explicit --yes approval");
  }

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposalPath = resolve(rootDir, proposalArg);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  const proposal = await readFile(proposalPath, "utf8");
  const patchBlock = parseSkillPatchBlock(proposal);
  const targetPath = resolve(rootDir, patchBlock.path);
  assertInsideRoot(rootDir, targetPath, "patch target");

  const current = await readFile(targetPath, "utf8");
  const occurrences = countOccurrences(current, patchBlock.oldString);
  if (occurrences !== 1) {
    throw new Error(`patch target must contain oldString exactly once, found ${occurrences}`);
  }
  await writeFile(targetPath, current.replace(patchBlock.oldString, patchBlock.newString), "utf8");

  const result = {
    state: "applied",
    proposal: toPosix(relative(rootDir, proposalPath)),
    target: toPosix(relative(rootDir, targetPath)),
  };
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory: applied proposal ${result.proposal}`);
  console.log(`  target: ${result.target}`);
}

export function parseSkillPatchBlock(proposal: string): SkillPatchBlock {
  const match = proposal.match(/```json memory-skill-patch\s*([\s\S]*?)```/);
  if (!match) throw new Error("proposal needs a structured memory-skill-patch block");
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (err) {
    throw new Error(`invalid memory-skill-patch JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("memory-skill-patch must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;
  const path = obj.path;
  const oldString = obj.oldString;
  const newString = obj.newString;
  if (typeof path !== "string" || path.trim() === "") throw new Error("memory-skill-patch.path is required");
  if (typeof oldString !== "string" || oldString === "") throw new Error("memory-skill-patch.oldString is required");
  if (typeof newString !== "string") throw new Error("memory-skill-patch.newString is required");
  return { path, oldString, newString };
}

export function assertInsideRoot(rootDir: string, filePath: string, label: string): void {
  const rel = relative(rootDir, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside --root`);
  }
}

export function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}
