import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
import { approveLinkedEvidenceCard, collectEvidenceFlagValues, CONFIDENCE_VALUES, escapeRegExp, evidenceCardInputFromFlags, evidenceProposalApplyStateFlag, execFileAsync, findLinkedEvidenceCard, firstNestedYamlScalar, firstYamlScalar, formatInboxProvenance, isInboxStatus, isRecord, LEGACY_CLI_OPERATION_IDS, LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND, markProposalEvidenceRejected, MEMORY_LAYERS, MEMORY_SCOPES, parseConfidence, parseEvidenceCitation, parseEvidenceStatusFilter, parseInboxStatusFilter, parseLayerFlag, parseMemoryScope, parseSourceKind, printCommitResult, printEvidenceCard, printEvidenceList, printEvidenceResult, printGovernedWriteResult, printInboxItem, printInboxList, printInboxResult, printLinkedEvidenceResult, PROOF_REGISTRY_CLI_COMMANDS, REGISTRY_CLI_OPERATIONS, rejectLinkedEvidenceCard, requireConfig, rootOf, runCommit, runEvidence, runInbox, runInit, runProvenance, runStore, runStoreEvidence, scopeContext, scopeFlags, SOURCE_KINDS, unquoteYamlScalar, USAGE, withLinkedEvidenceReview } from './core.js';
import type { LinkedEvidenceReviewResult, ParsedArgs } from './core.js';
import { asGraphRecallResult, capsuleSourceFlag, formatVectorRecallDiagnostic, printContextPackToon, printDashboardToon, printLegacyGraphRecall, printLegacyMarkdownRecall, printRecallToon, runAutocure, runCapsule, runClassify, runContextPack, runContextPackViewer, runDashboard, runFederate, runPreflight, runReadiness, runReadinessViewer, runReasoningReplay, runRecall, runRecommend, runSmartSearch, runSmartSearchViewer, runWhatif } from './recall.js';
import type { ContextPackToonEntry, DashboardToonSection, RecallToonItem } from './recall.js';
import { currentGitCommit, graphStateMetadata, printRoutingGuide, publicFindingDiagnostic, publicSafeRefusalMessage, routingAgentFlag, runAgentIntegrationStatus, runAgentIntegrationStatusViewer, runAsk, runCapabilities, runHandoff, runHandoffViewer, runLearningDebt, runLearningDebtViewer, runMemoryDecay, runMemoryDecayViewer, runMemoryLayers, runMemoryLayersViewer, runMemoryMergePass, runMemoryMergePassExecute, runMemoryMergePassUnmerge, runOnboardingMap, runOnboardingMapExport, runOnboardingMapViewer, runReferenceRadar, runRoutingGuide, runRoutingGuideViewer, runSession, runSessionEnd, runSessionShow, runSessionStart, runTidyReview, runTidyReviewAccept, runTidyReviewDismiss, runTidyReviewRefresh, runWorkbench, runWorkFrontier, runWorkFrontierViewer, runWorking } from './reports.js';
import type { OnboardingMapExportShape, PublicCodebaseMapMetadata } from './reports.js';
import { flagsForRegistryTransport, formatAssetBytes, operationNeedsGraphStore, printClaimCheck, registryCliOperationFor, runAssets, runAssetsViewer, runBackup, runClaimCheck, runDocs, runDocsBacklinks, runDocsBacklinksViewer, runDocsBundle, runDocsBundleViewer, runDocsCoverage, runDocsCoverageViewer, runDocsEvidencePack, runDocsEvidencePackViewer, runDocsRead, runDocsReferenceGraph, runDocsReferenceGraphViewer, runDocsRelated, runDocsRelatedViewer, runDocsRestore, runDocsSearchViewer, runHooks, runHooksCoverageViewer, runRegistryCliOperation, runServe } from './docs.js';
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

export async function runIngest(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const target = args.positional[0] ?? ".";
  const config = await requireConfig(rootDir);

  if (config.mode !== "graph") {
    throw new Error(
      `ingest needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const cwd = isAbsolute(target) ? target : resolve(rootDir, target);
  const maxFiles =
    typeof args.flags["max-files"] === "string"
      ? Number(args.flags["max-files"])
      : undefined;
  const structuralOnly = args.flags["structural-only"] === true;

  // Pre-ingest scope wizard (#235): pick a preset, report the candidate count
  // before processing, and optionally generate the committed `.memoryignore`.
  const preset = resolvePreset(typeof args.flags.scope === "string" ? args.flags.scope : undefined);

  if (preset.name === "generate-ignore") {
    const path = await writeMemoryIgnore(cwd, defaultIgnorePatterns());
    console.log(`memory: wrote ${path}`);
    console.log("  edit and commit it; subsequent ingests honour it without re-prompting.");
    return;
  }

  const candidateFiles = await collectCandidates({ cwd });
  const memoryIgnore = await readMemoryIgnore(cwd);
  console.log(formatScopeReport(planScope(candidateFiles, preset.name, memoryIgnore)));

  const semanticProvider = !structuralOnly && config.provider ? resolveProvider(config.provider) : null;
  if (semanticProvider && config.provider) applyProviderEnv(semanticProvider, config.provider.apiKeyEnv);

  if (!semanticProvider && shouldUseResidentMemory(rootDir, config)) {
    let residentReport: Awaited<ReturnType<typeof ingestProject>> | null = null;
    try {
      residentReport = await residentMemoryRequest(rootDir, config, "ingest", {
        cwd,
        maxFiles,
        ignore: preset.ignore,
      }) as Awaited<ReturnType<typeof ingestProject>>;
    } catch {
      // Fail open: keep the legacy embedded ingest path available if the
      // resident cannot come up in this environment.
    }
    if (residentReport) {
      console.log(
        renderIngestReportToon(residentReport, {
          includeSemanticCost: false,
        }),
      );
      console.log(ingestGuidance(await currentGitCommit(rootDir)));
      return;
    }
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await ingestProject(store, {
      cwd,
      maxFiles,
      ignore: preset.ignore,
      semantic: {
        enabled: Boolean(semanticProvider),
        client: semanticProvider && config.provider ? redDbProviderClient(store, config.provider) : undefined,
      },
    });
    console.log(
      renderIngestReportToon(report, {
        includeSemanticCost: Boolean(semanticProvider),
      }),
    );
    // Audit-marker contract (.red/agents/memory.md): commit-trailer surface.
    // Emit guidance for the commit that lands this ingest rather than writing
    // an on-disk log. Best-effort — never let HEAD lookup abort the ingest.
    console.log(ingestGuidance(await currentGitCommit(rootDir)));
  } finally {
    await store.close();
  }
}

export /**
 * PR-level CI drift guard (ADR 0027 Gap 3, issue #224). Reuses the pure
 * {@link evaluateDriftGuard} decision core over inputs collected from git / the
 * workflow. On failure it prints the documented actionable line, best-effort
 * appends a `memory.drift.caught` event to the Memory event log (ADR 0025), and
 * sets a non-zero exit code. Code-only PRs (no watched path changed) pass
 * silently with no telemetry event.
 */
async function runDriftGuard(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);

  const changedFiles = await driftGuardChangedFiles(rootDir, args);
  const headCommitMessage = await driftGuardHeadMessage(rootDir, args);
  const auditLogLines = await driftGuardAuditLog(rootDir);

  const verdict = evaluateDriftGuard({ changedFiles, headCommitMessage, auditLogLines });

  if (args.flags.json === true) {
    console.log(JSON.stringify(verdict, null, 2));
  }

  if (verdict.status === "pass") {
    if (args.flags.json !== true) {
      if (verdict.reason === "no-watched-paths") {
        console.log("memory drift-guard: no watched paths changed — pass");
      } else {
        console.log(
          `memory drift-guard: audit marker present (${verdict.marker.form}) — pass`,
        );
      }
    }
    return;
  }

  // Failure: emit the actionable line, record the telemetry event, exit non-zero.
  console.error(verdict.actionableLine);

  const event = driftCaughtToMemoryEvent({
    changedPaths: verdict.watchedChanged,
    reason: verdict.actionableLine,
    prNumber: typeof args.flags["pr-number"] === "string" ? args.flags["pr-number"] : undefined,
    headSha: typeof args.flags["head-sha"] === "string" ? args.flags["head-sha"] : undefined,
    baseRef: typeof args.flags["base-ref"] === "string" ? args.flags["base-ref"] : undefined,
  });
  // The envelope is always emitted so CI logs carry the ADR 0025 event even when
  // no local graph store exists (the Action runs against a fresh checkout).
  console.log(JSON.stringify(event));
  // Best-effort append to the local event log when graph mode is initialized —
  // never let a telemetry write turn a guard failure into a crash (issue #181).
  await driftGuardRecordEvent(rootDir, event);

  process.exitCode = 1;
}

export /** Resolve the PR's changed files: an explicit `--changed-files <path>` list, or a `git diff` against `--base`. */
async function driftGuardChangedFiles(rootDir: string, args: ParsedArgs): Promise<string[]> {
  const listPath = args.flags["changed-files"];
  if (typeof listPath === "string") {
    const resolved = isAbsolute(listPath) ? listPath : resolve(rootDir, listPath);
    const body = await readFile(resolved, "utf8");
    return body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  }
  const base = args.flags.base;
  if (typeof base === "string") {
    const { stdout } = await execFileAsync("git", ["diff", "--name-only", `${base}...HEAD`], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "");
  }
  throw new Error(
    "drift-guard needs the PR's changed files — pass --changed-files <path> or --base <ref>",
  );
}

export /** Resolve the head commit message: an explicit `--head-message <path>`, or `git log -1` at HEAD. */
async function driftGuardHeadMessage(rootDir: string, args: ParsedArgs): Promise<string | undefined> {
  const msgPath = args.flags["head-message"];
  if (typeof msgPath === "string") {
    const resolved = isAbsolute(msgPath) ? msgPath : resolve(rootDir, msgPath);
    return readFile(resolved, "utf8");
  }
  try {
    const { stdout } = await execFileAsync("git", ["log", "-1", "--format=%B"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return undefined;
  }
}

export /** Read `.red/memory/.audit.log` lines if the project maintains that surface; absent is fine. */
async function driftGuardAuditLog(rootDir: string): Promise<string[] | undefined> {
  try {
    const body = await readFile(join(rootDir, ".red/memory/.audit.log"), "utf8");
    return body.split(/\r?\n/);
  } catch {
    return undefined;
  }
}

export /** Best-effort append of the drift event to the local Memory event log. Swallows all failure. */
async function driftGuardRecordEvent(
  rootDir: string,
  event: ReturnType<typeof driftCaughtToMemoryEvent>,
): Promise<void> {
  try {
    const config = await readConfig(rootDir);
    if (!config || config.mode !== "graph") return;
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      await appendMemoryEvent(store, event);
    } finally {
      await store.close();
    }
  } catch {
    // Telemetry is best-effort — a missing/locked store must not change the verdict.
  }
}

export async function runBootstrap(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `bootstrap needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await bootstrapProjectMemory(store, {
      rootDir,
      dryRun: args.flags["dry-run"] === true,
      maxFiles: intFlag(args.flags, "max-files"),
      includeGitLog: args.flags["include-git-log"] === true,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const mode = report.dry_run ? "planned" : "indexed";
    console.log(
      `memory bootstrap: ${mode} ${report.summary.indexed_sources}/${report.summary.discovered_sources} source(s)`,
    );
    console.log(
      `  ${report.summary.nodes} node(s), ${report.summary.edges} edge(s), ${report.summary.docs} doc(s)`,
    );
    for (const source of report.sources.slice(0, 20)) {
      const status = source.indexed ? "indexed" : "skipped";
      const reason = source.reason ? ` (${source.reason})` : "";
      console.log(`  ${status}: ${source.kind} ${source.path}${reason}`);
    }
    for (const action of report.recommended_next_actions) {
      console.log(`  next: ${action}`);
    }
  } finally {
    await store.close();
  }
}

export async function runRefresh(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `refresh needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const paths = await refreshPaths(rootDir, args);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  let report;
  try {
    report = await refreshFiles(store, paths, { rootDir });
  } finally {
    await store.close();
  }

  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(`memory: refreshed ${report.files} changed file(s)`);
  console.log(
    `  ${report.added} added, ${report.updated} updated, ${report.skipped} skipped, ${report.stale} stale graph element(s) in ${report.durationMs}ms`,
  );
}

export async function refreshPaths(rootDir: string, args: ParsedArgs): Promise<string[]> {
  const paths = [...args.positional];
  const hasRefreshSource =
    paths.length > 0 ||
    args.flags.stdin === true ||
    args.flags.staged === true ||
    args.flags.changed === true;
  if (args.flags.stdin === true) {
    paths.push(...splitPathList(await readStdin()));
  }
  if (args.flags.staged === true) {
    paths.push(...(await gitDiffPaths(rootDir, "staged")));
  }
  if (args.flags.changed === true) {
    paths.push(...(await gitDiffPaths(rootDir, "changed")));
  }
  if (!hasRefreshSource) {
    throw new Error(
      "refresh needs changed files — pass paths, --stdin, --staged, or --changed",
    );
  }
  return [...new Set(paths)];
}

export function splitPathList(input: string): string[] {
  return input
    .split(/\0|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export async function gitDiffPaths(rootDir: string, mode: "changed" | "staged"): Promise<string[]> {
  const diffArgs = [
    "-C",
    rootDir,
    "diff",
    "--name-only",
    "--diff-filter=ACMRTUXBD",
    ...(mode === "staged" ? ["--cached"] : ["HEAD"]),
  ];
  const { stdout } = await execFileAsync("git", diffArgs, { encoding: "utf8" });
  return splitPathList(stdout);
}

export async function runSkillEvent(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind !== "skill") {
    throw new Error("event needs a kind — supported: memory event skill");
  }

  const rootDir = rootOf(args.flags);
  const config = await readConfig(rootDir);
  if (!config) {
    console.log("memory: skill event ignored — memory is not initialized here");
    return;
  }
  if (config.mode !== "graph") {
    console.log(
      `memory: skill event ignored — needs graph mode, this project is "${config.mode}"`,
    );
    return;
  }
  if (!skillTelemetryEnabled(config)) {
    console.log(
      "memory: skill event ignored — skill telemetry is not enabled, re-run `memory init --mode graph --skill-telemetry`",
    );
    return;
  }

  const raw = await readStdin();
  const events = raw.trim()
    ? parseSkillEventInput(raw)
    : [parseSkillEvent(skillEventFromFlags(args.flags))];

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await ingestSkillEvents(store, events);
    console.log(`memory: ingested ${report.events} ${plural(report.events, "skill event")}`);
  } finally {
    await store.close();
  }
}

export /**
 * memory curate skills — the report-only Skill curator surface. It reads
 * Memory-owned Skill telemetry rollups and prints evidence-based curation
 * recommendations. It NEVER mutates a skill file, the graph, or anything else:
 * it only reads rollups and runs the pure {@link curateSkills} over them. Heavy
 * / model-based review is intentionally absent — this is deterministic and runs
 * only when explicitly invoked.
 */
async function readSkillCuratorReport(
  rootDir: string,
  staleDays?: number,
): Promise<CuratorReportEnvelope> {
  const config = await readConfig(rootDir);
  if (!config) {
    throw new Error("memory is not initialized here");
  }
  if (config.mode !== "graph") {
    throw new Error(`needs graph mode, this project is "${config.mode}"`);
  }
  if (!skillTelemetryEnabled(config)) {
    throw new Error("skill telemetry is not enabled");
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const rollups = await readSkillRollups(store);
    return curateSkills(rollupsToCuratorInput(rollups), { staleDays });
  } finally {
    await store.close();
  }
}

export async function runCurate(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind !== "skills") {
    process.exitCode = await runCurateWorkflow(
      {
        command: kind,
        positional: args.positional.slice(1),
        flags: args.flags,
      },
      {
        usageCommand: "memory curate",
        loadCuratorReport: readSkillCuratorReport,
      },
    );
    return;
  }

  const rootDir = rootOf(args.flags);
  const config = await readConfig(rootDir);
  if (!config) {
    console.log("memory: curate ignored — memory is not initialized here");
    return;
  }
  if (config.mode !== "graph") {
    console.log(`memory: curate ignored — needs graph mode, this project is "${config.mode}"`);
    return;
  }
  if (!skillTelemetryEnabled(config)) {
    console.log(
      "memory: curate ignored — skill telemetry is not enabled, re-run `memory init --mode graph --skill-telemetry`",
    );
    return;
  }

  const report = await readSkillCuratorReport(rootDir, intFlag(args.flags, "stale-days"));

  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  console.log(
    `memory: skill curator (report-only) — ${report.totalSkills} skill(s), ` +
      `${report.curatableSkills} curatable, ${report.readOnlySkills} read-only`,
  );
  if (report.recommendations.length === 0) {
    console.log("  no curation recommendations — evidence supports no action");
    return;
  }
  console.log(
    `  ${report.recommendations.length} recommendation(s) (stale threshold ${report.staleDays}d):`,
  );
  for (const rec of report.recommendations) {
    const tag = rec.curatable ? "curatable" : "read-only";
    console.log(`  [${rec.category}] ${rec.name} (${tag}) — ${rec.reason}`);
  }
  console.log("\nReport-only: no skill files were read, patched, archived, or deleted.");
}
