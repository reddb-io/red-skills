import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { asGraphRecallResult, capsuleSourceFlag, formatVectorRecallDiagnostic, printContextPackToon, printDashboardToon, printLegacyGraphRecall, printLegacyMarkdownRecall, printRecallToon, runAutocure, runCapsule, runClassify, runContextPack, runContextPackViewer, runDashboard, runFederate, runPreflight, runReadiness, runReadinessViewer, runReasoningReplay, runRecall, runRecommend, runSmartSearch, runSmartSearchViewer, runWhatif } from './recall.js';
import type { ContextPackToonEntry, DashboardToonSection, RecallToonItem } from './recall.js';
import { currentGitCommit, graphStateMetadata, printRoutingGuide, publicFindingDiagnostic, publicSafeRefusalMessage, routingAgentFlag, runAgentIntegrationStatus, runAgentIntegrationStatusViewer, runAsk, runCapabilities, runHandoff, runHandoffViewer, runLearningDebt, runLearningDebtViewer, runMemoryDecay, runMemoryDecayViewer, runMemoryLayers, runMemoryLayersViewer, runMemoryMergePass, runMemoryMergePassExecute, runMemoryMergePassUnmerge, runOnboardingMap, runOnboardingMapExport, runOnboardingMapViewer, runReferenceRadar, runRoutingGuide, runRoutingGuideViewer, runSession, runSessionEnd, runSessionShow, runSessionStart, runTidyReview, runTidyReviewAccept, runTidyReviewDismiss, runTidyReviewRefresh, runWorkbench, runWorkFrontier, runWorkFrontierViewer, runWorking } from './reports.js';
import type { OnboardingMapExportShape, PublicCodebaseMapMetadata } from './reports.js';
import { driftGuardAuditLog, driftGuardChangedFiles, driftGuardHeadMessage, driftGuardRecordEvent, gitDiffPaths, readSkillCuratorReport, refreshPaths, runBootstrap, runCurate, runDriftGuard, runIngest, runRefresh, runSkillEvent, splitPathList } from './vcs-ingest.js';
import { assertInsideProposalTree, assertInsideRoot, countOccurrences, firstProposalField, isArchiveReason, listPendingProposalFiles, parseSkillPatchBlock, proposalRoot, runImprove, runImproveApply, runImproveProposals, runImproveProposalsArchive, runImproveProposalsList, runImproveProposalsShow, summarizeProposalFile } from './improve-commands.js';
import type { ProposalFileSummary, SkillPatchBlock } from './improve-commands.js';
import { buildSkillImprovementProposals, buildSkillTelemetryEvidenceCard, countSkillTelemetryEvidenceCardsForSignal, findReusableSkillTelemetryEvidenceCard, firstTopLevelYamlScalarField, isPlainObject, isUnresolvedSkillTelemetryEvidenceCardStatus, lastYamlScalarField, listSkillTelemetryEvidenceCardsForSignal, markdownSectionByHeading, parseSkillTelemetryEvidenceCardStatus, parseYamlScalar, proposalFingerprint, recentFailureEvidence, renderDraftSkillPatchBlock, renderEvidenceCardYaml, renderRecentFailureEvidence, renderSkillImprovementProposal, reportImproveState, semanticHeadingCandidates, semanticSectionAnchor, semanticTroubleshootingNote, skillTelemetryDominantErrorPattern, skillTelemetryEvidenceRoute, skillTelemetryEvidenceSource, skillTelemetryReviewHasHumanDecision, skillTelemetrySignalFingerprint, skillTelemetryWindow, suggestedSectionOrAnchor, topValues, uniqueTailAnchor, yamlScalar, yamlValue } from './improve-build.js';
import type { ExistingSkillTelemetryEvidenceCardRef, SkillImprovementBuildResult, SkillImprovementProposalSummary, SkillTelemetryEvidenceCard, SkillTelemetryEvidenceCardArtifact, SkillTelemetryEvidenceCardStatus } from './improve-build.js';
import { contextRecommendations, contextStatusReport, countMarkdownFiles, enabledHookNames, entryLooksLikeCache, exists, formatOutcomes, graphFreshnessStatus, healthRecommendations, healthReport, healthState, newestMtimeMs, plural, printGovernance, printLintReport, printPrivacyReport, reportStatusState, runContextStatus, runGovernance, runGovernanceViewer, runHealth, runHealthViewer, runLint, runPrivacy, runRecallTelemetry, runStatus, scanProjectFreshness, shouldSkipFreshnessPath, skillEventFromFlags, storeExists, toPosix, yesNo } from './status.js';
import type { CheckName, ContextCheck } from './status.js';
import { renderToonDocument } from '../toon-output.js';
import { applyConfiguredProviderEnv, codeCurationOutput, commaIntegerFlag, intFlag, isIntegerText, mapContextModeFlag, numberFlag, openGraphStore, renderCodeDriftGroups, runCodeCurate, runCodeDrift, runExtract, runExtraction, runExtractionStatusViewer, runMap, runMapContext, runNeighbors, runPath, runPathExplain, runPathExplainViewer, runSearch, runTraverse, strFlag, stringFlag } from './extract-map.js';
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export async function runDocs(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  const registryOperation = registryCliOperationFor("docs", args.positional);
  if (
    registryOperation &&
    PROOF_REGISTRY_CLI_COMMANDS.has(registryOperation.renderer.cli.command)
  ) {
    return runRegistryCliOperation(registryOperation, args);
  }
  if (action === "bundle") return runDocsBundle(args);
  if (action === "bundle-viewer") return runDocsBundleViewer(args);
  if (action === "read") return runDocsRead(args);
  if (action === "evidence-pack") return runDocsEvidencePack(args);
  if (action === "evidence-pack-viewer") return runDocsEvidencePackViewer(args);
  if (action === "backlinks") return runDocsBacklinks(args);
  if (action === "backlinks-viewer") return runDocsBacklinksViewer(args);
  if (action === "related") return runDocsRelated(args);
  if (action === "related-viewer") return runDocsRelatedViewer(args);
  if (action === "restore") return runDocsRestore(args);
  if (action === "coverage") return runDocsCoverage(args);
  if (action === "coverage-viewer") return runDocsCoverageViewer(args);
  if (action === "reference-graph") return runDocsReferenceGraph(args);
  if (action === "reference-graph-viewer") return runDocsReferenceGraphViewer(args);
  if (action === "search-viewer") return runDocsSearchViewer(args);
  if (action !== "search") {
    throw new Error(
      "docs needs an action — supported: memory docs search <query>, memory docs search-viewer <query>, memory docs brief <query>, memory docs brief-viewer <query>, memory docs bundle <query>, memory docs bundle-viewer <query>, memory docs read <path|rid>, memory docs evidence-pack <path|rid>, memory docs evidence-pack-viewer <path|rid>, memory docs backlinks <label|rid>, memory docs backlinks-viewer <label|rid>, memory docs related <path|rid>, memory docs related-viewer <path|rid>, memory docs restore [path|rid], memory docs coverage, memory docs coverage-viewer, memory docs reference-graph, memory docs reference-graph-viewer",
    );
  }
  const query = args.positional.slice(1).join(" ").trim();
  if (!query) throw new Error("nothing to search — pass a query: memory docs search <query>");
  const { store } = await openGraphStore(args);
  try {
    const report = await searchDocs(store, query, { limit: intFlag(args.flags, "limit") });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory docs: ${report.hits.length}/${report.total_docs} hit(s) for "${query}"`);
    for (const hit of report.hits) {
      const title = hit.title ? ` — ${hit.title}` : "";
      console.log(`  [${hit.score}] ${hit.path}${title}`);
      console.log(`      fields: ${hit.matched_fields.join(", ")}`);
      if (hit.excerpt) console.log(`      ${hit.excerpt}`);
    }
  } finally {
    await store.close();
  }
}

export async function runRegistryCliOperation(
  operation: ReadOnlyMemoryOperation,
  args: ParsedArgs,
): Promise<void> {
  const rootDir = rootOf(args.flags);
  const commandParts = operation.renderer.cli.command.split(" ");
  const positional = args.positional.slice(commandParts.length - 1);
  const transportInput = {
    positional,
    flags: flagsForRegistryTransport(args),
    query: {},
    rootDir,
  };
  const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
  if (args.flags.local === true && operation.id.startsWith("memory.vector-")) {
    process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
  }
  const graphContext = operationNeedsGraphStore(operation)
    ? await openGraphStore(args)
    : { store: undefined as unknown as MemoryStore, config: undefined };
  try {
    const output = await executeMemoryOperationFromTransport(
      operation,
      {
        store: graphContext.store,
        rootDir,
        memoryConfig: graphContext.config,
        providerConfig: graphContext.config?.provider,
        transportSurface: "cli",
      },
      transportInput,
    );
    const jsonRequested =
      args.flags.json === true || operation.renderer.cli.defaultFormat === "json";
    if (operation.outputKind.kind === "viewer") {
      const presentation = operation.renderer.cli.presentation;
      if (jsonRequested && operation.renderer.cli.supportsJson) {
        const jsonOutput = presentation?.jsonOutput?.(output) ?? output;
        process.stdout.write(`${JSON.stringify(jsonOutput, null, 2)}\n`);
        return;
      }
      if (presentation?.viewerSink === "explicit" && args.flags.out === undefined) {
        process.stdout.write(presentation.render(output, transportInput));
        return;
      }
      const outPath = await writeViewerArtifact(operation, output, transportInput);
      process.stdout.write(viewerCliSummary(operation, output, outPath));
      return;
    }
    process.stdout.write(
      renderRegistryCliReport(
        operation,
        output,
        jsonRequested,
        transportInput,
      ),
    );
  } finally {
    if (operationNeedsGraphStore(operation)) await graphContext.store.close();
    if (args.flags.local === true && operation.id.startsWith("memory.vector-")) {
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
    }
  }
}

export function renderRegistryCliReport(
  operation: ReadOnlyMemoryOperation,
  output: unknown,
  jsonRequested: boolean,
  transportInput: Parameters<
    NonNullable<ReadOnlyMemoryOperation["renderer"]["cli"]["presentation"]>["render"]
  >[1] = { positional: [], flags: {}, query: {} },
): string {
  if (jsonRequested) return `${JSON.stringify(output, null, 2)}\n`;
  if (operation.outputKind.kind === "report" && operation.outputKind.format === "markdown") {
    if (typeof output === "string") return output;
    if (
      output !== null &&
      typeof output === "object" &&
      "markdown" in output &&
      typeof output.markdown === "string"
    ) {
      return output.markdown;
    }
    throw new Error(`${operation.id} declared markdown output without a markdown field`);
  }
  if (operation.renderer.cli.presentation) {
    return operation.renderer.cli.presentation.render(output, transportInput);
  }
  return renderToonDocument(output);
}

export function operationNeedsGraphStore(operation: ReadOnlyMemoryOperation): boolean {
  return !new Set([
    "memory.agent-integration-status",
    "memory.agent-integration-status-viewer",
    "memory.hook-coverage",
    "memory.hook-coverage-viewer",
    "memory.routing-guide",
    "memory.routing-guide-viewer",
  ]).has(operation.id);
}

export function flagsForRegistryTransport(args: ParsedArgs): Record<string, unknown> {
  const flags: Record<string, unknown> = {
    ...args.flags,
    ...(args.repeatedFlags ?? {}),
  };
  const operation = registryCliOperationFor(args.command, args.positional);
  if (
    operation &&
    ["memory.communities", "memory.communities-viewer", "memory.community-digest"].includes(
      operation.id,
    ) &&
    flags["no-cache"] !== true &&
    flags.cache === undefined
  ) {
    flags.cache = "read-write";
  }
  return flags;
}

export function registryCliOperationFor(
  command: string | undefined,
  positional: readonly string[],
): ReadOnlyMemoryOperation | undefined {
  if (!command) return undefined;
  for (const [registeredCommand, operation] of REGISTRY_CLI_OPERATIONS) {
    const parts = registeredCommand.split(" ");
    if (parts[0] !== command) continue;
    const rest = parts.slice(1);
    if (rest.length === 0) {
      if (operation.renderer.cli.reservedSubcommands?.includes(positional[0] ?? "")) continue;
      return operation;
    }
    if (rest.every((part, index) => positional[index] === part)) return operation;
  }
  return undefined;
}

export async function runAssets(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryAssetInventory(store, {
      kind: stringFlag(args.flags, "kind"),
      query: args.positional.join(" ").trim() || undefined,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory assets: ${report.total_assets} asset(s), ${formatAssetBytes(report.total_bytes)}`,
    );
    for (const kind of report.kinds) {
      console.log(`  ${kind.kind}: ${kind.count} asset(s), ${formatAssetBytes(kind.bytes)}`);
    }
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
    for (const asset of report.assets) {
      console.log(
        `  ${asset.path}: ${asset.asset_kind}, ${asset.media_type}, ${formatAssetBytes(asset.bytes)}`,
      );
    }
  } finally {
    await store.close();
  }
}

export async function runAssetsViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/asset-inventory-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryAssetInventory(store, {
      kind: stringFlag(args.flags, "kind"),
      query: args.positional.join(" ").trim() || undefined,
    });
    const artifact = buildMemoryAssetInventoryViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: asset inventory viewer written ${outPath}`);
    console.log(`  assets: ${report.total_assets}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export function formatAssetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export async function runDocsBundle(args: ParsedArgs): Promise<void> {
  const query = args.positional.slice(1).join(" ").trim();
  if (!query) throw new Error("nothing to bundle — pass a query: memory docs bundle <query>");
  const { store } = await openGraphStore(args);
  try {
    const bundle = await buildDocBundle(store, {
      query,
      limit: intFlag(args.flags, "limit"),
      max_bytes: intFlag(args.flags, "max-bytes"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(bundle, null, 2));
      return;
    }
    process.stdout.write(bundle.markdown);
  } finally {
    await store.close();
  }
}

export async function runDocsSearchViewer(args: ParsedArgs): Promise<void> {
  const query = args.positional.slice(1).join(" ").trim();
  if (!query) {
    throw new Error("nothing to render — pass a query: memory docs search-viewer <query>");
  }
  const rootDir = rootOf(args.flags);
  const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/doc-search-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await searchDocs(store, query, { limit: intFlag(args.flags, "limit") });
    const artifact = buildDocSearchViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc search viewer written ${outPath}`);
    console.log(`  hits: ${report.hits.length}/${report.total_docs}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsBundleViewer(args: ParsedArgs): Promise<void> {
  const query = args.positional.slice(1).join(" ").trim();
  if (!query) {
    throw new Error("nothing to render — pass a query: memory docs bundle-viewer <query>");
  }
  const rootDir = rootOf(args.flags);
  const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/doc-bundle-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const bundle = await buildDocBundle(store, {
      query,
      limit: intFlag(args.flags, "limit"),
      max_bytes: intFlag(args.flags, "max-bytes"),
    });
    const artifact = buildDocBundleViewerArtifact(bundle);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc bundle viewer written ${outPath}`);
    console.log(`  hits: ${bundle.hits.length}/${bundle.total_docs}`);
    console.log(`  packs: ${bundle.packs.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsCoverage(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocCoverageReport(store);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory docs coverage: ${report.grounded_docs}/${report.total_docs} grounded, ${report.docs_with_references} with references`,
    );
    console.log(
      `  vectors: ${report.vector.overall} (${report.vector.ready}/${report.vector.total} ready)`,
    );
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
    for (const doc of report.docs) {
      const title = doc.title ? ` — ${doc.title}` : "";
      console.log(
        `  ${doc.path}${title}: ${doc.graph_status}, refs=${doc.references.count}, vector=${doc.vector_status}`,
      );
    }
  } finally {
    await store.close();
  }
}

export async function runDocsCoverageViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/doc-coverage-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocCoverageReport(store);
    const artifact = buildDocCoverageViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc coverage viewer written ${outPath}`);
    console.log(`  docs: ${report.total_docs}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsReferenceGraph(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocReferenceGraphReport(store);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory docs reference-graph: ${report.reference_edges} edge(s), ${report.reference_nodes} referenced node(s), ${report.grounded_docs}/${report.total_docs} grounded docs`,
    );
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
    for (const ref of report.top_references.slice(0, 10)) {
      console.log(
        `  ${ref.node.title} (${ref.node.label}) referenced by ${ref.incoming_docs} doc(s)`,
      );
    }
  } finally {
    await store.close();
  }
}

export async function runDocsReferenceGraphViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/doc-reference-graph-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocReferenceGraphReport(store);
    const artifact = buildDocReferenceGraphViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc reference graph viewer written ${outPath}`);
    console.log(`  edges: ${report.reference_edges}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsRelated(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) throw new Error("nothing to relate — pass a path or rid: memory docs related <path|rid>");
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocRelatedReport(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { path: target }),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.found || !report.target) {
      console.log(`memory docs related: no document found for ${target}`);
      return;
    }
    console.log(
      `memory docs related: ${report.target.path ?? report.target.title} (${report.references.length} reference(s), ${report.related_docs.length} related doc(s))`,
    );
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
    for (const ref of report.references.slice(0, 10)) {
      console.log(`  ref: ${ref.title} (${ref.label})`);
    }
    for (const doc of report.related_docs.slice(0, 10)) {
      console.log(`  related: ${doc.path} (${doc.shared_references} shared reference(s))`);
    }
  } finally {
    await store.close();
  }
}

export async function runDocsBacklinks(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    throw new Error("nothing to trace — pass a label, title, or rid: memory docs backlinks <label|rid>");
  }
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocBacklinksReport(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { query: target }),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.found) {
      console.log(`memory docs backlinks: no referenced node found for ${target}`);
      for (const warning of report.warnings) console.log(`  warning: ${warning}`);
      return;
    }
    console.log(
      `memory docs backlinks: ${report.references.length} reference node(s), ${report.docs.length} doc(s) for ${target}`,
    );
    for (const warning of report.warnings) console.log(`  warning: ${warning}`);
    for (const ref of report.references.slice(0, 5)) {
      console.log(`  ref: ${ref.title} (${ref.label})`);
    }
    for (const doc of report.docs.slice(0, 10)) {
      console.log(`  doc: ${doc.path} (${doc.matched_references} matched reference(s))`);
    }
  } finally {
    await store.close();
  }
}

export async function runDocsBacklinksViewer(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    throw new Error(
      "nothing to render — pass a label, title, or rid: memory docs backlinks-viewer <label|rid>",
    );
  }
  const rootDir = rootOf(args.flags);
  const safeName = isIntegerText(target)
    ? `rid-${target}`
    : createHash("sha256").update(target).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/doc-backlinks-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocBacklinksReport(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { query: target }),
    });
    const artifact = buildDocBacklinksViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc backlinks viewer written ${outPath}`);
    console.log(`  found: ${report.found}`);
    console.log(`  docs: ${report.docs.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsRelatedViewer(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    throw new Error("nothing to render — pass a path or rid: memory docs related-viewer <path|rid>");
  }
  const rootDir = rootOf(args.flags);
  const safeName = isIntegerText(target)
    ? `rid-${target}`
    : createHash("sha256").update(target).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/doc-related-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildDocRelatedReport(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { path: target }),
    });
    const artifact = buildDocRelatedViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc related viewer written ${outPath}`);
    console.log(`  found: ${report.found}`);
    console.log(`  related: ${report.related_docs.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsRead(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) throw new Error("nothing to read — pass a path or rid: memory docs read <path|rid>");
  const { store } = await openGraphStore(args);
  try {
    const report = await readDoc(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { path: target }),
      max_bytes: intFlag(args.flags, "max-bytes"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    if (!report.found) {
      console.log(`memory docs: no document found for ${target}`);
      return;
    }
    const title = report.title ? ` — ${report.title}` : "";
    const suffix = report.truncated
      ? ` (truncated ${report.returned_bytes}/${report.body_bytes} bytes)`
      : "";
    console.log(`memory docs: ${report.path}${title}${suffix}`);
    if (report.body) process.stdout.write(`${report.body}\n`);
  } finally {
    await store.close();
  }
}

export async function runDocsEvidencePack(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    throw new Error(
      "nothing to pack — pass a path or rid: memory docs evidence-pack <path|rid>",
    );
  }
  const { store } = await openGraphStore(args);
  try {
    const pack = await buildDocEvidencePack(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { path: target }),
      max_bytes: intFlag(args.flags, "max-bytes"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }
    process.stdout.write(pack.markdown);
  } finally {
    await store.close();
  }
}

export async function runDocsEvidencePackViewer(args: ParsedArgs): Promise<void> {
  const target = args.positional.slice(1).join(" ").trim();
  if (!target) {
    throw new Error(
      "nothing to render — pass a path or rid: memory docs evidence-pack-viewer <path|rid>",
    );
  }
  const rootDir = rootOf(args.flags);
  const safeName = isIntegerText(target)
    ? `rid-${target}`
    : createHash("sha256").update(target).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ??
      join(rootDir, `.red/memory/doc-evidence-pack-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const pack = await buildDocEvidencePack(store, {
      ...(isIntegerText(target) ? { rid: Number(target) } : { path: target }),
      max_bytes: intFlag(args.flags, "max-bytes"),
    });
    const artifact = buildDocEvidencePackViewerArtifact(pack);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: doc evidence pack viewer written ${outPath}`);
    console.log(`  found: ${pack.found}`);
    console.log(`  references: ${pack.related.references.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

export async function runDocsRestore(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const target = args.positional.slice(1).join(" ").trim();
  const dryRun = args.flags["dry-run"] === true || args.flags.yes !== true;
  const { store } = await openGraphStore(args);
  try {
    const report = await restoreDocsFromMemory(store, {
      rootDir,
      ...(target
        ? isIntegerText(target)
          ? { targetRid: Number(target) }
          : { targetPath: target }
        : {}),
      outDir: stringFlag(args.flags, "out"),
      inPlace: args.flags["in-place"] === true,
      overwrite: args.flags.overwrite === true,
      dryRun,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const mode = report.dry_run ? "dry-run" : "restore";
    console.log(
      `memory docs ${mode}: ${report.summary.restored} restored, ${report.summary.planned} planned, ${report.summary.skipped} skipped, ${report.summary.missing} missing`,
    );
    if (report.dry_run) console.log("  pass --yes to write restored document files");
    for (const item of report.items) {
      const reason = item.reason ? ` (${item.reason})` : "";
      console.log(`  ${item.status}: ${item.source_path} -> ${item.destination_path}${reason}`);
    }
    for (const action of report.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

export async function runBackup(args: ParsedArgs): Promise<void> {
  const action = args.positional[0] ?? "create";
  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;

  if (action === "create") {
    await requireConfig(rootDir);
    const result = await createMemoryBackup(rootDir, { name: stringFlag(args.flags, "name") });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`memory: backup created ${result.manifest.name}`);
    console.log(`  dir: ${result.backup_dir}`);
    console.log(`  files: ${result.files} bytes=${result.bytes}`);
    for (const warning of result.manifest.warnings) console.log(`  warning: ${warning}`);
    return;
  }

  if (action === "list") {
    const backups = await listMemoryBackups(rootDir);
    if (json) {
      console.log(JSON.stringify({ schema_version: "memory.backup.list.v1", backups }, null, 2));
      return;
    }
    console.log(`memory backups: ${backups.length}`);
    for (const backup of backups) {
      console.log(
        `  ${backup.name} ${backup.mode} files=${backup.files} bytes=${backup.bytes} created=${backup.created_at}`,
      );
    }
    return;
  }

  if (action === "inspect") {
    const name = args.positional[1];
    if (!name) throw new Error("memory backup inspect needs a backup name");
    const manifest = await readMemoryBackupManifest(rootDir, name);
    if (json) {
      console.log(JSON.stringify(manifest, null, 2));
      return;
    }
    console.log(`memory backup: ${manifest.name}`);
    console.log(`  created: ${manifest.created_at}`);
    console.log(`  mode: ${manifest.mode}`);
    console.log(`  files: ${manifest.files.length}`);
    for (const file of manifest.files.slice(0, 20)) {
      console.log(`  ${file.path} ${file.bytes} ${file.sha256.slice(0, 12)}`);
    }
    if (manifest.files.length > 20) console.log(`  ... ${manifest.files.length - 20} more`);
    return;
  }

  if (action === "restore") {
    const name = args.positional[1];
    if (!name) throw new Error("memory backup restore needs a backup name");
    if (args.flags.yes !== true) {
      throw new Error("memory backup restore requires explicit --yes approval");
    }
    const result = await restoreMemoryBackup(rootDir, name);
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`memory: restored backup ${result.restored_from}`);
    console.log(`  restored: ${result.restored_files} files bytes=${result.restored_bytes}`);
    console.log(`  safety backup: ${result.safety_backup.manifest.name}`);
    for (const warning of result.warnings) console.log(`  warning: ${warning}`);
    return;
  }

  throw new Error("backup needs an action — supported: create, list, inspect, restore");
}

export async function runServe(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const host = stringFlag(args.flags, "host") ?? "127.0.0.1";
  const port = intFlag(args.flags, "port") ?? 49375;
  const tokenEnv = stringFlag(args.flags, "token-env");
  const token = tokenEnv ? process.env[tokenEnv] : undefined;
  if (tokenEnv && !token) throw new Error(`--token-env ${tokenEnv} is not set`);

  const { store, config } = await openGraphStore(args);
  const server = createMemoryHttpServer({
    rootDir,
    store,
    token,
    memoryConfig: config,
    providerConfig: config.provider,
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const address = server.address();
      const actualPort = typeof address === "object" && address ? address.port : port;
      console.log(`memory: serving read-only HTTP on http://${host}:${actualPort}/`);
      console.log(`  workbench: http://${host}:${actualPort}/workbench`);
      console.log(`  dashboard: http://${host}:${actualPort}/dashboard`);
      console.log(`  docs graph: http://${host}:${actualPort}/docs/reference-graph`);
      console.log(`  recall API: http://${host}:${actualPort}/api/recall?query=...`);
      console.log(`  auth: ${token ? `bearer token from ${tokenEnv}` : "none"}`);
    });

    const shutdown = () => {
      server.close(() => {
        store.close().finally(resolve);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}

export async function runHooks(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "coverage-viewer") return runHooksCoverageViewer(args);
  if (action !== "coverage") {
    throw new Error("hooks needs an action — supported: memory hooks coverage, memory hooks coverage-viewer");
  }
  const report = await buildHookCoverageReport(rootOf(args.flags));
  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `memory hooks coverage: ${report.summary.enabled_events}/${report.summary.total_events} enabled (${report.mode})`,
  );
  for (const runner of report.runners) {
    console.log(
      `  ${runner.runner}: ${runner.coverage.enabled}/${runner.coverage.total} enabled, ${runner.coverage.wired} wired`,
    );
    for (const event of runner.events) {
      const state = event.enabled ? "enabled" : event.wired ? "wired" : "missing";
      const matcher = event.matcher ? ` matcher=${event.matcher}` : "";
      console.log(`    ${event.event}: ${state}${matcher}`);
    }
  }
  for (const gap of report.gaps) console.log(`  gap: ${gap}`);
  for (const action of report.recommended_next_actions) console.log(`  next: ${action}`);
}

export async function runHooksCoverageViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/hook-coverage-viewer.html"),
  );
  const report = await buildHookCoverageReport(rootDir);
  const artifact = buildHookCoverageViewerArtifact(report);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  console.log(`memory: hook coverage viewer written ${outPath}`);
  console.log(`  effective: ${report.summary.effective_events}/${report.summary.total_events}`);
  console.log(`  contract: ${artifact.contract.consumes}`);
}

export async function runClaimCheck(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const assertion = args.positional.join(" ").trim();
  if (!assertion) {
    throw new Error("nothing to claim-check — pass an assertion: memory claim-check <assertion>");
  }
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `claim-check needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const result = await claimCheck(store, assertion);
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    printClaimCheck(result);
  } finally {
    await store.close();
  }
}

export function printClaimCheck(result: ClaimCheckResult): void {
  console.log(`memory claim-check: ${result.status}`);
  console.log(result.answer);
  console.log(`citations: ${result.citations.length}`);
  for (const item of [...result.evidence.active, ...result.evidence.superseded]) {
    const source = item.source ? ` source=${item.source}` : "";
    console.log(
      `  ${item.citation} memory_nodes:${item.rid} ${item.title} (${item.confidence}, ${item.status}${source})`,
    );
  }
  if (result.evidence.conflicting.length > 0) {
    console.log(`conflicting evidence: ${result.evidence.conflicting.length}`);
    for (const item of result.evidence.conflicting) {
      const reason = item.reason ? ` reason=${item.reason}` : "";
      console.log(`  ${item.from.citation} contradicts ${item.to.citation}${reason}`);
    }
  }
}
