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
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export /**
 * Conversation extraction (the `INFERRED` write path). Reads a transcript from
 * a file or stdin, then either routes it through the configured RedDB AI
 * provider or uses the local structured-transcript fallback when no provider is
 * configured / `--local` is passed. This is an explicit write verb — the Stop
 * hook and `/memory:store` invoke it; recall/search never do.
 */
async function runExtract(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);

  if (config.mode !== "graph") {
    throw new Error(
      `extract needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const file = args.positional[0];
  const transcript = file
    ? await readFile(isAbsolute(file) ? file : resolve(rootDir, file), "utf8")
    : await readStdin();
  if (!transcript.trim()) {
    console.log("memory: empty transcript — nothing to extract");
    return;
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const providerConfig = config.provider;
    const useLocal = args.flags.local === true || !providerConfig;
    const resolved = useLocal ? null : resolveProvider(providerConfig);
    if (resolved && providerConfig) {
      applyProviderEnv(resolved, providerConfig.apiKeyEnv);
    }
    const facts = useLocal
      ? extractStructuredTranscript(transcript)
      : await extractConversation(transcript, redDbProviderClient(store, providerConfig));
    if (facts.length === 0) {
      console.log("memory: no facts extracted");
      return;
    }
    const source = useLocal ? "conversation-local-structured" : "conversation";
    const { nodes, edges } = factsToGraph(facts, source);
    const labelToRid = new Map<string, number>();
    for (const node of nodes) labelToRid.set(node.label, await store.upsertNode(node));
    let edgeCount = 0;
    for (const e of edges) {
      const from = labelToRid.get(e.fromLabel);
      const to = labelToRid.get(e.toLabel);
      if (from != null && to != null) {
        await store.upsertEdge({ from_rid: from, to_rid: to, label: e.label });
        edgeCount += 1;
      }
    }
    const via = resolved ? `${resolved.mode} (${resolved.egress})` : "local structured transcript";
    console.log(`memory: extracted ${nodes.length} INFERRED fact(s), ${edgeCount} edge(s) via ${via}`);
  } finally {
    await store.close();
  }
}

export async function runExtraction(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "status-viewer") return runExtractionStatusViewer(args);
  if (action !== "status") {
    throw new Error("extraction needs an action — supported: memory extraction status, memory extraction status-viewer");
  }
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const status = await buildMemoryExtractionStatus(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    console.log(
      `memory extraction: inferred=${status.inferred.available ? "available" : "unavailable"} facts=${status.inferred.facts}`,
    );
    if (status.inferred.mode) {
      console.log(
        `  provider: ${status.inferred.mode}/${status.inferred.model} (${status.inferred.egress})`,
      );
    }
    if (status.inferred.error) console.log(`  warning: ${status.inferred.error}`);
    for (const action of status.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

export async function runExtractionStatusViewer(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/extraction-status-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const status = await buildMemoryExtractionStatus(store, rootDir);
    const artifact = buildMemoryExtractionStatusViewerArtifact(status);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: extraction status viewer written ${outPath}`);
    console.log(`  inferred: ${status.inferred.available ? "available" : "unavailable"}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runMap(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action !== "freshness") {
    throw new Error("memory map supports: freshness");
  }
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryMapFreshnessReport(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(report.markdown);
  } finally {
    await store.close();
  }
}

export /**
 * Read-only Code drift report (ADR 0035). It surfaces unknown engineering codes
 * by recurrence count for curation and never mutates the graph or recall path.
 */
async function runCodeDrift(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const curation = await loadEngineeringCodeCuration(store);
    const nodes = await store.listNodes();
    const report = buildCodeDriftReport(
      nodes.map((node) => node.properties.engineering_code),
      {
        recurringThreshold: intFlag(args.flags, "recurring-threshold"),
        curation,
        canonicalize: (code) => resolveEngineeringCodeAlias(code, curation),
        isSuggested: (code) => isCuratedSuggestedEngineeringCode(code, curation),
      },
    );

    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      `memory code-drift: ${report.distinctUnknown} unknown code(s) across ${report.unknownCount} node(s) (${report.knownCount} in suggested vocabulary)`,
    );
    if (report.distinctUnknown === 0) {
      console.log("  no unknown engineering codes; nothing to curate");
      return;
    }

    console.log(`  recurring (count >= ${report.recurringThreshold}) - promotion/alias candidates:`);
    renderCodeDriftGroups(report.groups.filter((group) => group.recurrence === "recurring"));
    console.log("  one-off - noise:");
    renderCodeDriftGroups(report.groups.filter((group) => group.recurrence === "one-off"));
  } finally {
    await store.close();
  }
}

export async function runCodeCurate(args: ParsedArgs): Promise<void> {
  const action = args.positional[0] ?? "list";
  const { store } = await openGraphStore(args);
  try {
    const before = await loadEngineeringCodeCuration(store);
    let state = before;
    let changed = false;

    switch (action) {
      case "list":
        break;
      case "promote": {
        const code = args.positional[1];
        if (!code) throw new Error("usage: memory code-curate promote <code>");
        const result = promoteEngineeringCode(before, code);
        state = result.state;
        changed = result.changed;
        if (changed) await saveEngineeringCodeCuration(store, state);
        break;
      }
      case "alias": {
        const from = args.positional[1];
        const to = args.positional[2];
        if (!from || !to) throw new Error("usage: memory code-curate alias <from> <to>");
        const result = aliasEngineeringCode(before, from, to);
        state = result.state;
        changed = result.changed;
        if (changed) await saveEngineeringCodeCuration(store, state);
        break;
      }
      default:
        throw new Error("usage: memory code-curate list|promote <code>|alias <from> <to>");
    }

    if (args.flags.json === true) {
      console.log(JSON.stringify(codeCurationOutput(state, changed), null, 2));
      return;
    }

    console.log(
      `memory code-curate: suggested vocabulary ${state.suggestedVersion} (${suggestedEngineeringCodes(state).length} code(s))${changed ? " updated" : ""}`,
    );
    if (state.promoted.length > 0) console.log(`  promoted: ${state.promoted.join(", ")}`);
    else console.log("  promoted: (none)");
    if (state.aliases.length > 0) {
      console.log("  aliases:");
      for (const alias of state.aliases) console.log(`    ${alias.from} -> ${alias.to}`);
    } else {
      console.log("  aliases: (none)");
    }
  } finally {
    await store.close();
  }
}

export function codeCurationOutput(state: EngineeringCodeCurationState, changed: boolean) {
  return {
    changed,
    schemaVersion: state.schemaVersion,
    suggestedVersion: state.suggestedVersion,
    suggested: suggestedEngineeringCodes(state),
    promoted: state.promoted,
    aliases: state.aliases,
  };
}

export function renderCodeDriftGroups(groups: CodeDriftCountGroup[]): void {
  if (groups.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const group of groups) {
    console.log(`    count ${group.count}: ${group.codes.join(", ")}`);
  }
}

export /** Open the graph store for a read verb, erroring clearly outside graph mode. */
async function openGraphStore(args: ParsedArgs): Promise<{
  store: MemoryStore;
  config: MemoryConfig;
}> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `this verb needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  applyConfiguredProviderEnv(config.provider);
  return { store: await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) }), config };
}

export function applyConfiguredProviderEnv(provider: MemoryConfig["provider"]): void {
  if (!provider) return;
  try {
    applyProviderEnv(resolveProvider(provider), provider.apiKeyEnv);
  } catch {
    // Provider-aware commands report invalid config. Deterministic graph reads
    // should still be able to open the store and degrade locally.
  }
}

export function intFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  return typeof flags[key] === "string" ? Number(flags[key]) : undefined;
}

export function numberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  if (typeof flags[key] !== "string") return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a finite number`);
  return value;
}

export function commaIntegerFlag(flags: Record<string, string | boolean>, key: string): number[] {
  const raw = stringFlag(flags, key);
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const value = Number(part);
      if (!Number.isInteger(value)) throw new Error(`--${key} must contain integer values`);
      return value;
    });
}

export function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  return typeof flags[key] === "string" ? flags[key] : undefined;
}

export function isIntegerText(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

export function strFlag<T extends string>(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: T,
): T {
  return typeof flags[key] === "string" ? (flags[key] as T) : fallback;
}

export async function runSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to search — pass a query: memory search <query>");
  const { store } = await openGraphStore(args);
  try {
    const hits = await search(store, query, intFlag(args.flags, "limit") ?? 20);
    if (hits.length === 0) return void console.log(`memory: no matches for "${query}"`);
    console.log(`memory: ${hits.length} match(es) for "${query}"`);
    for (const h of hits) {
      console.log(`  [${h.score}] ${h.rid} (${h.node_type}) ${h.label}`);
      console.log(`        ${h.excerpt}`);
    }
  } finally {
    await store.close();
  }
}

export async function runMapContext(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to map — pass a query: memory map-context <query>");
  const { store } = await openGraphStore(args);
  try {
    const contextRaw = stringFlag(args.flags, "context");
    const slice = await buildMemoryMapContextSlice(store, query, {
      depth: intFlag(args.flags, "depth") ?? 2,
      mode: mapContextModeFlag(args.flags),
      tokenBudget: intFlag(args.flags, "budget") ?? 1800,
      contextFilters: contextRaw
        ? contextRaw.split(",").map((part) => part.trim()).filter(Boolean)
        : undefined,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(slice, null, 2));
      return;
    }
    console.log(slice.context_md);
  } finally {
    await store.close();
  }
}

export function mapContextModeFlag(flags: Record<string, string | boolean>): "bfs" | "dfs" {
  const mode = strFlag(flags, "mode", "bfs");
  if (mode === "bfs" || mode === "dfs") return mode;
  throw new Error("map-context --mode must be bfs or dfs");
}

export async function runNeighbors(args: ParsedArgs): Promise<void> {
  const label = args.positional[0];
  if (!label) throw new Error("pass a node label: memory neighbors <label>");
  const { store } = await openGraphStore(args);
  try {
    const rows = await neighbors(
      store,
      label,
      intFlag(args.flags, "depth") ?? 1,
      strFlag(args.flags, "direction", "both"),
    );
    console.log(`memory: ${rows.length} neighbor(s) of "${label}"`);
    for (const n of rows) console.log(`  d${n.depth} ${n.rid} (${n.node_type}) ${n.label}`);
  } finally {
    await store.close();
  }
}

export async function runTraverse(args: ParsedArgs): Promise<void> {
  const label = args.positional[0];
  if (!label) throw new Error("pass a start label: memory traverse <label>");
  const { store } = await openGraphStore(args);
  try {
    const rows = await traverse(store, label, {
      depth: intFlag(args.flags, "depth") ?? 3,
      strategy: strFlag(args.flags, "strategy", "bfs"),
      direction: strFlag(args.flags, "direction", "outgoing"),
    });
    console.log(`memory: traversed ${rows.length} node(s) from "${label}"`);
    for (const n of rows) console.log(`  d${n.depth} ${n.rid} (${n.node_type}) ${n.label}`);
  } finally {
    await store.close();
  }
}

export async function runPath(args: ParsedArgs): Promise<void> {
  const [from, to] = args.positional;
  if (!from || !to) throw new Error("pass two labels: memory path <from> <to>");
  const { store } = await openGraphStore(args);
  try {
    const result = await shortestPath(store, from, to, strFlag(args.flags, "algorithm", "bfs"));
    if (!result || !result.reachable) {
      console.log(`memory: no path from "${from}" to "${to}"`);
      return;
    }
    console.log(
      `memory: path "${from}" → "${to}": ${result.hopCount} hop(s), weight ${result.totalWeight}`,
    );
  } finally {
    await store.close();
  }
}

export async function runPathExplain(args: ParsedArgs): Promise<void> {
  const [from, to] = args.positional;
  if (!from || !to) throw new Error("pass two labels: memory path-explain <from> <to>");
  const { store } = await openGraphStore(args);
  try {
    const report = await buildPathExplainReport(store, {
      from,
      to,
      maxDepth: intFlag(args.flags, "max-depth"),
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

export async function runPathExplainViewer(args: ParsedArgs): Promise<void> {
  const [from, to] = args.positional;
  if (!from || !to) throw new Error("pass two labels: memory path-explain-viewer <from> <to>");
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/path-explain-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildPathExplainReport(store, {
      from,
      to,
      maxDepth: intFlag(args.flags, "max-depth"),
    });
    const artifact = buildPathExplainViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: path explanation viewer written ${outPath}`);
    console.log(`  from: ${from}`);
    console.log(`  to: ${to}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}
