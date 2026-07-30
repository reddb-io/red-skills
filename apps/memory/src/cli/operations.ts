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
import { parseChangedFiles, parseHubRankBy, parseRid, printConflicts, printPrePrReview, printPrePrSection, printReadinessEnvelope, printStructuralImpact, printTimeline, printTimelineToon, readChangedFiles, renderCommunitiesToon, renderHubReportToon, renderSuggestedQuestionsToon, runCommunities, runCommunitiesViewer, runCommunityDigest, runConfidence, runConflicts, runHubReport, runPrePrReview, runPrePrReviewViewer, runResolveConflict, runStructuralImpact, runStructuralImpactViewer, runSuggestedQuestions, runSupersede, runTimeline } from './graph-reports.js';
import type { TimelineToonEntry } from './graph-reports.js';

export async function runStats(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const stats = await store.stats();
    console.log(`memory: ${stats.nodes} node(s), ${stats.edges} edge(s)`);
  } finally {
    await store.close();
  }
}

export async function runVector(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action !== "status" && action !== "status-viewer" && action !== "maintain" && action !== "search") {
    throw new Error(
      "vector needs an action — supported: memory vector status|status-viewer|maintain|search",
    );
  }
  const previousProvider = process.env.RED_MEMORY_VECTOR_PROVIDER;
  if (args.flags.local === true) process.env.RED_MEMORY_VECTOR_PROVIDER = "local";
  const { store } = await openGraphStore(args);
  try {
    if (action === "search") {
      const query = args.positional.slice(1).join(" ").trim();
      if (!query) throw new Error("nothing to search — pass a query: memory vector search <query>");
      const report = await buildVectorSearchReport(store, query, {
        limit: intFlag(args.flags, "limit"),
      });
      if (args.flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      if (report.status === "unavailable") {
        const detail = report.error ? ` — ${report.error}` : "";
        console.log(`memory: vector search unavailable${detail}`);
        return;
      }
      console.log(
        `memory: vector search ${report.hits.length}/${report.limit} hit(s) for "${query}"`,
      );
      for (const hit of report.hits) {
        const source = hit.source ? ` source=${hit.source}` : "";
        console.log(
          `  ${hit.score.toFixed(3)} memory_nodes:${hit.rid} (${hit.node_type}) ${hit.title}${source}`,
        );
        if (hit.excerpt) console.log(`      ${hit.excerpt}`);
      }
      return;
    }

    if (action === "status-viewer") {
      const rootDir = rootOf(args.flags);
      const outPath =
        stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/vector-status-viewer.html");
      const artifact = buildVectorStatusViewerArtifact(await store.vectorStatus());
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, artifact.html, "utf8");
      console.log(`memory: vector status viewer written ${outPath}`);
      console.log(`  status: ${artifact.report.overall}`);
      console.log(`  contract: ${artifact.contract.consumes}`);
      return;
    }

    const report =
      action === "maintain"
        ? await store.maintainVectorProjection({ strict: args.flags.strict === true })
        : await store.vectorStatus();

    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(
      `memory: vector projection ${report.overall} — ${report.ready}/${report.total} ready`,
    );
    if (report.stale > 0) console.log(`  stale: ${report.stale}`);
    if (report.unavailable > 0) console.log(`  unavailable: ${report.unavailable}`);
    if (report.failed > 0) console.log(`  failed: ${report.failed}`);
    for (const node of report.nodes.filter((n) => n.status !== "ready")) {
      const detail = node.error ? ` — ${node.error}` : "";
      console.log(`  ${node.rid} (${node.node_type}) ${node.label}: ${node.status}${detail}`);
    }
    for (const doc of report.docs.filter((d) => d.status !== "ready")) {
      const detail = doc.error ? ` — ${doc.error}` : "";
      console.log(`  doc:${doc.rid} ${doc.path}: ${doc.status}${detail}`);
    }
  } finally {
    await store.close();
    if (args.flags.local === true) {
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
    }
  }
}

export async function runDoctor(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const staleDays = intFlag(args.flags, "stale-days") ?? 90;
    const report = await diagnose(store, { staleDays });
    if (report.stale.length === 0) {
      console.log(
        `memory: healthy — 0 of ${report.totalNodes} node(s) stale (unaccessed ${staleDays}+ days, never recalled)`,
      );
      return;
    }
    console.log(
      `memory: ${report.stale.length} of ${report.totalNodes} node(s) stale (unaccessed ${staleDays}+ days, never recalled):`,
    );
    for (const s of report.stale) {
      console.log(`  ${s.rid} (${s.node_type}) ${s.title} — ${s.ageDays}d idle`);
    }

    if (args.flags.prune !== true) {
      console.log(`\nRe-run with --prune to delete these (asks for confirmation first).`);
      return;
    }

    // Prune only after explicit confirmation. --yes skips the prompt for
    // non-interactive use; otherwise require a typed "yes" — never auto-delete.
    let confirmed = args.flags.yes === true;
    if (!confirmed) {
      if (!process.stdin.isTTY) {
        console.log(
          `\nrefusing to prune without confirmation — re-run with --yes in a non-interactive shell`,
        );
        return;
      }
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (
        await rl.question(`\nDelete ${report.stale.length} stale node(s)? Type "yes" to confirm: `)
      ).trim();
      rl.close();
      confirmed = answer === "yes";
    }
    if (!confirmed) {
      console.log("memory: aborted — nothing deleted");
      return;
    }
    const { pruned } = await prune(store, report.stale);
    console.log(`memory: pruned ${pruned} stale node(s)`);
  } finally {
    await store.close();
  }
}

export async function runExport(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const target = args.positional[0] ?? ".red/memory/export";
  const outDir = isAbsolute(target) ? target : resolve(rootDir, target);
  const communities = args.flags.communities === true;
  const interop = args.flags.interop === true;
  const { store } = await openGraphStore(args);
  try {
    const result = await exportGraph(store, outDir, { communities, interop });
    console.log(`memory: exported ${result.nodes} node(s), ${result.edges} edge(s)`);
    if (communities) console.log(`  communities: coloured via native Louvain`);
    console.log(`  graph:  ${result.htmlPath}`);
    console.log(`  json:   ${result.jsonPath}`);
    console.log(`  audit:  ${result.auditPath}`);
    if (result.interop) {
      console.log(`  nodes:  ${result.interop.nodesJsonlPath}`);
      console.log(`  edges:  ${result.interop.edgesJsonlPath}`);
      console.log(`  graphml:${result.interop.graphmlPath}`);
      console.log(`  cypher: ${result.interop.cypherPath}`);
    }
  } finally {
    await store.close();
  }
}

export async function runGlobalSearch(args: ParsedArgs): Promise<void> {
  const query = args.positional.join(" ").trim();
  if (!query) {
    throw new Error("nothing to search — pass a query: memory global-search <query>");
  }
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : undefined;
  const { store, config } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation(
      "memory.global-search",
      { store, providerConfig: config.provider },
      {
        query,
        limit,
        cache: args.flags["no-cache"] === true ? "off" : "read-only",
      },
    )) as MemoryGlobalSearchReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory: ${report.total_hits} global-search hit(s) for "${report.query}"`);
    console.log(`  source: ${report.generated_from.operation_id}`);
    console.log(`  graph hash: ${report.generated_from.graph_hash}`);
    console.log(
      `  provider: ${report.generated_from.provider.status}${
        report.generated_from.provider.error
          ? ` (${report.generated_from.provider.error})`
          : ""
      }`,
    );
    for (const item of report.evidence) {
      console.log(`  ${item.community_id}: score ${item.score}, ${item.size} node(s)`);
      console.log(`        matched: ${item.matched_terms.join(", ")}`);
      console.log(`        top label: ${item.top_label}`);
      console.log(`        top type: ${item.top_node_type}`);
      if (item.narrative_summary) {
        console.log(`        summary: ${item.narrative_summary}`);
      }
    }
  } finally {
    await store.close();
  }
}

export /**
 * Resolve the graph contract for the architecture overview. Prefers an existing
 * `graph.json` (`--from`) so the overview is provably built from the #234
 * contract; otherwise builds the same contract from the store (with native
 * community detection, since the overview summarises communities).
 */
async function resolveOverviewContract(
  args: ParsedArgs,
  rootDir: string,
): Promise<GraphContract> {
  const from = stringFlag(args.flags, "from");
  if (from) {
    const path = isAbsolute(from) ? from : resolve(rootDir, from);
    const raw = JSON.parse(await readFile(path, "utf8")) as { contract?: unknown };
    const contract = raw.contract ?? raw;
    const validation = validateGraphContract(contract);
    if (!validation.valid) {
      throw new Error(
        `architecture-overview: ${path} is not a valid graph contract — ${validation.errors.join("; ")}`,
      );
    }
    return contract as GraphContract;
  }

  const { store } = await openGraphStore(args);
  try {
    const [nodes, rawEdges, communities] = await Promise.all([
      store.listNodes(),
      store.listEdges(),
      store.communities(),
    ]);
    return buildGraphContract({ nodes, edges: rawEdges.map(toEdge), communities });
  } finally {
    await store.close();
  }
}

export async function runArchitectureOverview(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const contract = await resolveOverviewContract(args, rootDir);
  const overview = buildArchitectureOverview(contract);

  if (args.flags.json === true) {
    console.log(JSON.stringify(overview, null, 2));
    return;
  }
  if (args.flags.stdout === true) {
    process.stdout.write(overview.markdown);
    return;
  }

  const target = stringFlag(args.flags, "out") ?? ".red/memory/architecture-overview.md";
  const outPath = isAbsolute(target) ? target : resolve(rootDir, target);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, overview.markdown, "utf8");
  console.log(`memory: architecture overview written ${outPath}`);
  console.log(`  contract: ${overview.generated_from.contract_version}`);
  console.log(
    `  ${overview.totals.nodes} node(s), ${overview.layers.length} layer(s), ${overview.communities.length} community(ies)`,
  );
}

export /** Read all of stdin (the runner's hook payload) into a string. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "PostToolUse", "Stop", "PreCompact"];

export /**
 * The hook entrypoint the plugin manifests wire to. Reads the runner's JSON
 * payload from stdin, dispatches the gated handler, and prints the runner's
 * output shape. Designed to never break a turn: any failure (bad JSON, store
 * error, unknown event) prints `{}` and exits 0, so a misconfigured or
 * uninitialized repo is silent.
 */
async function runHook(args: ParsedArgs): Promise<void> {
  const event = args.positional[0] as HookEvent | undefined;
  const runner: Runner = args.flags.runner === "codex" ? "codex" : "claude";
  if (!event || !HOOK_EVENTS.includes(event)) {
    process.stdout.write("{}");
    return;
  }
  try {
    const raw = await readStdin();
    const payload = (raw.trim() ? JSON.parse(raw) : {}) as RawPayload;
    const rootDir =
      rootOf(args.flags) !== process.cwd()
        ? rootOf(args.flags)
        : typeof payload.cwd === "string"
          ? payload.cwd
          : process.cwd();
    const input = await parseInput(runner, event, payload);
    // Lifecycle session minting (issue #176). SessionStart always (re)mints —
    // a fresh harness session gets a fresh id, ungated by config.hooks so even
    // markdown-only repos with a wired manifest get an inspectable session
    // file. Every other event ensures one exists, which covers the Codex /
    // no-hook fallback: the first MCP/CLI call mints when SessionStart never
    // fired. Failures here must not break the hook — swallow silently.
    try {
      if (event === "SessionStart") {
        await sessionStart(rootDir, input.sessionId ? { id: input.sessionId } : {});
      } else if (!(await sessionCurrent(rootDir))) {
        if (input.sessionId) {
          await sessionStart(rootDir, { id: input.sessionId });
        } else {
          await sessionEnsure(rootDir);
        }
      }
    } catch {
      // session file is best-effort; never abort the turn.
    }
    const result = await dispatch(input, rootDir);
    process.stdout.write(formatOutput(runner, event, result));
  } catch {
    // A hook must never abort the agent's turn — fail open, silently.
    process.stdout.write("{}");
  }
}

export const VCS_EVENTS: readonly VcsEvent[] = ["post-commit", "post-checkout"];

export /**
 * `memory vcs <refresh|install-hooks|uninstall-hooks>` — the git-side
 * auto-update surface (issue #236). `refresh` is what the installed git hooks
 * call; it MUST fail open (always exit 0, never throw) so a misconfigured or
 * uninitialized repo can never break `git commit` / `git checkout`.
 */
async function runVcs(args: ParsedArgs): Promise<void> {
  const sub = args.positional[0];
  switch (sub) {
    case "refresh":
      return runVcsRefresh(args);
    case "install-hooks":
      return runVcsInstallHooks(args);
    case "uninstall-hooks":
      return runVcsUninstallHooks(args);
    default:
      throw new Error(
        "vcs needs a subcommand — memory vcs refresh|install-hooks|uninstall-hooks",
      );
  }
}

export async function runVcsRefresh(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const event = stringFlag(args.flags, "event") as VcsEvent | undefined;
  const json = args.flags.json === true;
  if (!event || !VCS_EVENTS.includes(event)) {
    // Unknown invocation: stay silent and exit 0 — never break the git op.
    if (json) console.log(JSON.stringify({ noop: true, reason: "unknown vcs event" }));
    return;
  }
  try {
    const result = await refreshFromGit(rootDir, {
      event,
      prevHead: stringFlag(args.flags, "prev"),
      newHead: stringFlag(args.flags, "new"),
      flag: stringFlag(args.flags, "flag"),
      export: args.flags["no-export"] !== true,
    });
    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (result.noop) {
      console.log(`memory: ${event} — no-op (${result.reason})`);
      return;
    }
    const r = result.refresh;
    console.log(
      `memory: ${event} refreshed ${r?.files ?? 0} changed file(s) — ${r?.added ?? 0} added, ${r?.updated ?? 0} updated, ${r?.stale ?? 0} stale`,
    );
    if (result.exported) {
      console.log(`  exported ${result.exported.nodes} node(s) → ${result.exported.jsonPath}`);
    }
  } catch (err) {
    // Fail open: a git hook must never abort the user's commit/checkout.
    const reason = `error: ${err instanceof Error ? err.message : String(err)}`;
    if (json) {
      console.log(JSON.stringify({ noop: true, reason }));
    } else {
      console.log(`memory: ${event} — no-op (${reason})`);
    }
  }
}

export /** Resolve the repo's git hooks directory, falling back to `<root>/.git/hooks`. */
async function resolveHooksDir(rootDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", rootDir, "rev-parse", "--git-path", "hooks"], {
      encoding: "utf8",
    });
    const rel = stdout.trim();
    return rel ? (isAbsolute(rel) ? rel : resolve(rootDir, rel)) : resolve(rootDir, ".git/hooks");
  } catch {
    return resolve(rootDir, ".git/hooks");
  }
}

/** Best-effort path to the plugin's bootstrap.mjs, embedded in installed hooks. */
export function resolveBootstrapPath(): string | undefined {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT;
  const cliBarrelPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const candidates = [
    root ? join(root, "scripts", "bootstrap.mjs") : undefined,
    // Dev/source layout: the executable barrel is <pluginRoot>/src/cli.ts.
    join(dirname(dirname(cliBarrelPath)), "scripts", "bootstrap.mjs"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

export async function runVcsInstallHooks(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await readConfig(rootDir);
  if (!config) {
    console.log(
      "memory: not initialized here — run `memory init --mode graph` before installing git hooks",
    );
    return;
  }
  if (config.mode !== "graph") {
    console.log(
      `memory: git hooks need graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
    return;
  }
  const hooksDir = await resolveHooksDir(rootDir);
  const result = await installGitHooks({
    hooksDir,
    bootstrapPath: resolveBootstrapPath(),
    force: args.flags.force === true,
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify({ hooksDir, ...result }, null, 2));
    return;
  }
  if (result.installed.length > 0) {
    console.log(`memory: installed ${result.installed.join(", ")} into ${hooksDir}`);
  }
  for (const b of result.backedUp) console.log(`  backed up existing hook → ${b}`);
  for (const s of result.skipped) console.log(`  skipped ${s.hook}: ${s.reason}`);
}

export async function runVcsUninstallHooks(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const hooksDir = await resolveHooksDir(rootDir);
  const result = await uninstallGitHooks(hooksDir);
  if (args.flags.json === true) {
    console.log(JSON.stringify({ hooksDir, ...result }, null, 2));
    return;
  }
  if (result.removed.length > 0) {
    console.log(`memory: removed ${result.removed.join(", ")} from ${hooksDir}`);
  } else {
    console.log(`memory: no managed hooks found in ${hooksDir}`);
  }
  for (const r of result.restored) console.log(`  restored backed-up hook → ${r}`);
  for (const s of result.skipped) console.log(`  ${s.reason}`);
}

export async function runWorker(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0];
  if (subcommand === "learn") {
    return runWorkerLearn(args);
  }
  if (subcommand !== "record") {
    throw new Error("unknown worker command — expected: memory worker record|learn");
  }

  const raw = await readStdin();
  if (!raw.trim()) throw new Error("worker record needs a JSON payload on stdin");
  const payload = JSON.parse(raw) as ReasoningWorkerPayload;

  const { store } = await openGraphStore(args);
  try {
    const receipt = await recordReasoningWorker(store, payload);
    console.log(
      `memory: recorded worker ${payload.repository}#${payload.issueNumber}/${payload.attemptNumber} (rid ${receipt.workerRid})`,
    );
  } finally {
    await store.close();
  }
}

export async function runWorkerLearn(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  if (action === "apply") return runWorkerLearnApply(args);
  if (action != null) throw new Error("memory worker learn supports: apply");

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const writeProposal = args.flags["write-proposal"] === true;
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWorkerLearningReport(store);
    const proposalFile = writeProposal
      ? await writeWorkerLearningProposalFile(rootDir, report)
      : null;
    const state =
      report.proposals.length === 0
        ? "no-candidates"
        : writeProposal
          ? "proposal-written"
          : "proposal-ready";
    if (json) {
      console.log(JSON.stringify({ state, proposalFile, ...report }, null, 2));
      return;
    }
    console.log(`memory: worker learning - ${state}`);
    for (const proposal of report.proposals) {
      console.log(`  [${proposal.kind}] ${proposal.title}`);
      console.log(`    evidence: ${proposal.evidenceSummary}`);
    }
    for (const rejected of report.rejected) {
      console.log(`  ${rejected.action}: ${rejected.kind} - ${rejected.reason}`);
    }
    if (proposalFile) console.log(`  proposal: ${proposalFile}`);
    console.log("\nProposal-gated: durable Memory was not mutated. Review and apply with --yes.");
  } finally {
    await store.close();
  }
}

export async function runWorkerLearnApply(args: ParsedArgs): Promise<void> {
  const proposalArg = args.positional[2];
  if (!proposalArg) throw new Error("memory worker learn apply needs a proposal file");
  if (args.flags.yes !== true) {
    throw new Error("memory worker learn apply requires explicit --yes approval");
  }

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposalPath = resolve(rootDir, proposalArg);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  assertInsideProposalTree(rootDir, proposalPath);
  const body = await readFile(proposalPath, "utf8");
  const report = parseWorkerLearningProposal(body);
  const { store } = await openGraphStore(args);
  try {
    const result = await applyWorkerLearningProposal(store, report);
    const output = {
      state: "applied",
      proposal: toPosix(relative(rootDir, proposalPath)),
      ...result,
    };
    if (json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`memory: applied worker learning proposal ${output.proposal}`);
    console.log(`  learned nodes: ${result.applied}`);
  } finally {
    await store.close();
  }
}

export async function runImport(args: ParsedArgs): Promise<void> {
  const source = args.positional[0];
  const file = args.positional[1];
  if (!file) {
    throw new Error("usage: memory import ams <dump.json> | memory import map <artifact.json>");
  }
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    if (source === "map") {
      const report = await importComplementaryMapFile(store, file, {
        rootDir,
        sourceKind: parseComplementaryMapKind(stringFlag(args.flags, "kind")),
        command: "memory import map",
      });
      if (args.flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `memory import map: ${report.source_kind} nodes=${report.nodes.imported} imported/${report.nodes.overlapped} overlapped edges=${report.edges.imported} imported/${report.edges.overlapped} overlapped`,
      );
      console.log(`  destination: ${report.destination}`);
      for (const warning of report.warnings.slice(0, 5)) console.log(`  warning: ${warning}`);
      return;
    }
    if (source !== "ams") {
      throw new Error(
        `usage: memory import ams <dump.json> | memory import map <artifact.json> [--kind graphify|scip|lsp|static-analysis]`,
      );
    }
    const report = await importAmsDump(store, rootDir, file);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory import ams: working_memory sessions=${report.working.sessions.length} events=${report.working.events} transcripts=${report.working.transcripts}`,
    );
    console.log(
      `memory import ams: long_term_memory promoted=${report.long_term.promoted} reinforced=${report.long_term.reinforced} skipped=${report.long_term.skipped}`,
    );
  } finally {
    await store.close();
  }
}

export function parseComplementaryMapKind(
  value: string | undefined,
): ComplementaryMapSourceKind | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "graphify" ||
    normalized === "scip" ||
    normalized === "lsp" ||
    normalized === "static-analysis"
  ) {
    return normalized;
  }
  throw new Error(`invalid complementary map kind "${value}"`);
}

export async function runPromoteCmd(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const json = Boolean(args.flags.json);
  const triggeredByFlag = stringFlag(args.flags, "triggered-by");
  const triggeredBy =
    triggeredByFlag === "hook" || triggeredByFlag === "overflow"
      ? triggeredByFlag
      : "explicit";
  const { store } = await openGraphStore(args);
  try {
    const report = await runPromote(store, rootDir, {
      triggeredBy,
      sessionId: stringFlag(args.flags, "session"),
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory: promoted=${report.promoted} reinforced=${report.reinforced} skipped=${report.skipped} (session=${report.session_id})`,
    );
    for (const rid of report.promoted_rids) console.log(`  +promote rid=${rid}`);
    for (const rid of report.reinforced_rids) console.log(`  ~reinforce rid=${rid}`);
  } finally {
    await store.close();
  }
}

export async function runAfkFinalize(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const json = Boolean(args.flags.json);
  const worktreeId =
    stringFlag(args.flags, "worktree") ??
    process.env.RED_AFK_WORKER_ID ??
    process.env.RED_AFK_ITER_DIR;
  if (!worktreeId) {
    throw new Error(
      "memory afk-finalize: --worktree <id> required (or set RED_AFK_WORKER_ID)",
    );
  }
  const sessionId = stringFlag(args.flags, "session");
  const { store } = await openGraphStore(args);
  try {
    const report = await runAfkLifecycle(store, rootDir, {
      worktreeId,
      sessionId,
    });
    if (json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory afk-finalize: session=${report.session_id} worktree=${report.worktree_id} promoted=${report.promote.promoted} reinforced=${report.promote.reinforced} transcript=${report.transcript_rid ?? "none"}${report.transcript_created ? " (new)" : report.transcript_rid ? " (deduped)" : ""} dropped=${report.dropped_rids.length}`,
    );
  } finally {
    await store.close();
  }
}
