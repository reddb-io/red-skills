import { acceptGovernanceTidyRecommendation, access, aliasEngineeringCode, appendContextPackGenerationEvent, appendMemoryEvent, appendRecallObservationEvent, applyWorkerLearningProposal, applyProviderEnv, approveEvidenceCard, approveInboxItem, ask, bootstrapProjectMemory, buildArchitectureOverview, buildWorkerLearningReport, buildCodeDriftReport, buildCommunitiesViewerArtifact, buildConfidenceReport, buildContextPack, buildContextPackViewerArtifact, buildDocBacklinksReport, buildDocBacklinksViewerArtifact, buildDocBundle, buildDocBundleViewerArtifact, buildDocCoverageReport, buildDocCoverageViewerArtifact, buildDocEvidencePack, buildDocEvidencePackViewerArtifact, buildDocReferenceGraphReport, buildDocReferenceGraphViewerArtifact, buildDocRelatedReport, buildDocRelatedViewerArtifact, buildDocSearchViewerArtifact, buildFederationReport, buildGraphContract, buildHookCoverageReport, buildHookCoverageViewerArtifact, buildLearningDebtReport, buildLearningDebtViewerArtifact, buildMemoryAgentIntegrationStatus, buildMemoryAgentIntegrationStatusViewerArtifact, buildMemoryAssetInventory, buildMemoryAssetInventoryViewerArtifact, buildMemoryCapabilityCatalog, buildMemoryCapsule, buildMemoryDecayReport, buildMemoryDecayViewerArtifact, buildMemoryExtractionStatus, buildMemoryExtractionStatusViewerArtifact, buildMemoryGovernanceReport, buildMemoryGovernanceViewerArtifact, buildMemoryHandoff, buildMemoryHandoffViewerArtifact, buildMemoryHealthReport, buildMemoryHealthViewerArtifact, buildMemoryLayersReport, buildMemoryLayersViewerArtifact, buildMemoryMapContextSlice, buildMemoryMapFreshnessReport, buildMemoryMergePassReport, buildMemoryOperationalDashboard, buildMemoryOperationalDashboardArtifact, buildMemoryReferenceRadar, buildMemoryRoutingGuide, buildMemoryRoutingGuideViewerArtifact, buildMemorySmartSearch, buildMemorySmartSearchViewerArtifact, buildMemoryWorkbench, buildMemoryWorkbenchArtifact, buildOnboardingMap, buildOnboardingMapViewerArtifact, buildPathExplainReport, buildPathExplainViewerArtifact, buildPreflightBrief, buildPrePrMemoryReview, buildPrePrReviewViewerArtifact, buildProvenanceReport, buildReadinessEnvelope, buildReadinessViewerArtifact, buildReasoningReplay, buildRecallTelemetryReport, buildSessionTimeline, buildSessionTimelineViewerArtifact, buildSkillRecommendations, buildStructuralImpactViewerArtifact, buildVectorSearchReport, buildVectorStatusViewerArtifact, buildWhatifReport, buildWorkFrontier, buildWorkFrontierViewerArtifact, claimCheck, classifyCandidateMemory, collectCandidates, commitMemoryGraph, computeProposalPriority, contentHash, createEvidenceCard, createHash, createInterface, createMemoryBackup, createMemoryHttpServer, curateSkills, DEFAULT_MEMORY_EVENT_RETENTION_DAYS, defaultIgnorePatterns, diagnose, dirname, dismissGovernanceTidyRecommendation, dispatch, driftCaughtToMemoryEvent, engineEventHealth, evaluateDriftGuard, evictL2, execFile, executeMemoryMergeBatch, executeMemoryOperationFromTransport, executeReadOnlyMemoryOperation, existsSync, exportGraph, extractConversation, extractStructuredTranscript, factsToGraph, factToNode, fileURLToPath, findNodeForProvenance, formatOutput, formatProvenanceHuman, formatScopeReport, graphRecallResult, HistoricalMemoryStore, importAmsDump, importComplementaryMapFile, inboxItemToProvenance, ingestGuidance, ingestProject, ingestSkillEvents, initGraph, initMarkdownOnly, installGitHooks, isAbsolute, isCuratable, isCuratedSuggestedEngineeringCode, join, lintMemory, listContradictions, listEvidenceCards, listInboxItems, listMemoryBackups, listReadOnlyMemoryOperations, loadEngineeringCodeCuration, markInboxItemPromoted, MemoryStore, memoryStoreEvidence, mkdir, neighbors, parseWorkerLearningProposal, parseInput, parseLooseArgs, parseSkillEvent, parseSkillEventInput, parseWhatifChange, planScope, promisify, promoteEngineeringCode, prune, quarantineInboxItem, readBuildInfo, readConfig, readdir, readDoc, readEvidenceCard, readFile, readInboxItem, readMemoryBackupManifest, readMemoryIgnore, readRecentSkillEvents, readSkillRollups, recall, recallObservationFromContextPack, recordReasoningWorker, redactSensitiveValue, redDbProviderClient, refreshFiles, refreshFromGit, refreshGovernanceTidyReviewArtifacts, rejectEvidenceCard, rejectInboxItem, rejectMemoryStoreEvidence, relative, rename, renderConfidenceMarkdown, renderIngestReportToon, renderRecallTelemetryReport, renderSignalProvenance, renderSkillRecommendationsSection, renderToonOutput, renderVersion, residentMemoryRequest, resolve, resolveConflict, resolveEngineeringCodeAlias, resolveL2Policy, resolveNotesDir, resolvePreset, resolveProvider, resolveStoreUri, restoreDocsFromMemory, restoreMemoryBackup, rollupsToCuratorInput, runAfkLifecycle, runAutoCure, runCurateWorkflow, runPromote, saveEngineeringCodeCuration, scanPrivacy, search, searchDocs, sep, sessionCurrent, sessionEnd, sessionEnsure, sessionStart, shortestPath, shouldUseResidentMemory, skillTelemetryEnabled, slugify, sortProposalSummaries, stat, storeNote, structuralImpactReader, suggestedEngineeringCodes, supersessionTimeline, toEdge, traverse, uninstallGitHooks, unmergeMemoryMergeBatch, validateGraphContract, viewerCliSummary, workingAppendEvent, workingGetRaw, workingListEvents, workingSetRaw, writeWorkerLearningProposalFile, writeFile, writeMemoryIgnore, writeViewerArtifact } from './deps.js';
import type { ClaimCheckResult, CodeDriftCountGroup, CommunityAnalyticsReport, CommunityDigestReport, ComplementaryMapSourceKind, Confidence, ContextPack, ContradictionSummary, CreateEvidenceCardInput, CuratorReportEnvelope, EngineeringCodeCurationState, EvidenceCard, EvidenceCardStatus, EvidenceCitation, EvidenceProposalApplyState, GovernedWriteResult, GraphContract, GraphRecallHit, GraphRecallResult, HookEvent, HubRankBy, HubReport, HubReportRow, InboxStatus, LintReport, LooseParsedArgs, MemoryCapsuleSourceKind, MemoryConfig, MemoryGlobalSearchReport, MemoryGovernanceReport, MemoryGraphCommitResult, MemoryHealthReport, MemoryInboxItem, MemoryLayer, MemoryOperationalDashboard, MemoryProvenance, MemoryReadinessEnvelope, MemoryRoutingAgent, MemoryRoutingGuide, MemoryScope, MemoryStoreEvidenceInput, PrePrMemoryReview, PrePrReviewSection, PrivacyFinding, PrivacyReport, RawPayload, ReadOnlyMemoryOperation, ReasoningWorkerPayload, Runner, SkillEventSummary, SkillRollup, StructuralImpact, StructuralImpactTarget, SuggestedQuestionsReport, TopicTimeline, VcsEvent, WhatifChange } from './deps.js';
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
import { HOOK_EVENTS, parseComplementaryMapKind, readStdin, resolveBootstrapPath, resolveHooksDir, resolveOverviewContract, runAfkFinalize, runArchitectureOverview, runWorker, runWorkerLearn, runWorkerLearnApply, runDoctor, runExport, runGlobalSearch, runHook, runImport, runPromoteCmd, runStats, runVcs, runVcsInstallHooks, runVcsRefresh, runVcsUninstallHooks, runVector, VCS_EVENTS } from './operations.js';

export const USAGE = `memory — governed operational memory for code agents

Common workflows:
  remember one fact          memory store "Decision: ..."
  get context before acting  memory recall "topic"
  map code before reading    memory map-context "who calls token refresh?"
  prepare another agent      memory capsule "goal"       | memory context-pack "goal"
  decide if safe to proceed  memory readiness "goal"     | memory claim-check "assertion"
  search every surface       memory smart-search "query"
  operate/debug Memory       memory workbench             | memory health-viewer | memory governance

Rule of thumb: recall is the canonical governed context path; readiness is the
go/no-go envelope; context-pack and handoff are continuation surfaces; smart
search, docs, vectors, Workbench, MCP, and HTTP are diagnostics/integration views
over the same evidence store.

Usage:
  memory --version | -v | version  [--json]   (states the build, needs no init)
  memory --help | -h | help
  memory init [--mode markdown-only|graph] [--hooks] [--skill-telemetry] [--event-retention-days N] [--root <dir>] [--yes]
  memory store <fact...>            [--root <dir>] [--scope project|repo|branch|worktree|session|agent-run|user] [--scope-id ID]
  memory store-evidence             [--root <dir>] --claim <text> --source-ref <ref> --citation-excerpt <text> --intent <text> --observer <id> [--blast-radius low|medium|high] [--route <target>] [--confidence EXTRACTED|INFERRED|AMBIGUOUS] [--json]
  memory inbox quarantine <fact...> [--root <dir>] --reason <text> --evidence <summary> [--confidence EXTRACTED|INFERRED|AMBIGUOUS] [--source-kind manual|hook|derived|system] [--writer <name>] [--command <cmd>] [--hook <event>] [--json]
  memory inbox list                 [--root <dir>] [--status quarantined|approved|rejected|promoted|all] [--json]
  memory inbox inspect <id>         [--root <dir>] [--json]
  memory inbox approve <id>         [--root <dir>] --yes [--json]
  memory inbox reject <id>          [--root <dir>] --reason <text> --yes [--json]
  memory inbox promote <id>         [--root <dir>] --yes [--json]
  memory evidence create            [--root <dir>] --summary <text> --source-ref <ref> --citation <label|uri|quote> --lesson <text> [--source-kind <kind>] [--route <target>] [--confidence EXTRACTED|INFERRED|AMBIGUOUS] [--json]
  memory evidence list              [--root <dir>] [--status pending|approved|rejected|all] [--json]
  memory evidence show <id>         [--root <dir>] [--json]
  memory evidence approve <id>      [--root <dir>] --yes [--reviewer <id>] [--json]
  memory evidence reject <id>       [--root <dir>] --reason <text> --yes [--reviewer <id>] [--json]
  memory classify <candidate...>    [--root <dir>] [--json]
  memory recall <query...>          [--root <dir>] [--limit N] [--include-superseded] [--scope ...] [--scope-id ID] [--include-narrower-scopes] [--as-of <reddb-ref>] [--layer L1|L2|L3]
  memory federate                   [--root <dir>] --query "<topic>" [--limit N] [--per-root-limit N] [--json]
  memory whatif                     [--root <dir>] --change "<descriptor>" [--change "<descriptor>" ...] [--limit N] [--json]
  memory autocure                   [--root <dir>] [--apply] [--stale-days N] [--json]
  memory smart-search <query...>    [--root <dir>] [--limit N] [--depth N] [--json]
  memory capsule <goal...>          [--root <dir>] [--source context-pack|handoff] [--budget N] [--limit N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory smart-search-viewer <query...> [--root <dir>] [--limit N] [--depth N] [--out <file>]
  memory context-pack <goal...>     [--root <dir>] [--budget N] [--limit N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory context-pack-viewer <goal...> [--root <dir>] [--budget N] [--limit N] [--depth N] [--out <file>] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory recommend skills <task...> [--root <dir>] [--limit N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory claim-check <assertion...> [--root <dir>] [--json]
  memory preflight <task...>        [--root <dir>] [--limit N] [--min-evidence N] [--stale-days N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory readiness <goal...>        [--root <dir>] [--limit N] [--min-evidence N] [--stale-days N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory readiness-viewer <goal...> [--root <dir>] [--out <file>] [--limit N] [--min-evidence N] [--stale-days N] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory capabilities              [--root <dir>] [--json]
  memory assets [query...]          [--root <dir>] [--kind <kind>] [--json]
  memory assets-viewer [query...]   [--root <dir>] [--kind <kind>] [--out <file>]
  memory references-radar          [--root <dir>] [--json]
  memory layers                    [--root <dir>] [--json]
  memory layers-viewer             [--root <dir>] [--out <file>]
  memory handoff [focus...]         [--root <dir>] [--limit N] [--json]
  memory handoff-viewer [focus...]  [--root <dir>] [--limit N] [--out <file>]
  memory frontier [focus...]        [--root <dir>] [--limit N] [--json]
  memory frontier-viewer [focus...] [--root <dir>] [--limit N] [--out <file>]
  memory dashboard                 [--root <dir>] [--out <file>] [--stale-days N] [--json]
  memory workbench                 [--root <dir>] [--out <file>] [--session <id>] [--limit N] [--json]
  memory session timeline           [--root <dir>] [--session <id>] [--limit N] [--json]
  memory session timeline-viewer    [--root <dir>] [--session <id>] [--limit N] [--out <file>]
  memory session show               [--root <dir>] [--json]   (prints the current session id, or "none")
  memory session start              [--root <dir>] [--id <id>] [--json]   (mints + writes a fresh id)
  memory session end                [--root <dir>] [--json]   (drops .red/memory/sessions/current)
  memory working append             [--root <dir>] --type <event-type> --value <text> [--json]
  memory working get                [--root <dir>] [--type <event-type>] [--json]
  memory working raw                [--root <dir>] [--set <text>] [--json]
  memory working evict              [--root <dir>] [--ttl-ms N] [--byte-budget N] [--json]
  memory learning-debt              [--root <dir>] [--stale-days N] [--json]
  memory learning-debt-viewer       [--root <dir>] [--stale-days N] [--out <file>]
  memory decay                      [--root <dir>] [--stale-days N] [--deprecate-days N] [--limit N] [--json]
  memory decay-viewer               [--root <dir>] [--stale-days N] [--deprecate-days N] [--limit N] [--out <file>]
  memory merge-pass                 [--root <dir>] [--min-score N] [--limit N] [--json]
  memory merge-pass execute         --candidate-ranks 1,2 --approver <id> --yes [--root <dir>] [--min-score N] [--limit N] [--batch-id ID] [--json]
  memory merge-pass unmerge         --batch-id ID --yes [--root <dir>] [--json]
  memory tidy-review refresh        [--root <dir>] [--json]
  memory tidy-review accept <id>    --approver <id> --yes [--root <dir>] [--reason <text>] [--json]
  memory tidy-review dismiss <id>   --approver <id> --yes [--root <dir>] [--reason <text>] [--json]
  memory health-viewer              [--root <dir>] [--stale-days N] [--out <file>]
  memory map freshness              [--root <dir>] [--json]   (map freshness and extraction diagnostic, read-only)
  memory onboarding-map             [--root <dir>] [--stale-days N] [--json]
  memory onboarding-map-viewer      [--root <dir>] [--stale-days N] [--out <file>]
  memory onboarding-map export <out-dir> --public-safe [--strict] [--root <dir>] [--json]
  memory routing-guide              [--agent codex|claude|cursor|gemini|aider|opencode|generic] [--json]
  memory routing-guide-viewer       [--agent codex|claude|cursor|gemini|aider|opencode|generic] [--out <file>]
  memory integration-status         [--root <dir>] [--agent codex|claude|cursor|gemini|aider|opencode|generic] [--json]
  memory integration-status-viewer  [--root <dir>] [--agent codex|claude|cursor|gemini|aider|opencode|generic] [--out <file>]
  memory ask <question...>          [--root <dir>] [--json]
  memory docs search <query...>     [--root <dir>] [--limit N] [--json]
  memory docs search-viewer <query...> [--root <dir>] [--limit N] [--out <file>]
  memory docs brief <query...>      [--root <dir>] [--limit N] [--max-bytes N] [--json]
  memory docs brief-viewer <query...> [--root <dir>] [--limit N] [--max-bytes N] [--out <file>]
  memory docs bundle <query...>     [--root <dir>] [--limit N] [--max-bytes N] [--json]
  memory docs bundle-viewer <query...> [--root <dir>] [--limit N] [--max-bytes N] [--out <file>]
  memory docs read <path|rid>       [--root <dir>] [--max-bytes N] [--json]
  memory docs evidence-pack <path|rid> [--root <dir>] [--max-bytes N] [--json]
  memory docs evidence-pack-viewer <path|rid> [--root <dir>] [--max-bytes N] [--out <file>]
  memory docs backlinks <label|rid> [--root <dir>] [--json]
  memory docs backlinks-viewer <label|rid> [--root <dir>] [--out <file>]
  memory docs related <path|rid>    [--root <dir>] [--json]
  memory docs related-viewer <path|rid> [--root <dir>] [--out <file>]
  memory docs restore [path|rid]    [--root <dir>] [--out <dir>|--in-place] [--overwrite] [--dry-run] [--yes] [--json]
  memory docs coverage              [--root <dir>] [--json]
  memory docs coverage-viewer       [--root <dir>] [--out <file>]
  memory docs reference-graph       [--root <dir>] [--json]
  memory docs reference-graph-viewer [--root <dir>] [--out <file>]
  memory bootstrap                  [--root <dir>] [--dry-run] [--max-files N] [--include-git-log] [--json]
  memory backup create              [--root <dir>] [--name <name>] [--json]
  memory backup list                [--root <dir>] [--json]
  memory backup inspect <name>      [--root <dir>] [--json]
  memory backup restore <name>      [--root <dir>] --yes [--json]
  memory serve                      [--root <dir>] [--host 127.0.0.1] [--port 49375] [--token-env ENV]
  memory provenance <rid|label>     [--root <dir>] [--json]
  memory governance                 [--root <dir>] [--stale-progress-days N] [--json]
  memory governance-viewer          [--root <dir>] [--stale-progress-days N] [--out <file>]
  memory ingest <path>              [--root <dir>] [--max-files N] [--structural-only]
  memory refresh [<path...>]         [--root <dir>] [--stdin] [--changed|--staged] [--json]
  memory extract [<transcript-file>] [--root <dir>] [--local]   (reads stdin if no file)
  memory extraction status           [--root <dir>] [--json]
  memory extraction status-viewer    [--root <dir>] [--out <file>]
  memory code-drift                  [--root <dir>] [--recurring-threshold N] [--json]   (read-only)
  memory code-curate list|promote|alias [args] [--root <dir>] [--json]
  memory event skill                [--root <dir>] [--event-type ...] ... (or JSON/JSONL on stdin)
  memory curate skills              [--root <dir>] [--stale-days N] [--json]   (report-only)
  memory curate check|list|background|archive|restore [--root <dir>]   (/curate workflow)
  memory improve skills             [--root <dir>] [--write-proposal] [--json]   (proposal-gated)
  memory improve proposals list      [--root <dir>] [--json]
  memory improve proposals show <proposal> [--root <dir>] [--json]
  memory improve proposals archive <proposal> --reason applied|rejected|stale --yes [--root <dir>] [--json]
  memory improve apply <proposal>    [--root <dir>] --yes [--json]   (explicit patch apply)
  memory health                    [--root <dir>] [--json]   (operational healthcheck, read-only)
  memory recall-telemetry          [--root <dir>] [--window-ms N] [--json]   (real-run recall metrics, read-only; distinct from bench)
  memory hooks coverage            [--root <dir>] [--json]   (hook manifest/config coverage, read-only)
  memory hooks coverage-viewer     [--root <dir>] [--out <file>]
  memory lint                      [--root <dir>] [--json]   (policy hygiene report, read-only)
  memory privacy scan              [--root <dir>] [--json]   (sensitive data report, read-only)
  memory privacy export [<out-dir>] [--root <dir>] [--communities] [--json]   (redacted graph export)
  memory status skills              [--root <dir>] [--all] [--limit N] [--json]   (diagnostic, read-only)
  memory status context             [--root <dir>] [--json]   (context stack healthcheck, read-only)
  memory attempt record             [--root <dir>]             (reads AFK attempt JSON from stdin)
  memory attempt learn              [--root <dir>] [--write-proposal] [--json]   (proposal-gated)
  memory attempt learn apply <proposal> [--root <dir>] --yes [--json]
  memory commit                    [--root <dir>] [--message <text>] [--author <name>] [--email <addr>] [--json]

  Graph-mode read verbs (require \`memory init --mode graph\`):
  memory search <query...>          [--root <dir>] [--limit N]
  memory map-context <query...>     [--root <dir>] [--depth N] [--mode bfs|dfs] [--context call,import,type,validation,decision,work,reference] [--budget N] [--json]
  memory neighbors <label>          [--root <dir>] [--depth N] [--direction outgoing|incoming|both]
  memory traverse <label>           [--root <dir>] [--depth N] [--strategy bfs|dfs] [--direction ...]
  memory path <from> <to>           [--root <dir>] [--algorithm bfs|dijkstra]
  memory path-explain <from> <to>   [--root <dir>] [--max-depth N] [--json]
  memory path-explain-viewer <from> <to> [--root <dir>] [--max-depth N] [--out <file>]
  memory confidence --node <rid>    [--root <dir>] [--json]
  memory conflicts                  [--root <dir>] [--include-resolved] [--json]
  memory supersede <old-rid> <new-rid> [--root <dir>] [--reason <text>]
  memory resolve-conflict <active-rid> <superseded-rid> [--root <dir>] [--reason <text>]
  memory timeline <topic|rid>       [--root <dir>] [--include-audit] [--json]
  memory communities                [--root <dir>] [--no-cache] [--json]
  memory communities-viewer         [--root <dir>] [--no-cache] [--out <file>]
  memory community-digest           [--root <dir>] [--no-cache] [--json]
  memory suggested-questions        [--root <dir>] [--limit N] [--json]
  memory global-search <query...>   [--root <dir>] [--limit N] [--no-cache] [--json]
  memory structural-impact          [--root <dir>] [--file <path>] [--symbol <name>]
  memory structural-impact-viewer   [--root <dir>] [--file <path>] [--symbol <name>] [--out <file>]
  memory pre-pr-review              [--root <dir>] [--range <git-range>] [--json]
  memory pre-pr-review-viewer       [--root <dir>] [--range <git-range>] [--out <file>]
  memory vector status              [--root <dir>] [--local] [--json]
  memory vector status-viewer       [--root <dir>] [--local] [--out <file>]
  memory vector maintain            [--root <dir>] [--local] [--strict] [--json]
  memory vector search <query...>   [--root <dir>] [--local] [--limit N] [--json]
  memory stats                      [--root <dir>]
  memory doctor                     [--root <dir>] [--stale-days N] [--prune] [--yes]
  memory export [<out-dir>]         [--root <dir>] [--communities] [--interop]
  memory graph  [<out-dir>]         [--root <dir>] [--communities]   (alias of export)
  memory map-contract               [--root <dir>] [--communities] [--json]
  memory architecture-overview      [--root <dir>] [--from <graph.json>] [--out <file>] [--stdout] [--json]

  Auto-firing hooks (invoked by the plugin manifest, reads payload on stdin):
  memory hook <event> --runner <claude|codex>   [--root <dir>]

  Git auto-update hooks (#236) — keep the graph fresh on commit/checkout:
  memory vcs install-hooks          [--root <dir>] [--force] [--json]
  memory vcs uninstall-hooks        [--root <dir>] [--json]
  memory vcs refresh --event post-commit|post-checkout   [--prev <sha> --new <sha> --flag <0|1>] [--no-export] [--root <dir>] [--json]

  Promotion (PRD #174, issue #183) — run the PromotionEngine for the current
  session, promoting typed L2 candidates and bumping reinforcement on dedup
  hits. Emits one promote event per decision.
  memory promote [--triggered-by explicit|hook|overflow] [--session <id>] [--json] [--root <dir>]

  AFK lifecycle (PRD #174, issue #187) — end-of-worktree sequence the AFK
  worker invokes after its iteration closes: promote-all typed L2 candidates
  into L3, archive the raw transcript as a durable L3 \`transcript\` node
  tagged with the worktree id, then drop the session's L2 nodes. Idempotent.
  memory afk-finalize --worktree <id>  [--session <id>] [--json] [--root <dir>]

  AMS migration (PRD #174, issue #184) — one-shot offline importer for Redis
  agent-memory-server JSON dumps. See \`docs/migrating-from-ams.md\`.
  memory import ams <dump.json>     [--root <dir>] [--json]
  memory import map <artifact.json> [--kind graphify|scip|lsp|static-analysis] [--root <dir>] [--json]

  Benchmarks and reference eval live in the embedded app \`benchmark-memory\`.

Two storage modes: markdown-only (plain notes, no engine) and graph (a typed
knowledge graph over a per-project RedDB store). Run \`memory init\` once to pick
one, then use /memory:store and /memory:recall (or the CLI verbs) — they route
to whichever mode init configured.

Registered read-only operations:
${registryCliHelp()}`;

function registryCliHelp(): string {
  return listReadOnlyMemoryOperations()
    .filter((operation) => operation.transports.includes("cli"))
    .sort((a, b) => a.renderer.cli.command.localeCompare(b.renderer.cli.command))
    .map((operation) => `  memory ${operation.renderer.cli.command}\n      ${operation.description}`)
    .join("\n");
}

export type ParsedArgs = LooseParsedArgs;

export const execFileAsync = promisify(execFile);

export const LEGACY_CLI_OPERATION_IDS = new Set<string>();

export const LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND: Readonly<Record<string, readonly string[]>> = {
};

export const PROOF_REGISTRY_CLI_COMMANDS = new Set<string>();

export const REGISTRY_CLI_OPERATIONS = new Map<string, ReadOnlyMemoryOperation>(
  listReadOnlyMemoryOperations()
    .filter((operation) => operation.transports.includes("cli"))
    .filter((operation) => !LEGACY_CLI_OPERATION_IDS.has(operation.id))
    .map((operation) => [operation.renderer.cli.command, operation]),
);

export function rootOf(flags: Record<string, string | boolean>): string {
  return typeof flags.root === "string" ? flags.root : process.cwd();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const MEMORY_SCOPES: readonly MemoryScope[] = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
];

export function parseMemoryScope(value: string | boolean | undefined): MemoryScope | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--scope requires a value");
  if ((MEMORY_SCOPES as readonly string[]).includes(value)) return value as MemoryScope;
  throw new Error(`invalid memory scope "${value}"`);
}

export const MEMORY_LAYERS: readonly MemoryLayer[] = ["L1", "L2", "L3"];

export function parseLayerFlag(value: string | boolean | undefined): MemoryLayer | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--layer requires a value (L1|L2|L3)");
  const upper = value.toUpperCase();
  if ((MEMORY_LAYERS as readonly string[]).includes(upper)) return upper as MemoryLayer;
  throw new Error(`invalid memory layer "${value}" — expected L1, L2, or L3`);
}

export const CONFIDENCE_VALUES: readonly Confidence[] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];

export function parseConfidence(value: string | boolean | undefined): Confidence | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--confidence requires a value");
  if ((CONFIDENCE_VALUES as readonly string[]).includes(value)) return value as Confidence;
  throw new Error(`invalid confidence "${value}"`);
}

export const SOURCE_KINDS: readonly MemoryProvenance["source_kind"][] = [
  "manual",
  "hook",
  "derived",
  "system",
  "external-map",
];

export function parseSourceKind(
  value: string | boolean | undefined,
): MemoryProvenance["source_kind"] | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--source-kind requires a value");
  if ((SOURCE_KINDS as readonly string[]).includes(value)) {
    return value as MemoryProvenance["source_kind"];
  }
  throw new Error(`invalid source kind "${value}"`);
}

export function scopeFlags(flags: Record<string, string | boolean>) {
  const level = parseMemoryScope(flags.scope);
  if (!level) return undefined;
  return {
    level,
    id: typeof flags["scope-id"] === "string" ? flags["scope-id"] : undefined,
    includeNarrower: flags["include-narrower-scopes"] === true,
  };
}

export async function requireConfig(rootDir: string) {
  const config = await readConfig(rootDir);
  if (!config) {
    throw new Error("memory is not initialized here — run `memory init` first");
  }
  return config;
}

export async function runInit(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  let mode = typeof args.flags.mode === "string" ? args.flags.mode : undefined;

  // Interactive wizard only when no mode was given and we have a TTY.
  if (!mode && args.flags.yes !== true && process.stdin.isTTY) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const answer = (
      await rl.question(
        "What do you want to use? [markdown-only] / graph: ",
      )
    ).trim();
    rl.close();
    mode = answer || "markdown-only";
  }
  mode = mode ?? "markdown-only";
  const skillTelemetry = args.flags["skill-telemetry"] === true;
  const eventRetentionDays = intFlag(args.flags, "event-retention-days");
  if (eventRetentionDays != null && (!Number.isFinite(eventRetentionDays) || eventRetentionDays < 0)) {
    throw new Error("--event-retention-days must be a non-negative number");
  }

  if (mode === "markdown-only") {
    const result = await initMarkdownOnly(rootDir);
    console.log(`memory: initialized markdown-only mode`);
    console.log(`  config: ${result.configPath}`);
    console.log(`  notes:  ${result.notesDir}`);
    console.log(`  hooks:  off    mcp: off    reddb: not required`);
    if (skillTelemetry) {
      console.log(
        `  note:   skill telemetry is unsupported in markdown-only mode — re-run \`memory init --mode graph --skill-telemetry\` to enable it`,
      );
    }
    return;
  }

  if (mode === "graph") {
    // Hooks are opt-in: `--hooks` (or `--hooks all`) turns all four on; absent
    // leaves them off. markdown-only never gets hooks regardless.
    const hooks = args.flags.hooks === true || args.flags.hooks === "all";
    // Skill telemetry is a separate explicit opt-in, graph-mode only.
    const result = await initGraph(rootDir, { hooks, skillTelemetry, eventRetentionDays });
    const on = Object.values(result.config.hooks).some(Boolean);
    console.log(`memory: initialized graph mode`);
    console.log(`  config: ${result.configPath}`);
    console.log(`  store:  ${result.storeUri}`);
    console.log(`  hooks:  ${on ? "on" : "off"}    mcp: off    reddb: required`);
    console.log(`  skill telemetry: ${result.config.skillTelemetry ? "on" : "off"}`);
    console.log(
      `  event retention: ${result.config.eventLog?.retentionDays ?? DEFAULT_MEMORY_EVENT_RETENTION_DAYS} day(s)`,
    );
    console.log(`  vcs versioned: ${result.versioning.versioned.join(", ")}`);
    console.log(`  vcs skipped:   ${result.versioning.skipped.join(", ")}`);
    return;
  }

  throw new Error(
    `mode "${mode}" is not available yet — this build supports markdown-only and graph`,
  );
}

export async function runStore(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const fact = args.positional.join(" ").trim();
  if (!fact) throw new Error("nothing to store — pass a fact: memory store <fact>");
  const config = await requireConfig(rootDir);

  if (config.mode === "graph") {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const explicitScope = parseMemoryScope(args.flags.scope);
      const rid = await store.upsertNode(
        factToNode(fact, slugify, {
          scope: explicitScope,
          scopeId: typeof args.flags["scope-id"] === "string" ? args.flags["scope-id"] : undefined,
          provenance: {
            source_kind: "manual",
            writer: "cli",
            command: "memory store",
            scope: {
              ...(explicitScope ? { level: explicitScope } : {}),
              ...(typeof args.flags["scope-id"] === "string" ? { id: args.flags["scope-id"] } : {}),
            },
            confidence: "EXTRACTED",
            evidence: ["fact argument"],
          },
        }),
      );
      console.log(`memory: stored node ${rid}`);
    } finally {
      await store.close();
    }
    return;
  }

  const note = await storeNote(resolveNotesDir(rootDir, config), fact, new Date(), {
    provenance: {
      source_kind: "manual",
      writer: "cli",
      command: "memory store",
      confidence: "EXTRACTED",
      evidence: ["fact argument"],
    },
  });
  console.log(`memory: stored ${note.id}`);
  console.log(`  ${note.path}`);
}

export async function runStoreEvidence(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const input: MemoryStoreEvidenceInput = {
    claim: stringFlag(args.flags, "claim") ?? args.positional.join(" "),
    sourceRef: stringFlag(args.flags, "source-ref") ?? stringFlag(args.flags, "source"),
    citationExcerpt:
      stringFlag(args.flags, "citation-excerpt") ?? stringFlag(args.flags, "citation"),
    intent: stringFlag(args.flags, "intent"),
    observer: stringFlag(args.flags, "observer") ?? stringFlag(args.flags, "writer"),
    blastRadius: stringFlag(args.flags, "blast-radius"),
    route: stringFlag(args.flags, "route"),
    confidence: parseConfidence(args.flags.confidence),
    proposalKind: stringFlag(args.flags, "proposal-kind"),
    proposalId: stringFlag(args.flags, "proposal-id"),
    proposalPath: stringFlag(args.flags, "proposal-path"),
  };

  const config = await readConfig(rootDir);
  if (!config || config.mode !== "graph") {
    const rejected = rejectMemoryStoreEvidence(input, "graph_mode_required");
    printGovernedWriteResult(rejected, args.flags.json === true);
    return;
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const result = await memoryStoreEvidence(store, input, { rootDir });
    printGovernedWriteResult(result, args.flags.json === true);
  } finally {
    await store.close();
  }
}

export async function runCommit(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  const result = await commitMemoryGraph(rootDir, config, {
    message: stringFlag(args.flags, "message") ?? stringFlag(args.flags, "m"),
    author: stringFlag(args.flags, "author"),
    email: stringFlag(args.flags, "email"),
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  printCommitResult(result);
}

export function printCommitResult(result: MemoryGraphCommitResult): void {
  if (result.committed) {
    console.log(`memory commit: ${result.commit?.hash}`);
    console.log(`  message: ${result.message}`);
  } else {
    console.log("memory commit: nothing meaningful to commit");
    if (result.previousCommit) console.log(`  previous: ${result.previousCommit}`);
  }
  console.log(`  included: ${result.included.join(", ") || "none"}`);
  console.log(`  skipped:  ${result.skipped.join(", ") || "none"}`);
}

export async function runInbox(args: ParsedArgs): Promise<void> {
  const action = args.positional[0] ?? "list";
  const rootDir = rootOf(args.flags);
  await requireConfig(rootDir);

  switch (action) {
    case "quarantine": {
      const item = await quarantineInboxItem(rootDir, {
        fact: args.positional.slice(1).join(" "),
        reason: stringFlag(args.flags, "reason") ?? "",
        evidenceSummary: stringFlag(args.flags, "evidence") ?? "",
        provenance: {
          sourceKind: parseSourceKind(args.flags["source-kind"]),
          writer: stringFlag(args.flags, "writer"),
          command: stringFlag(args.flags, "command"),
          hook: stringFlag(args.flags, "hook"),
          confidence: parseConfidence(args.flags.confidence),
          scope: scopeContext(args.flags),
        },
      });
      return printInboxResult("quarantined", item, args.flags.json === true);
    }
    case "list": {
      const status = parseInboxStatusFilter(args.flags.status);
      let items = await listInboxItems(rootDir);
      if (status) items = items.filter((item) => item.status === status);
      if (args.flags.json === true) {
        console.log(JSON.stringify({ items }, null, 2));
        return;
      }
      printInboxList(items);
      return;
    }
    case "inspect": {
      const id = args.positional[1];
      if (!id) throw new Error("memory inbox inspect needs an item id");
      const item = await readInboxItem(rootDir, id);
      if (args.flags.json === true) {
        console.log(JSON.stringify({ item }, null, 2));
        return;
      }
      printInboxItem(item);
      return;
    }
    case "approve": {
      const id = args.positional[1];
      if (!id) throw new Error("memory inbox approve needs an item id");
      if (args.flags.yes !== true) {
        throw new Error("memory inbox approve requires explicit --yes approval");
      }
      const item = await approveInboxItem(rootDir, id);
      return printInboxResult("approved", item, args.flags.json === true);
    }
    case "reject": {
      const id = args.positional[1];
      if (!id) throw new Error("memory inbox reject needs an item id");
      if (args.flags.yes !== true) {
        throw new Error("memory inbox reject requires explicit --yes approval");
      }
      const item = await rejectInboxItem(rootDir, id, stringFlag(args.flags, "reason") ?? "");
      return printInboxResult("rejected", item, args.flags.json === true);
    }
    case "promote": {
      const id = args.positional[1];
      if (!id) throw new Error("memory inbox promote needs an item id");
      if (args.flags.yes !== true) {
        throw new Error("memory inbox promote requires explicit --yes approval");
      }
      const config = await requireConfig(rootDir);
      if (config.mode !== "graph") {
        throw new Error(
          `memory inbox promote needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
        );
      }
      const pending = await readInboxItem(rootDir, id);
      if (pending.status !== "approved") {
        throw new Error(`memory inbox item ${id} must be approved before promotion`);
      }
      const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
      let rid = 0;
      try {
        rid = await store.upsertNode(
          factToNode(pending.fact, slugify, {
            scope: pending.provenance.scope?.level,
            scopeId: pending.provenance.scope?.id,
            provenance: inboxItemToProvenance(pending),
          }),
        );
      } finally {
        await store.close();
      }
      const item = await markInboxItemPromoted(rootDir, id, rid);
      return printInboxResult("promoted", item, args.flags.json === true);
    }
    default:
      throw new Error(
        "usage: memory inbox quarantine|list|inspect|approve|reject|promote [args]",
      );
  }
}

export async function runEvidence(args: ParsedArgs): Promise<void> {
  const action = args.positional[0] ?? "list";
  const rootDir = rootOf(args.flags);
  await requireConfig(rootDir);

  switch (action) {
    case "create": {
      const card = await createEvidenceCard(rootDir, evidenceCardInputFromFlags(args));
      return printEvidenceResult("created", card, args.flags.json === true);
    }
    case "list": {
      const status = parseEvidenceStatusFilter(args.flags.status);
      let cards = await listEvidenceCards(rootDir);
      if (status) cards = cards.filter((card) => card.status === status);
      if (args.flags.json === true) {
        console.log(JSON.stringify({ cards }, null, 2));
        return;
      }
      printEvidenceList(cards);
      return;
    }
    case "show": {
      const id = args.positional[1];
      if (!id) throw new Error("memory evidence show needs a card id");
      const card = await readEvidenceCard(rootDir, id);
      if (args.flags.json === true) {
        console.log(JSON.stringify({ card }, null, 2));
        return;
      }
      printEvidenceCard(card);
      return;
    }
    case "approve": {
      const id = args.positional[1];
      if (!id) throw new Error("memory evidence approve needs a card id");
      if (args.flags.yes !== true) {
        throw new Error("memory evidence approve requires explicit --yes approval");
      }
      const reviewer = stringFlag(args.flags, "reviewer");
      const linked = await approveLinkedEvidenceCard(rootDir, id, reviewer);
      if (linked) return printLinkedEvidenceResult("approved", linked, args.flags.json === true);
      const card = await approveEvidenceCard(rootDir, id, reviewer);
      return printEvidenceResult("approved", card, args.flags.json === true);
    }
    case "reject": {
      const id = args.positional[1];
      if (!id) throw new Error("memory evidence reject needs a card id");
      if (args.flags.yes !== true) {
        throw new Error("memory evidence reject requires explicit --yes approval");
      }
      const reason = stringFlag(args.flags, "reason")?.trim();
      if (!reason) throw new Error("memory evidence reject requires a non-empty --reason");
      const reviewer = stringFlag(args.flags, "reviewer");
      const linked = await rejectLinkedEvidenceCard(rootDir, id, reason, reviewer);
      if (linked) return printLinkedEvidenceResult("rejected", linked, args.flags.json === true);
      const card = await rejectEvidenceCard(
        rootDir,
        id,
        reason,
        reviewer,
      );
      if (card.proposal_link.path) {
        await markProposalEvidenceRejected(rootDir, card.proposal_link.path, card.id, reason);
      }
      return printEvidenceResult("rejected", card, args.flags.json === true);
    }
    default:
      throw new Error("usage: memory evidence create|list|show|approve|reject [args]");
  }
}

export interface LinkedEvidenceReviewResult {
  id: string;
  status: "approved" | "rejected";
  path: string;
  proposalPath?: string;
}

export async function approveLinkedEvidenceCard(
  rootDir: string,
  id: string,
  reviewer: string | undefined,
): Promise<LinkedEvidenceReviewResult | null> {
  const found = await findLinkedEvidenceCard(rootDir, id);
  if (!found) return null;
  const rawStatus = firstYamlScalar(found.body, "status");
  if (rawStatus === "approved") {
    const proposalPath = firstNestedYamlScalar(found.body, "proposal", "path");
    return { id, status: "approved", path: found.path, ...(proposalPath ? { proposalPath } : {}) };
  }
  if (rawStatus !== "proposed") {
    throw new Error(`memory evidence card ${id} cannot be approved from status ${rawStatus ?? "unknown"}`);
  }
  const updated = withLinkedEvidenceReview(found.body, "approved", reviewer);
  await writeFile(found.path, updated, "utf8");
  const proposalPath = firstNestedYamlScalar(updated, "proposal", "path");
  return { id, status: "approved", path: found.path, ...(proposalPath ? { proposalPath } : {}) };
}

export async function rejectLinkedEvidenceCard(
  rootDir: string,
  id: string,
  reason: string,
  reviewer: string | undefined,
): Promise<LinkedEvidenceReviewResult | null> {
  const found = await findLinkedEvidenceCard(rootDir, id);
  if (!found) return null;
  const rawStatus = firstYamlScalar(found.body, "status");
  const proposalPath = firstNestedYamlScalar(found.body, "proposal", "path");
  if (rawStatus === "rejected") {
    const reviewNotes = firstNestedYamlScalar(found.body, "review", "notes");
    if (proposalPath) await markProposalEvidenceRejected(rootDir, proposalPath, id, reviewNotes ?? reason);
    return { id, status: "rejected", path: found.path, ...(proposalPath ? { proposalPath } : {}) };
  }
  if (rawStatus !== "proposed") {
    throw new Error(`memory evidence card ${id} cannot be rejected from status ${rawStatus ?? "unknown"}`);
  }
  const updated = withLinkedEvidenceReview(found.body, "rejected", reviewer, reason);
  await writeFile(found.path, updated, "utf8");
  if (proposalPath) await markProposalEvidenceRejected(rootDir, proposalPath, id, reason);
  return { id, status: "rejected", path: found.path, ...(proposalPath ? { proposalPath } : {}) };
}

export async function findLinkedEvidenceCard(rootDir: string, id: string): Promise<{ path: string; body: string } | null> {
  const dir = join(rootDir, ".red", "memory", "inbox", "evidence");
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const idLine = `id: ${yamlScalar(id)}`;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".yaml")) continue;
    const path = join(dir, entry.name);
    const body = await readFile(path, "utf8");
    if (body.includes('contract: "memory.evidence-card.experimental.v1"') && body.includes(idLine)) {
      return { path, body };
    }
  }
  return null;
}

export function withLinkedEvidenceReview(
  body: string,
  status: "approved" | "rejected",
  reviewer: string | undefined,
  reason?: string,
): string {
  const now = new Date().toISOString();
  let next = body.replace(/^status: .+$/m, `status: ${yamlScalar(status)}`);
  next = next.replace(/^updated_at: .+$/m, `updated_at: ${yamlScalar(now)}`);
  next = next.replace(/\nreview:\n(?:  .+\n)*/m, "\n");
  const review = [
    "review:",
    `  decision: ${yamlScalar(status)}`,
    ...(reviewer ? [`  reviewer: ${yamlScalar(reviewer)}`] : []),
    `  reviewed_at: ${yamlScalar(now)}`,
    ...(reason ? [`  notes: ${yamlScalar(status === "rejected" ? (redactSensitiveValue(reason) as string) : reason)}`] : []),
  ].join("\n");
  return next.replace(/\nproposal:\n/, `\n${review}\nproposal:\n`);
}

export async function markProposalEvidenceRejected(
  rootDir: string,
  proposalPathValue: string,
  evidenceCardId: string,
  reason: string,
): Promise<void> {
  const proposalPath = resolve(rootDir, proposalPathValue);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  assertInsideProposalTree(rootDir, proposalPath);
  const body = await readFile(proposalPath, "utf8");
  const marker = `Evidence card id: ${evidenceCardId}`;
  if (body.includes(marker) && body.includes("Evidence Card Review Warning")) return;
  const redactedReason = redactSensitiveValue(reason) as string;
  const warning = [
    "",
    "## Evidence Card Review Warning",
    "",
    `- Evidence card id: ${evidenceCardId}`,
    "- Status: rejected",
    `- Reason: ${redactedReason}`,
    "",
    "The evidence interpretation for the linked card was rejected. This warning does not archive, move, delete, apply, or otherwise approve this proposal.",
    "",
  ].join("\n");
  await writeFile(proposalPath, `${body.trimEnd()}\n${warning}`, "utf8");
}

export function firstYamlScalar(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(key)}: (.+)$`, "m"));
  return match ? unquoteYamlScalar(match[1]) : null;
}

export function firstNestedYamlScalar(body: string, parent: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(parent)}:\\n(?:  .+\\n)*?  ${escapeRegExp(key)}: (.+)$`, "m"));
  return match ? unquoteYamlScalar(match[1]) : null;
}

export function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
  return trimmed;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function evidenceCardInputFromFlags(args: ParsedArgs): CreateEvidenceCardInput {
  const summary = (stringFlag(args.flags, "summary") ?? args.positional.slice(1).join(" ")).trim();
  if (!summary) throw new Error("memory evidence create requires --summary <text>");
  const sourceRef = stringFlag(args.flags, "source-ref") ?? stringFlag(args.flags, "source");
  if (!sourceRef) throw new Error("memory evidence create requires --source-ref <ref>");
  const lesson = stringFlag(args.flags, "lesson") ?? stringFlag(args.flags, "proposed-lesson");
  if (!lesson) throw new Error("memory evidence create requires --lesson <text>");
  const citations = collectEvidenceFlagValues(args, "citation").map(parseEvidenceCitation);
  if (citations.length === 0) throw new Error("memory evidence create requires at least one --citation <label|uri|quote>");
  const judgeScore = numberFlag(args.flags, "judge-score") ?? 0.5;
  const judgeReason = stringFlag(args.flags, "judge-reason") ?? "manual review candidate";
  const proposalApplyState = evidenceProposalApplyStateFlag(args.flags["proposal-apply-state"]);

  return {
    source: {
      kind: stringFlag(args.flags, "source-kind") ?? "manual",
      ref: sourceRef,
      ...(stringFlag(args.flags, "source-collected-at")
        ? { collected_at: stringFlag(args.flags, "source-collected-at") }
        : {}),
    },
    summary,
    citations,
    proposedLesson: {
      text: lesson,
      ...(stringFlag(args.flags, "lesson-scope") ? { scope: stringFlag(args.flags, "lesson-scope") } : {}),
    },
    route: {
      target: stringFlag(args.flags, "route") ?? "memory",
      ...(stringFlag(args.flags, "route-rationale") ? { rationale: stringFlag(args.flags, "route-rationale") } : {}),
    },
    confidence: parseConfidence(args.flags.confidence) ?? "INFERRED",
    blastRadius: {
      scope: stringFlag(args.flags, "blast-radius") ?? "project",
      ...(stringFlag(args.flags, "blast-radius-rationale")
        ? { rationale: stringFlag(args.flags, "blast-radius-rationale") }
        : {}),
    },
    privacyNotes: collectEvidenceFlagValues(args, "privacy-note"),
    judge: {
      score: judgeScore,
      rationale: judgeReason,
    },
    proposalLink: {
      kind: stringFlag(args.flags, "proposal-kind") ?? "none",
      ...(stringFlag(args.flags, "proposal-id") ? { id: stringFlag(args.flags, "proposal-id") } : {}),
      ...(stringFlag(args.flags, "proposal-path") ? { path: stringFlag(args.flags, "proposal-path") } : {}),
      apply_state: proposalApplyState,
    },
  };
}

export function collectEvidenceFlagValues(args: ParsedArgs, key: string): string[] {
  const flag = args.flags[key];
  const values = args.repeatedFlags?.[key] ?? (typeof flag === "string" ? [flag] : []);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export function parseEvidenceCitation(raw: string): EvidenceCitation {
  const [label, uri, ...quoteParts] = raw.split("|").map((part) => part.trim());
  if (!label) throw new Error("--citation needs a non-empty label");
  return {
    label,
    ...(uri ? { uri } : {}),
    ...(quoteParts.length > 0 && quoteParts.join("|") ? { quote: quoteParts.join("|") } : {}),
  };
}

export function evidenceProposalApplyStateFlag(value: string | boolean | undefined): EvidenceProposalApplyState {
  if (value == null || value === false) return "unlinked";
  if (value === true) throw new Error("--proposal-apply-state requires a value");
  if (["unlinked", "pending", "applied", "rejected", "unknown"].includes(value)) {
    return value as EvidenceProposalApplyState;
  }
  throw new Error(`invalid proposal apply state "${value}"`);
}

export function parseEvidenceStatusFilter(value: string | boolean | undefined): EvidenceCardStatus | undefined {
  if (value == null || value === false || value === "all") return undefined;
  if (value === true) throw new Error("--status requires a value");
  if (["pending", "approved", "rejected"].includes(value)) return value as EvidenceCardStatus;
  throw new Error(`invalid evidence status "${value}"`);
}

export function printEvidenceResult(action: string, card: EvidenceCard, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, card }, null, 2));
    return;
  }
  console.log(`memory evidence: ${action} ${card.id}`);
  console.log(`  status: ${card.status}`);
}

export function printGovernedWriteResult(
  result: GovernedWriteResult,
  json: boolean,
): void {
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory store-evidence: ${result.outcome}`);
  console.log(`  reason: ${result.reason}`);
  if (result.memory.urn) console.log(`  memory: ${result.memory.urn}`);
  if (result.review_artifact) {
    console.log(`  review: ${result.review_artifact.kind}:${result.review_artifact.id}`);
    console.log(`  path: ${result.review_artifact.path}`);
  }
  if (result.provenance.source_ref) console.log(`  source: ${result.provenance.source_ref}`);
  if (result.provenance.citation_excerpt) {
    console.log(`  citation: ${result.provenance.citation_excerpt}`);
  }
}

export function printLinkedEvidenceResult(action: string, card: LinkedEvidenceReviewResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, card }, null, 2));
    return;
  }
  console.log(`memory evidence: ${action} ${card.id}`);
  console.log(`  status: ${card.status}`);
  console.log(`  card: ${card.path}`);
  if (card.proposalPath) console.log(`  proposal: ${card.proposalPath}`);
}

export function printEvidenceList(cards: EvidenceCard[]): void {
  console.log(`memory evidence: ${cards.length} ${plural(cards.length, "card")}`);
  for (const card of cards) {
    const privacy = card.privacy.findings.length > 0 ? ` privacy=${card.privacy.findings.length}` : "";
    console.log(
      `  ${card.id} [${card.status}] ${card.summary.slice(0, 100)}${privacy} confidence=${card.confidence}`,
    );
  }
}

export function printEvidenceCard(card: EvidenceCard): void {
  console.log(`memory evidence: ${card.id}`);
  console.log(`contract: ${card.contract}`);
  console.log(`status: ${card.status}`);
  console.log(`summary: ${card.summary}`);
  console.log(`source: ${card.source.kind} ${card.source.ref}`);
  console.log(`citations: ${card.citations.map((citation) => citation.label).join(", ")}`);
  console.log(`proposed lesson: ${card.proposed_lesson.text}`);
  console.log(`route: ${card.route.target}${card.route.rationale ? ` - ${card.route.rationale}` : ""}`);
  console.log(`confidence: ${card.confidence}`);
  console.log(`blast radius: ${card.blast_radius.scope}`);
  const privacyKinds = [...new Set(card.privacy.findings.map((finding) => finding.kind))];
  console.log(`privacy: ${privacyKinds.length > 0 ? privacyKinds.join(", ") : "none"}`);
  console.log(`judge: ${card.judge.score} - ${card.judge.rationale}`);
  console.log(`review: ${card.review.state}${card.review.reason ? ` - ${card.review.reason}` : ""}`);
  console.log(`proposal: ${card.proposal_link.kind} apply_state=${card.proposal_link.apply_state}`);
}

export function parseInboxStatusFilter(value: string | boolean | undefined): InboxStatus | undefined {
  if (value == null || value === false || value === "all") return undefined;
  if (value === true) throw new Error("--status requires a value");
  if (isInboxStatus(value)) return value;
  throw new Error(`invalid inbox status "${value}"`);
}

export function isInboxStatus(value: string): value is InboxStatus {
  return ["quarantined", "approved", "rejected", "promoted"].includes(value);
}

export function scopeContext(flags: Record<string, string | boolean>) {
  const level = parseMemoryScope(flags.scope);
  const id = stringFlag(flags, "scope-id");
  if (!level && !id) return undefined;
  return {
    ...(level ? { level } : {}),
    ...(id ? { id } : {}),
  };
}

export function printInboxResult(action: string, item: MemoryInboxItem, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, item }, null, 2));
    return;
  }
  console.log(`memory inbox: ${action} ${item.id}`);
  if (item.promotedRid != null) console.log(`  promoted node: ${item.promotedRid}`);
}

export function printInboxList(items: MemoryInboxItem[]): void {
  console.log(`memory inbox: ${items.length} ${plural(items.length, "item")}`);
  for (const item of items) {
    const privacy = item.privacyFindings.length > 0 ? ` privacy=${item.privacyFindings.length}` : "";
    console.log(
      `  ${item.id} [${item.status}] ${item.fact.slice(0, 100)}${privacy} confidence=${item.provenance.confidence}`,
    );
  }
}

export function printInboxItem(item: MemoryInboxItem): void {
  console.log(`memory inbox: ${item.id}`);
  console.log(`status: ${item.status}`);
  console.log(`fact: ${item.fact}`);
  console.log(`reason: ${item.reason}`);
  console.log(`evidence: ${item.evidenceSummary}`);
  console.log(
    `classification: ${item.classification.kind} tier=${item.classification.recommendedTier} scope=${item.classification.recommendedScope}`,
  );
  if (item.classification.safetyWarnings.length > 0) {
    console.log(`warnings: ${item.classification.safetyWarnings.join(", ")}`);
  }
  const privacyKinds = [...new Set(item.privacyFindings.map((finding) => finding.kind))];
  console.log(`privacy: ${privacyKinds.length > 0 ? privacyKinds.join(", ") : "none"}`);
  console.log(`provenance: ${formatInboxProvenance(item)}`);
  if (item.rejectionReason) console.log(`rejection: ${item.rejectionReason}`);
  if (item.promotedRid != null) console.log(`promoted node: ${item.promotedRid}`);
}

export function formatInboxProvenance(item: MemoryInboxItem): string {
  const p = item.provenance;
  const parts: string[] = [p.sourceKind];
  if (p.writer) parts.push(`writer=${p.writer}`);
  if (p.command) parts.push(`command=${p.command}`);
  if (p.hook) parts.push(`hook=${p.hook}`);
  parts.push(`confidence=${p.confidence}`);
  if (p.scope?.level) {
    parts.push(`scope=${p.scope.level}${p.scope.id ? `:${p.scope.id}` : ""}`);
  }
  return parts.join(" ");
}

export async function runProvenance(args: ParsedArgs): Promise<void> {
  const target = args.positional.join(" ").trim();
  if (!target) throw new Error("pass a node rid or label: memory provenance <rid|label>");
  const { store } = await openGraphStore(args);
  try {
    const node = await findNodeForProvenance(store, target);
    if (!node) throw new Error(`memory node not found: ${target}`);
    const report = buildProvenanceReport(node);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(formatProvenanceHuman(report));
  } finally {
    await store.close();
  }
}
