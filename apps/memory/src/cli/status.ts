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
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag, stringFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export /**
 * memory status skills — the dedicated Skill telemetry status surface. Unlike
 * the auto-firing hooks and the `event`/`curate` no-ops (which stay silent
 * during normal use), this is an explicitly-invoked *diagnostic*: it always
 * explains the telemetry state — `uninitialized`, `no-op` (missing graph mode),
 * `unavailable` (graph mode but telemetry never enabled), or `enabled` — and
 * never errors out (exit 0 in every state). When enabled it reads the persisted
 * rollups and recent events; it is strictly read-only and opens the store only
 * in the `enabled` state. Default output focuses on Curatable skills; `--all`
 * includes bundled plugin/hub skills.
 */
async function runStatus(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind === "context") return runContextStatus(args);
  if (kind !== "skills") {
    throw new Error("status needs a kind — supported: memory status skills|context");
  }

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const config = await readConfig(rootDir);

  // Non-enabled states: explain the diagnostic outcome, never open the store.
  if (!config) {
    return reportStatusState(json, "uninitialized", "memory is not initialized here", {
      hint: "run `memory init --mode graph --skill-telemetry`",
    });
  }
  if (config.mode !== "graph") {
    return reportStatusState(
      json,
      "no-op",
      `skill telemetry needs graph mode, this project is "${config.mode}"`,
      { hint: "re-run `memory init --mode graph --skill-telemetry`" },
    );
  }
  if (!skillTelemetryEnabled(config)) {
    return reportStatusState(json, "unavailable", "skill telemetry is not enabled here", {
      hint: "re-run `memory init --mode graph --skill-telemetry`",
    });
  }

  const all = args.flags.all === true;
  const limit = intFlag(args.flags, "limit") ?? 10;

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  let rollups: SkillRollup[];
  let recent: SkillEventSummary[];
  try {
    rollups = await readSkillRollups(store);
    recent = await readRecentSkillEvents(store, limit);
  } finally {
    await store.close();
  }

  const curatableCount = rollups.filter((r) => isCuratable(r.source_kind)).length;
  const shownRollups = all ? rollups : rollups.filter((r) => isCuratable(r.source_kind));
  const shownEvents = all ? recent : recent.filter((e) => isCuratable(e.source_kind));

  if (json) {
    console.log(
      JSON.stringify(
        {
          state: "enabled",
          scope: all ? "all" : "curatable",
          totalSkills: rollups.length,
          curatableSkills: curatableCount,
          readOnlySkills: rollups.length - curatableCount,
          skills: shownRollups,
          recentEvents: shownEvents,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log("memory: skill telemetry status — enabled (graph mode)");
  console.log(
    `  ${rollups.length} ${plural(rollups.length, "skill")} observed ` +
      `(${curatableCount} curatable, ${rollups.length - curatableCount} read-only)`,
  );
  if (rollups.length === 0) {
    console.log("  no skills observed yet — telemetry is enabled but nothing has been recorded");
    console.log(
      "\nDiagnostic command: normal-use ingestion stays silent; this surface only reads.",
    );
    return;
  }

  console.log(
    all
      ? "  scope: all observed skills (including bundled plugin/hub skills)"
      : "  scope: curatable skills (use --all to include bundled plugin/hub skills)",
  );

  if (shownRollups.length === 0) {
    console.log("  no curatable skills observed — re-run with --all to see bundled skills");
  } else {
    console.log("\n  skill / kind / events (v·u·p·c·r) / outcomes / last-activity:");
    for (const r of shownRollups) {
      const outcomes = formatOutcomes(r.outcome_counts);
      console.log(
        `  ${r.name} (${r.source_kind}) — ${r.event_count} event(s) ` +
          `(v${r.view_count}·u${r.use_count}·p${r.patch_count}·c${r.change_count}·r${r.result_count})` +
          `${outcomes ? ` ${outcomes}` : ""} — ${r.last_activity}`,
      );
    }
  }

  if (shownEvents.length > 0) {
    console.log(`\n  recent events (newest first, up to ${limit}):`);
    for (const e of shownEvents) {
      const status = e.status ? ` [${e.status}]` : "";
      console.log(`  ${e.timestamp}  ${e.event_type}${status}  ${e.name} (${e.source_kind}) <${e.runner}>`);
    }
  }

  console.log("\nDiagnostic command: normal-use ingestion stays silent; this surface only reads.");
}

export /**
 * memory health — a compact operational panel for the Memory plugin. Unlike
 * `status context` (broad repository context posture) and `status skills`
 * (telemetry detail), health combines the Memory readiness signals that an
 * agent/CI needs before running self-improvement: graph mode/freshness,
 * telemetry rollups, proposal candidates, high-priority work, pending proposal
 * files, and concrete next actions. It is strictly read-only.
 */
async function runHealth(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const json = args.flags.json === true;
  const report = await healthReport(rootDir);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`memory: health — ${report.state}`);
  console.log(
    `  initialized=${yesNo(report.initialized)} graph=${yesNo(report.graphMode)} ` +
      `telemetry=${report.skillTelemetry} freshness=${report.graphFreshness.state}`,
  );
  console.log(
    `  rollups=${report.rollups} proposal-candidates=${report.proposalCandidates} ` +
      `high-priority=${report.highPriorityProposals} pending-files=${report.pendingProposalFiles}`,
  );
  if (report.topProposals.length > 0) {
    console.log("\n  top proposals:");
    for (const proposal of report.topProposals) {
      console.log(
        `  - ${proposal.priority} ${proposal.score.toFixed(2)} ${proposal.skill}: ${proposal.reason}`,
      );
    }
  }
  if (report.recommendedNextActions.length > 0) {
    console.log("\n  recommended next actions:");
    for (const item of report.recommendedNextActions) console.log(`  - ${item}`);
  }
  console.log("\nRead-only healthcheck: no memory, graph, proposal, or skill files were mutated.");
}

export /**
 * memory recall-telemetry — roll up `memory.recall.observed` events from the
 * analytics hypertable into a real-run recall-quality report (hit-rate,
 * gold-in-pack proxy, tokens saved). Explicitly distinct from `memory bench`,
 * the synthetic retrieval benchmark (#828). Read-only.
 */
async function runRecallTelemetry(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const windowMs = intFlag(args.flags, "window-ms");
    const report = await buildRecallTelemetryReport(store, {
      ...(windowMs != null ? { windowMs } : {}),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderRecallTelemetryReport(report));
  } finally {
    await store.close();
  }
}

export async function runHealthViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryHealthReport(store, {
      stale_days: intFlag(args.flags, "stale-days"),
    });
    const artifact = buildMemoryHealthViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/health-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: health viewer written ${outPath}`);
    console.log(`  state: ${report.state}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runGovernance(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const report = await buildMemoryGovernanceReport(store, {
      staleProgressDays: intFlag(args.flags, "stale-progress-days"),
      providerConfig: config.provider,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printGovernance(report);
  } finally {
    await store.close();
  }
}

export async function runGovernanceViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store, config } = await openGraphStore(args);
  try {
    const report = await buildMemoryGovernanceReport(store, {
      staleProgressDays: intFlag(args.flags, "stale-progress-days"),
      providerConfig: config.provider,
    });
    const artifact = buildMemoryGovernanceViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/governance-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: governance viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export function printGovernance(report: MemoryGovernanceReport): void {
  console.log(`memory: governance — ${report.status}`);
  console.log(
    `  provenance=${report.summary.nodes_with_provenance}/${report.summary.total_nodes} ` +
      `privacy=${report.summary.privacy_findings} lint=${report.summary.lint_findings} ` +
      `conflicts=${report.summary.unresolved_contradictions} superseded=${report.summary.superseded_nodes}`,
  );
  console.log(
    `  tidy=${report.tidy_availability.status}` +
      (report.tidy_availability.reason ? ` (${report.tidy_availability.reason})` : ""),
  );
  console.log(
    `  tidy recommendations=${report.tidy_recommendations.summary.recommended_pairs}/` +
      `${report.tidy_recommendations.summary.candidate_pairs}` +
      (report.tidy_recommendations.reason ? ` (${report.tidy_recommendations.reason})` : ""),
  );
  for (const item of report.provenance.missing.slice(0, 5)) {
    console.log(`  missing provenance: memory_nodes:${item.rid} ${item.title}`);
  }
  for (const finding of report.privacy.findings.slice(0, 5)) {
    console.log(`  privacy: ${finding.kind} ${finding.location} (${finding.severity})`);
  }
  for (const finding of report.lint.findings.slice(0, 5)) {
    console.log(`  lint: ${finding.code} ${finding.location} (${finding.severity})`);
  }
  for (const action of report.recommended_next_actions) console.log(`  next: ${action}`);
  console.log("\nRead-only governance report: no memory, graph, note, or export files were mutated.");
}

export async function runLint(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await lintMemory(rootDir);

  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printLintReport(report);
}

export async function runPrivacy(args: ParsedArgs): Promise<void> {
  const action = args.positional[0] ?? "scan";
  if (action === "scan") {
    const rootDir = resolve(rootOf(args.flags));
    const report = await scanPrivacy(rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    printPrivacyReport(report);
    return;
  }

  if (action === "export") {
    const rootDir = rootOf(args.flags);
    const target = args.positional[1] ?? ".red/memory/export-redacted";
    const outDir = isAbsolute(target) ? target : resolve(rootDir, target);
    const communities = args.flags.communities === true;
    const { store } = await openGraphStore(args);
    try {
      const result = await exportGraph(store, outDir, {
        communities,
        redactSensitive: true,
      });
      const payload = {
        readOnly: true,
        mutated: false,
        redacted: true,
        findings: result.privacyFindings,
        result,
      };
      if (args.flags.json === true) {
        console.log(JSON.stringify(payload, null, 2));
        return;
      }
      console.log(
        `memory: redacted export — ${result.nodes} node(s), ${result.edges} edge(s), ${result.privacyFindings} finding(s) redacted`,
      );
      if (communities) console.log(`  communities: coloured via native Louvain`);
      console.log(`  graph:  ${result.htmlPath}`);
      console.log(`  json:   ${result.jsonPath}`);
      console.log(`  audit:  ${result.auditPath}`);
      console.log("\nRedacted export wrote artifacts only; no Memory graph or note files were mutated.");
      return;
    } finally {
      await store.close();
    }
  }

  throw new Error("usage: memory privacy scan|export [<out-dir>] [--root <dir>] [--json]");
}

export function printPrivacyReport(report: PrivacyReport): void {
  console.log(
    `memory: privacy scan — ${report.status} (${report.mode}, ${report.totalMemories} ${plural(
      report.totalMemories,
      "memory",
    )})`,
  );
  for (const warning of report.warnings) {
    console.log(`  warning: ${warning}`);
  }
  if (report.findings.length === 0) {
    console.log("  no sensitive-looking values found");
  } else {
    for (const item of report.findings) {
      console.log(`  [${item.severity}] ${item.kind} ${item.memoryId}`);
      console.log(`        ${item.message}`);
      console.log(`        ${item.location}`);
      if (item.excerpt) console.log(`        ${item.excerpt}`);
    }
  }
  console.log("\nRead-only privacy scan: no memory, graph, note, or export files were mutated.");
}

export function printLintReport(report: LintReport): void {
  console.log(
    `memory: lint — ${report.status} (${report.mode}, ${report.totalMemories} ${plural(
      report.totalMemories,
      "memory",
    )})`,
  );
  for (const warning of report.warnings) {
    console.log(`  warning: ${warning}`);
  }
  if (report.findings.length === 0) {
    console.log("  no policy hygiene findings");
  } else {
    for (const item of report.findings) {
      const related = item.relatedMemoryId ? ` related=${item.relatedMemoryId}` : "";
      console.log(`  [${item.severity}] ${item.code} ${item.memoryId}${related}`);
      console.log(`        ${item.message}`);
      if (item.excerpt) console.log(`        ${item.excerpt}`);
    }
  }
  if (report.ruleSuggestions.length > 0) {
    console.log("\nRule suggestions:");
    for (const suggestion of report.ruleSuggestions) {
      console.log(`  ${suggestion.id}: ${suggestion.title}`);
      console.log(`        target: ${suggestion.targetFiles.join(", ")}`);
      console.log(`        ${suggestion.markdown}`);
    }
  }
  console.log("\nRead-only lint: no memory, graph, or note files were mutated.");
}

export async function healthReport(rootDir: string) {
  const context = await contextStatusReport(rootDir);
  const config = await readConfig(rootDir);
  const initialized = config !== null;
  const graphMode = config?.mode === "graph" && context.memory.graphStoreExists;
  const telemetryEnabled = config !== null && graphMode && skillTelemetryEnabled(config);
  const pendingProposalFiles = (await listPendingProposalFiles(rootDir)).length;
  let rollups: SkillRollup[] = [];
  let topProposals: SkillImprovementProposalSummary[] = [];
  let engineEvents: MemoryHealthReport["engine_events"] | null = null;

  if (graphMode && config) {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      if (telemetryEnabled) {
        rollups = await readSkillRollups(store);
        const recent = await readRecentSkillEvents(store, 50);
        const curated = curateSkills(rollupsToCuratorInput(rollups));
        topProposals = (
          await buildSkillImprovementProposals(
            rootDir,
            curated.recommendations,
            rollups,
            recent,
            false,
          )
        ).proposals;
      }
      engineEvents = await engineEventHealth(store);
    } finally {
      await store.close();
    }
  }

  const highPriorityProposals = topProposals.filter((proposal) => proposal.priority === "high").length;
  const recommendedNextActions = healthRecommendations({
    initialized,
    graphMode,
    telemetryEnabled,
    graphFreshnessState: context.memory.graphFreshness.state,
    highPriorityProposals,
    proposalCandidates: topProposals.length,
    pendingProposalFiles,
  });

  return {
    state: healthState({
      initialized,
      graphMode,
      telemetryEnabled,
      graphFreshnessState: context.memory.graphFreshness.state,
      highPriorityProposals,
      pendingProposalFiles,
    }),
    root: rootDir,
    initialized,
    graphMode,
    skillTelemetry: telemetryEnabled ? "enabled" : "unavailable",
    hooksEnabled: context.memory.hooksEnabled,
    graphFreshness: context.memory.graphFreshness,
    rollups: rollups.length,
    proposalCandidates: topProposals.length,
    highPriorityProposals,
    pendingProposalFiles,
    topProposals: topProposals.slice(0, 5),
    engineEvents,
    recommendedNextActions,
  };
}

export function healthState(input: {
  initialized: boolean;
  graphMode: boolean;
  telemetryEnabled: boolean;
  graphFreshnessState: string;
  highPriorityProposals: number;
  pendingProposalFiles: number;
}): "missing" | "degraded" | "ready" | "attention" {
  if (!input.initialized) return "missing";
  if (!input.graphMode || !input.telemetryEnabled || input.graphFreshnessState === "stale") return "degraded";
  if (input.highPriorityProposals > 0 || input.pendingProposalFiles > 0) return "attention";
  return "ready";
}

export function healthRecommendations(input: {
  initialized: boolean;
  graphMode: boolean;
  telemetryEnabled: boolean;
  graphFreshnessState: string;
  highPriorityProposals: number;
  proposalCandidates: number;
  pendingProposalFiles: number;
}): string[] {
  const items: string[] = [];
  if (!input.initialized) {
    items.push("run `memory init --mode graph --skill-telemetry` to enable graph recall and self-improvement telemetry");
    return items;
  }
  if (!input.graphMode) {
    items.push("switch to graph mode before relying on graph recall, telemetry, or proposal ranking");
    return items;
  }
  if (input.graphFreshnessState === "stale") {
    items.push("run `memory ingest . --root .` before relying on graph recall");
  }
  if (!input.telemetryEnabled) {
    items.push("enable Skill telemetry before expecting self-improvement evidence");
  }
  if (input.highPriorityProposals > 0) {
    items.push("review and apply the top high-priority Skill improvement proposal");
  } else if (input.proposalCandidates > 0) {
    items.push("review ranked Skill improvement proposal candidates");
  }
  if (input.pendingProposalFiles > 0) {
    items.push("review pending files under .red/memory/proposals");
  }
  if (items.length === 0) items.push("memory is healthy; continue collecting telemetry");
  return items;
}

export type CheckName =
  | "agent-rules"
  | "domain-glossary"
  | "memory-initialized"
  | "memory-graph"
  | "graph-freshness"
  | "skill-telemetry"
  | "wiki-ready"
  | "adr-context";

export interface ContextCheck {
  name: CheckName;
  ok: boolean;
  reason: string;
}

export async function runContextStatus(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const json = args.flags.json === true;
  const report = await contextStatusReport(rootDir);

  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`memory: context stack status — ${report.state}`);
  console.log(`  score: ${report.score.value}/${report.score.max}`);
  console.log(`  agent rules: ${report.committedContext.agentRules ?? "absent"}`);
  console.log(
    `  domain: glossary=${yesNo(report.committedContext.domainGlossary)} ` +
      `ADRs=${report.committedContext.adrCount} map=${yesNo(report.committedContext.contextMap)}`,
  );
  console.log(
    `  memory: ${report.memory.mode}` +
      (report.memory.mode === "graph"
        ? ` store=${yesNo(report.memory.graphStoreExists)} ` +
          `freshness=${report.memory.graphFreshness.state} telemetry=${yesNo(report.memory.skillTelemetry)}`
        : ""),
  );
  console.log(`  wiki: ${report.wiki.state}`);
  if (report.recommendations.length > 0) {
    console.log("\n  recommendations:");
    for (const item of report.recommendations) console.log(`  - ${item}`);
  }
  console.log("\nRead-only healthcheck: no memory, wiki, graph, or skill files were mutated.");
}

export async function contextStatusReport(rootDir: string) {
  const config = await readConfig(rootDir);
  const agentRules = (await exists(join(rootDir, "CLAUDE.md")))
    ? "CLAUDE.md"
    : (await exists(join(rootDir, "AGENTS.md")))
      ? "AGENTS.md"
      : null;
  const domainGlossary = await exists(join(rootDir, ".red", "CONTEXT.md"));
  const contextMap = await exists(join(rootDir, ".red", "CONTEXT-MAP.md"));
  const adrCount = await countMarkdownFiles(join(rootDir, ".red", "adr"));
  const wikiSpec = await exists(join(rootDir, ".red", "agents", "wiki.md"));
  const wikiDir = await exists(join(rootDir, ".red", "wiki"));
  const graphStorePath = config?.storePath ?? ".red/memory/graph.rdb";
  const graphStoreExists = config?.mode === "graph" ? await storeExists(rootDir, graphStorePath) : false;
  const graphFreshness =
    config?.mode === "graph" && graphStoreExists
      ? await graphFreshnessStatus(rootDir, graphStorePath)
      : { state: "unavailable" as const, newerFiles: [] as string[] };
  const hooksEnabled = config ? enabledHookNames(config.hooks) : [];

  const memory = config
    ? {
        mode: config.mode,
        skillTelemetry: skillTelemetryEnabled(config),
        hooksEnabled,
        graphStorePath: config.mode === "graph" ? graphStorePath : null,
        graphStoreExists,
        graphFreshness,
      }
    : {
        mode: "uninitialized" as const,
        skillTelemetry: false,
        hooksEnabled: [] as string[],
        graphStorePath: null,
        graphStoreExists: false,
        graphFreshness,
      };

  const wiki = {
    state: wikiSpec && wikiDir ? "ready" : wikiSpec || wikiDir ? "partial" : "absent",
    agentSpec: wikiSpec,
    wikiDir,
  };

  const checks: ContextCheck[] = [
    {
      name: "agent-rules",
      ok: agentRules !== null,
      reason: agentRules ? `${agentRules} present` : "CLAUDE.md or AGENTS.md missing",
    },
    {
      name: "domain-glossary",
      ok: domainGlossary,
      reason: domainGlossary ? ".red/CONTEXT.md present" : ".red/CONTEXT.md missing",
    },
    {
      name: "adr-context",
      ok: adrCount > 0,
      reason: adrCount > 0 ? `${adrCount} ADR file(s) present` : "no ADR files found under .red/adr/",
    },
    {
      name: "memory-initialized",
      ok: config !== null,
      reason: config ? `memory initialized in ${config.mode} mode` : "memory config missing",
    },
    {
      name: "memory-graph",
      ok: config?.mode === "graph" && graphStoreExists,
      reason:
        config?.mode === "graph"
          ? graphStoreExists
            ? "graph mode with store present"
            : "graph mode configured but graph store is missing"
          : "graph mode not enabled",
    },
    {
      name: "graph-freshness",
      ok: graphFreshness.state === "fresh" || graphFreshness.state === "unavailable",
      reason:
        graphFreshness.state === "fresh"
          ? "graph store is newer than scanned project files"
          : graphFreshness.state === "stale"
            ? `${graphFreshness.newerFiles.length} project file(s) are newer than the graph store`
            : "graph freshness unavailable without graph mode and store",
    },
    {
      name: "skill-telemetry",
      ok: config !== null && skillTelemetryEnabled(config),
      reason: config !== null && skillTelemetryEnabled(config) ? "Skill telemetry enabled" : "Skill telemetry unavailable",
    },
    {
      name: "wiki-ready",
      ok: wiki.state === "ready",
      reason: wiki.state === "ready" ? "LLM Wiki initialized" : "LLM Wiki absent or partial",
    },
  ];

  const recommendations = contextRecommendations({
    agentRules,
    domainGlossary,
    config,
    wikiState: wiki.state,
    graphFreshness,
  });
  const value = checks.filter((check) => check.ok).length;

  return {
    state: value === checks.length ? "ready" : "incomplete",
    root: rootDir,
    committedContext: {
      agentRules,
      domainGlossary,
      contextMap,
      adrCount,
    },
    memory,
    wiki,
    score: {
      value,
      max: checks.length,
      checks,
    },
    recommendations,
  };
}

export function contextRecommendations(input: {
  agentRules: string | null;
  domainGlossary: boolean;
  config: Awaited<ReturnType<typeof readConfig>>;
  wikiState: string;
  graphFreshness: Awaited<ReturnType<typeof graphFreshnessStatus>> | { state: "unavailable"; newerFiles: string[] };
}): string[] {
  const items: string[] = [];
  if (!input.agentRules) items.push("add CLAUDE.md or AGENTS.md with agent rules");
  if (!input.domainGlossary) items.push("add .red/CONTEXT.md for the project glossary");
  if (!input.config) {
    items.push("run `memory init --mode graph --skill-telemetry` when persistent graph recall is useful");
  } else if (input.config.mode !== "graph") {
    items.push("switch to graph mode when you need graph recall, ingest, telemetry, or curator evidence");
  } else if (input.graphFreshness.state === "stale") {
    items.push("run `memory ingest . --root .` before relying on graph recall");
  } else if (!skillTelemetryEnabled(input.config)) {
    items.push("enable Skill telemetry when you want self-improvement evidence for `/curate`");
  }
  if (input.wikiState === "absent") items.push("run `/wiki-init` if the project needs a durable research/wiki layer");
  if (input.wikiState === "partial") items.push("repair the LLM Wiki setup so both .red/agents/wiki.md and .red/wiki/ exist");
  return items;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function countMarkdownFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

export async function storeExists(rootDir: string, storePath: string): Promise<boolean> {
  const abs = isAbsolute(storePath) ? storePath : join(rootDir, storePath);
  try {
    const info = await stat(abs);
    return info.isFile() || info.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

export async function graphFreshnessStatus(rootDir: string, storePath: string): Promise<{
  state: "fresh" | "stale" | "unknown";
  storeMtimeMs: number | null;
  newestProjectMtimeMs: number | null;
  newerFiles: string[];
  scannedFiles: number;
}> {
  const storeAbs = isAbsolute(storePath) ? storePath : join(rootDir, storePath);
  const storeMtimeMs = await newestMtimeMs(storeAbs);
  if (storeMtimeMs === null) {
    return { state: "unknown", storeMtimeMs, newestProjectMtimeMs: null, newerFiles: [], scannedFiles: 0 };
  }

  const scan = await scanProjectFreshness(rootDir, storeMtimeMs);
  return {
    state: scan.newerFiles.length > 0 ? "stale" : "fresh",
    storeMtimeMs,
    newestProjectMtimeMs: scan.newestProjectMtimeMs,
    newerFiles: scan.newerFiles,
    scannedFiles: scan.scannedFiles,
  };
}

export async function scanProjectFreshness(rootDir: string, storeMtimeMs: number): Promise<{
  newestProjectMtimeMs: number | null;
  newerFiles: string[];
  scannedFiles: number;
}> {
  const newerFiles: string[] = [];
  let newestProjectMtimeMs: number | null = null;
  let scannedFiles = 0;

  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = toPosix(relative(rootDir, abs));
      if (shouldSkipFreshnessPath(rel, entry.isDirectory())) continue;

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;

      const info = await stat(abs);
      scannedFiles += 1;
      newestProjectMtimeMs = Math.max(newestProjectMtimeMs ?? 0, info.mtimeMs);
      if (info.mtimeMs > storeMtimeMs) newerFiles.push(rel);
    }
  }

  await walk(rootDir);
  newerFiles.sort();
  return { newestProjectMtimeMs, newerFiles: newerFiles.slice(0, 20), scannedFiles };
}

export async function newestMtimeMs(path: string): Promise<number | null> {
  try {
    const info = await stat(path);
    if (info.isFile()) return info.mtimeMs;
    if (!info.isDirectory()) return null;
    let newest = info.mtimeMs;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      const child = await newestMtimeMs(join(path, entry.name));
      if (child !== null) newest = Math.max(newest, child);
    }
    return newest;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export function shouldSkipFreshnessPath(rel: string, isDir: boolean): boolean {
  const first = rel.split("/")[0];
  if ([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next"].includes(first)) {
    return true;
  }
  if (rel === ".red/memory" || rel.startsWith(".red/memory/")) return true;
  if (rel === ".red/wiki" || rel.startsWith(".red/wiki/")) return true;
  if (isDir && entryLooksLikeCache(first)) return true;
  return false;
}

export function entryLooksLikeCache(name: string): boolean {
  return name === ".cache" || name === ".pytest_cache" || name === ".vitest";
}

export function toPosix(path: string): string {
  return path.split(sep).join("/");
}

export function enabledHookNames(hooks: {
  sessionStart: boolean;
  postToolUse: boolean;
  stop: boolean;
  preCompact: boolean;
}): string[] {
  return Object.entries(hooks)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

export function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

export /** Print a non-enabled status state in either JSON or human-readable form. */
function reportStatusState(
  json: boolean,
  state: "uninitialized" | "no-op" | "unavailable",
  reason: string,
  opts: { hint?: string } = {},
): void {
  if (json) {
    console.log(JSON.stringify({ state, reason, hint: opts.hint }, null, 2));
    return;
  }
  console.log(`memory: skill telemetry status — ${state}`);
  console.log(`  ${reason}`);
  if (opts.hint) console.log(`  ${opts.hint}`);
}

export /** Compact `succeeded=3 failed=1` summary of a rollup's outcome counts. */
function formatOutcomes(counts: SkillRollup["outcome_counts"]): string {
  return Object.entries(counts)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([status, n]) => `${status}=${n}`)
    .join(" ");
}

export function skillEventFromFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_type: flags["event-type"],
    event_id: flags["event-id"],
    timestamp: flags.timestamp,
    session_id: flags["session-id"],
    turn_id: flags["turn-id"],
    name: flags.name,
    source_kind: flags["source-kind"],
    path: flags.path,
    runner: flags.runner,
  };

  const resultKeys = ["status", "duration-ms", "error-class", "error-code", "error-stage"];
  if (resultKeys.some((key) => flags[key] !== undefined)) {
    event.result = {
      status: flags.status,
      duration_ms:
        typeof flags["duration-ms"] === "string" ? Number(flags["duration-ms"]) : undefined,
      error_class: flags["error-class"],
      error_code: flags["error-code"],
      error_stage: flags["error-stage"],
    };
  }
  return event;
}

export function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}
