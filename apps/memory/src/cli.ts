#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
  type MemoryConfig,
  readConfig,
  resolveL2Policy,
  resolveNotesDir,
  resolveStoreUri,
  skillTelemetryEnabled,
} from "./config.js";
import {
  createMemoryBackup,
  listMemoryBackups,
  readMemoryBackupManifest,
  restoreMemoryBackup,
} from "./backup.js";
import { buildMemoryCapabilityCatalog } from "./capability-catalog.js";
import { buildMemoryCapsule, type MemoryCapsuleSourceKind } from "./capsule.js";
import { buildMemoryAssetInventory } from "./asset-inventory.js";
import { buildMemoryAssetInventoryViewerArtifact } from "./asset-inventory-viewer.js";
import { buildMemoryAgentIntegrationStatus } from "./agent-integration-status.js";
import { buildMemoryAgentIntegrationStatusViewerArtifact } from "./agent-integration-status-viewer.js";
import { buildMemoryReferenceRadar } from "./references-radar.js";
import type { CommunityAnalyticsReport } from "./communities.js";
import { buildCommunitiesViewerArtifact } from "./communities-viewer.js";
import type { CommunityDigestReport } from "./community-digest.js";
import type { MemoryGlobalSearchReport } from "./global-search.js";
import { buildContextPack, type ContextPack } from "./context-pack.js";
import { buildContextPackViewerArtifact } from "./context-pack-viewer.js";
import { claimCheck, type ClaimCheckResult } from "./claim-check.js";
import { buildDocBundle } from "./doc-bundle.js";
import { buildDocBundleViewerArtifact } from "./doc-bundle-viewer.js";
import { buildDocBacklinksReport } from "./doc-backlinks.js";
import { buildDocBacklinksViewerArtifact } from "./doc-backlinks-viewer.js";
import { buildDocCoverageReport } from "./doc-coverage.js";
import { buildDocCoverageViewerArtifact } from "./doc-coverage-viewer.js";
import { buildDocEvidencePack } from "./doc-evidence-pack.js";
import { buildDocEvidencePackViewerArtifact } from "./doc-evidence-pack-viewer.js";
import { buildDocReferenceGraphReport } from "./doc-reference-graph.js";
import { buildDocReferenceGraphViewerArtifact } from "./doc-reference-graph-viewer.js";
import { buildDocRelatedReport } from "./doc-related.js";
import { buildDocRelatedViewerArtifact } from "./doc-related-viewer.js";
import { restoreDocsFromMemory } from "./doc-restore.js";
import { readDoc, searchDocs } from "./doc-search.js";
import { buildDocSearchViewerArtifact } from "./doc-search-viewer.js";
import { diagnose, prune } from "./doctor.js";
import { ask, neighbors, path as shortestPath, search, traverse } from "./engine.js";
import { exportGraph, toEdge } from "./export.js";
import { buildArchitectureOverview } from "./architecture-overview.js";
import {
  buildGraphContract,
  validateGraphContract,
  type GraphContract,
} from "./graph-contract.js";
import {
  extractConversation,
  extractStructuredTranscript,
  factsToGraph,
  resolveProvider,
} from "./extract-conversation.js";
import { buildMemoryExtractionStatus } from "./extraction-status.js";
import { buildMemoryExtractionStatusViewerArtifact } from "./extraction-status-viewer.js";
import { buildCodeDriftReport, type CodeDriftCountGroup } from "./code-drift-report.js";
import {
  aliasEngineeringCode,
  isCuratedSuggestedEngineeringCode,
  loadEngineeringCodeCuration,
  promoteEngineeringCode,
  resolveEngineeringCodeAlias,
  saveEngineeringCodeCuration,
  suggestedEngineeringCodes,
  type EngineeringCodeCurationState,
} from "./code-curation.js";
import { formatOutput, parseInput, type RawPayload } from "./hook-adapters.js";
import { dispatch, type HookEvent, type Runner } from "./hook-runtime.js";
import { refreshFromGit, type VcsEvent } from "./vcs-refresh.js";
import { installGitHooks, uninstallGitHooks } from "./vcs-hooks-install.js";
import { importAmsDump } from "./import-ams.js";
import {
  importComplementaryMapFile,
  type ComplementaryMapSourceKind,
} from "./import-complementary-map.js";
import { runPromote } from "./promote.js";
import { runAfkLifecycle } from "./afk-lifecycle.js";
import {
  approveInboxItem,
  inboxItemToProvenance,
  listInboxItems,
  markInboxItemPromoted,
  quarantineInboxItem,
  readInboxItem,
  rejectInboxItem,
  type InboxStatus,
  type MemoryInboxItem,
} from "./inbox.js";
import {
  approveEvidenceCard,
  createEvidenceCard,
  listEvidenceCards,
  readEvidenceCard,
  rejectEvidenceCard,
  type CreateEvidenceCardInput,
  type EvidenceCard,
  type EvidenceCardStatus,
  type EvidenceCitation,
  type EvidenceProposalApplyState,
} from "./evidence-card.js";
import {
  graphRecallResult,
  renderSignalProvenance,
  type GraphRecallHit,
} from "./graph-recall.js";
import {
  buildMemoryGovernanceReport,
  type MemoryGovernanceReport,
} from "./governance.js";
import { buildMemoryGovernanceViewerArtifact } from "./governance-viewer.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import { buildMemoryMapContextSlice } from "./map-context.js";
import { createMemoryHttpServer } from "./http-server.js";
import { ingestGuidance } from "./audit-marker.js";
import { evaluateDriftGuard } from "./drift-guard.js";
import {
  appendContextPackGenerationEvent,
  appendMemoryEvent,
  appendRecallObservationEvent,
  driftCaughtToMemoryEvent,
} from "./memory-events.js";
import {
  buildRecallTelemetryReport,
  recallObservationFromContextPack,
  renderRecallTelemetryReport,
} from "./recall-telemetry.js";
import {
  collectCandidates,
  ingestProject,
  refreshFiles,
  renderIngestReportToon,
} from "./ingest.js";
import {
  defaultIgnorePatterns,
  formatScopeReport,
  planScope,
  readMemoryIgnore,
  resolvePreset,
  writeMemoryIgnore,
} from "./scope.js";
import { initGraph, initMarkdownOnly } from "./init.js";
import { lintMemory, type LintReport } from "./lint.js";
import { buildMemoryLayersReport } from "./memory-layers.js";
import { buildMemoryLayersViewerArtifact } from "./memory-layers-viewer.js";
import { applyProviderEnv, redDbProviderClient } from "./provider-client.js";
import {
  redactSensitiveValue,
  scanPrivacy,
  type PrivacyFinding,
  type PrivacyReport,
} from "./privacy.js";
import {
  buildProvenanceReport,
  findNodeForProvenance,
  formatProvenanceHuman,
} from "./provenance.js";
import {
  buildSkillRecommendations,
  renderSkillRecommendationsSection,
} from "./skill-recommendations.js";
import { computeProposalPriority, sortProposalSummaries } from "./proposal-priority.js";
import {
  buildPrePrMemoryReview,
  type PrePrMemoryReview,
  type PrePrReviewSection,
} from "./pre-pr-review.js";
import { buildPrePrReviewViewerArtifact } from "./pre-pr-review-viewer.js";
import { bootstrapProjectMemory } from "./project-bootstrap.js";
import { buildLearningDebtReport } from "./learning-debt.js";
import { buildLearningDebtViewerArtifact } from "./learning-debt-viewer.js";
import { buildOnboardingMap } from "./onboarding-map.js";
import { buildOnboardingMapViewerArtifact } from "./onboarding-map-viewer.js";
import { buildMemoryMapFreshnessReport } from "./map-freshness.js";
import {
  buildMemoryOperationalDashboard,
  buildMemoryOperationalDashboardArtifact,
  type MemoryOperationalDashboard,
} from "./operational-dashboard.js";
import { buildConfidenceReport, renderConfidenceMarkdown } from "./confidence.js";
import { buildPathExplainReport } from "./path-explain.js";
import { buildPathExplainViewerArtifact } from "./path-explain-viewer.js";
import { buildPreflightBrief } from "./preflight.js";
import { buildReadinessEnvelope, type MemoryReadinessEnvelope } from "./readiness.js";
import { buildReadinessViewerArtifact } from "./readiness-viewer.js";
import {
  buildMemoryRoutingGuide,
  type MemoryRoutingAgent,
  type MemoryRoutingGuide,
} from "./routing-guide.js";
import { buildMemoryRoutingGuideViewerArtifact } from "./routing-guide-viewer.js";
import { buildSessionTimeline } from "./session-timeline.js";
import { buildSessionTimelineViewerArtifact } from "./session-timeline-viewer.js";
import {
  current as sessionCurrent,
  end as sessionEnd,
  ensure as sessionEnsure,
  start as sessionStart,
} from "./session-manager.js";
import {
  appendEvent as workingAppendEvent,
  getRawTranscript as workingGetRaw,
  listEvents as workingListEvents,
  setRawTranscript as workingSetRaw,
} from "./working-memory.js";
import { evictL2 } from "./working-memory-evict.js";
import {
  executeReadOnlyMemoryOperation,
  listReadOnlyMemoryOperations,
  type ReadOnlyMemoryOperation,
} from "./operations.js";
import {
  executeMemoryOperationFromTransport,
  writeViewerArtifact,
  viewerCliSummary,
} from "./operation-transport-adapter.js";
import { buildMemoryHandoff } from "./handoff.js";
import { buildMemoryHandoffViewerArtifact } from "./handoff-viewer.js";
import { buildWorkFrontier } from "./work-frontier.js";
import { buildWorkFrontierViewerArtifact } from "./work-frontier-viewer.js";
import { buildHookCoverageReport } from "./hook-coverage.js";
import { buildHookCoverageViewerArtifact } from "./hook-coverage-viewer.js";
import {
  buildMemoryHealthReport,
  engineEventHealth,
  type MemoryHealthReport,
} from "./memory-health.js";
import { buildMemoryHealthViewerArtifact } from "./memory-health-viewer.js";
import { buildMemoryDecayReport } from "./memory-decay.js";
import { buildMemoryDecayViewerArtifact } from "./memory-decay-viewer.js";
import {
  memoryStoreEvidence,
  rejectMemoryStoreEvidence,
  type GovernedWriteResult,
  type MemoryStoreEvidenceInput,
} from "./governed-write.js";
import {
  buildMemoryMergePassReport,
  executeMemoryMergeBatch,
  unmergeMemoryMergeBatch,
} from "./memory-merge-pass.js";
import {
  acceptGovernanceTidyRecommendation,
  dismissGovernanceTidyRecommendation,
  refreshGovernanceTidyReviewArtifacts,
} from "./governance-tidy-review.js";
import { recall } from "./recall.js";
import { buildFederationReport } from "./federation.js";
import { runAutoCure } from "./auto-curation.js";
import { buildReasoningReplay } from "./reasoning/reasoning-replay.js";
import { buildWhatifReport, parseWhatifChange, type WhatifChange } from "./whatif.js";
import { buildMemorySmartSearch } from "./smart-search.js";
import { buildMemorySmartSearchViewerArtifact } from "./smart-search-viewer.js";
import { commitMemoryGraph, type MemoryGraphCommitResult } from "./vcs-commit.js";
import { buildVectorSearchReport } from "./vector-search.js";
import { buildVectorStatusViewerArtifact } from "./vector-status-viewer.js";
import { contentHash } from "./hash.js";
import {
  buildMemoryWorkbench,
  buildMemoryWorkbenchArtifact,
} from "./workbench.js";
import {
  structuralImpactReader,
  type StructuralImpact,
  type StructuralImpactTarget,
} from "./structural-impact-reader.js";
import { buildStructuralImpactViewerArtifact } from "./structural-impact-viewer.js";
import {
  listContradictions,
  resolveConflict,
  supersessionTimeline,
  type ContradictionSummary,
  type TopicTimeline,
} from "./supersession.js";
import { classifyCandidateMemory } from "./store-classifier.js";
import {
  recordReasoningAttempt,
  type ReasoningAttemptPayload,
} from "./reasoning/attempt-writer.js";
import {
  applyAttemptLearningProposal,
  buildAttemptLearningReport,
  parseAttemptLearningProposal,
  writeAttemptLearningProposalFile,
} from "./reasoning/learning-proposals.js";
import {
  ingestSkillEvents,
  parseSkillEvent,
  parseSkillEventInput,
  readRecentSkillEvents,
  readSkillRollups,
  type SkillEventSummary,
  type SkillRollup,
} from "./skill-events.js";
import { curateSkills, isCuratable, rollupsToCuratorInput } from "./skill-curator.js";
import { runCurateWorkflow } from "./curate-skill/workflow.js";
import type { CuratorReportEnvelope } from "./curate-skill/types.js";
import type { Confidence, MemoryLayer, MemoryProvenance, MemoryScope } from "./schema.js";
import { slugify, storeNote } from "./store.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseLooseArgs, type LooseParsedArgs } from "@reddb-io/shared/args.js";
import { renderToonOutput } from "./toon-output.js";

const USAGE = `memory — governed operational memory for code agents

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
to whichever mode init configured.`;

type ParsedArgs = LooseParsedArgs;

const execFileAsync = promisify(execFile);
const LEGACY_CLI_OPERATION_IDS = new Set(["memory.health"]);
const LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND: Readonly<Record<string, readonly string[]>> = {
  "merge-pass": ["execute", "unmerge"],
  "onboarding-map": ["export"],
  "tidy-review": ["refresh", "accept", "dismiss"],
};
const PROOF_REGISTRY_CLI_COMMANDS = new Set(["docs brief", "docs brief-viewer"]);
const REGISTRY_CLI_OPERATIONS = new Map<string, ReadOnlyMemoryOperation>(
  listReadOnlyMemoryOperations()
    .filter((operation) => !LEGACY_CLI_OPERATION_IDS.has(operation.id))
    .map((operation) => [operation.renderer.cli.command, operation]),
);

function rootOf(flags: Record<string, string | boolean>): string {
  return typeof flags.root === "string" ? flags.root : process.cwd();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const MEMORY_SCOPES: readonly MemoryScope[] = [
  "user",
  "project",
  "repo",
  "branch",
  "worktree",
  "session",
  "agent-run",
];

function parseMemoryScope(value: string | boolean | undefined): MemoryScope | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--scope requires a value");
  if ((MEMORY_SCOPES as readonly string[]).includes(value)) return value as MemoryScope;
  throw new Error(`invalid memory scope "${value}"`);
}

const MEMORY_LAYERS: readonly MemoryLayer[] = ["L1", "L2", "L3"];

function parseLayerFlag(value: string | boolean | undefined): MemoryLayer | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--layer requires a value (L1|L2|L3)");
  const upper = value.toUpperCase();
  if ((MEMORY_LAYERS as readonly string[]).includes(upper)) return upper as MemoryLayer;
  throw new Error(`invalid memory layer "${value}" — expected L1, L2, or L3`);
}

const CONFIDENCE_VALUES: readonly Confidence[] = ["EXTRACTED", "INFERRED", "AMBIGUOUS"];

function parseConfidence(value: string | boolean | undefined): Confidence | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--confidence requires a value");
  if ((CONFIDENCE_VALUES as readonly string[]).includes(value)) return value as Confidence;
  throw new Error(`invalid confidence "${value}"`);
}

const SOURCE_KINDS: readonly MemoryProvenance["source_kind"][] = [
  "manual",
  "hook",
  "derived",
  "system",
  "external-map",
];

function parseSourceKind(
  value: string | boolean | undefined,
): MemoryProvenance["source_kind"] | undefined {
  if (value == null || value === false) return undefined;
  if (value === true) throw new Error("--source-kind requires a value");
  if ((SOURCE_KINDS as readonly string[]).includes(value)) {
    return value as MemoryProvenance["source_kind"];
  }
  throw new Error(`invalid source kind "${value}"`);
}

function scopeFlags(flags: Record<string, string | boolean>) {
  const level = parseMemoryScope(flags.scope);
  if (!level) return undefined;
  return {
    level,
    id: typeof flags["scope-id"] === "string" ? flags["scope-id"] : undefined,
    includeNarrower: flags["include-narrower-scopes"] === true,
  };
}

async function requireConfig(rootDir: string) {
  const config = await readConfig(rootDir);
  if (!config) {
    throw new Error("memory is not initialized here — run `memory init` first");
  }
  return config;
}

async function runInit(args: ParsedArgs): Promise<void> {
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

async function runStore(args: ParsedArgs): Promise<void> {
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

async function runStoreEvidence(args: ParsedArgs): Promise<void> {
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

async function runCommit(args: ParsedArgs): Promise<void> {
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

function printCommitResult(result: MemoryGraphCommitResult): void {
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

async function runInbox(args: ParsedArgs): Promise<void> {
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

async function runEvidence(args: ParsedArgs): Promise<void> {
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

interface LinkedEvidenceReviewResult {
  id: string;
  status: "approved" | "rejected";
  path: string;
  proposalPath?: string;
}

async function approveLinkedEvidenceCard(
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

async function rejectLinkedEvidenceCard(
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

async function findLinkedEvidenceCard(rootDir: string, id: string): Promise<{ path: string; body: string } | null> {
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

function withLinkedEvidenceReview(
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

async function markProposalEvidenceRejected(
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

function firstYamlScalar(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(key)}: (.+)$`, "m"));
  return match ? unquoteYamlScalar(match[1]) : null;
}

function firstNestedYamlScalar(body: string, parent: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(parent)}:\\n(?:  .+\\n)*?  ${escapeRegExp(key)}: (.+)$`, "m"));
  return match ? unquoteYamlScalar(match[1]) : null;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) return JSON.parse(trimmed) as string;
  return trimmed;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function evidenceCardInputFromFlags(args: ParsedArgs): CreateEvidenceCardInput {
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

function collectEvidenceFlagValues(args: ParsedArgs, key: string): string[] {
  const values = collectRepeatedFlag(process.argv.slice(2), key);
  const single = stringFlag(args.flags, key);
  if (values.length === 0 && single) values.push(single);
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function parseEvidenceCitation(raw: string): EvidenceCitation {
  const [label, uri, ...quoteParts] = raw.split("|").map((part) => part.trim());
  if (!label) throw new Error("--citation needs a non-empty label");
  return {
    label,
    ...(uri ? { uri } : {}),
    ...(quoteParts.length > 0 && quoteParts.join("|") ? { quote: quoteParts.join("|") } : {}),
  };
}

function evidenceProposalApplyStateFlag(value: string | boolean | undefined): EvidenceProposalApplyState {
  if (value == null || value === false) return "unlinked";
  if (value === true) throw new Error("--proposal-apply-state requires a value");
  if (["unlinked", "pending", "applied", "rejected", "unknown"].includes(value)) {
    return value as EvidenceProposalApplyState;
  }
  throw new Error(`invalid proposal apply state "${value}"`);
}

function parseEvidenceStatusFilter(value: string | boolean | undefined): EvidenceCardStatus | undefined {
  if (value == null || value === false || value === "all") return undefined;
  if (value === true) throw new Error("--status requires a value");
  if (["pending", "approved", "rejected"].includes(value)) return value as EvidenceCardStatus;
  throw new Error(`invalid evidence status "${value}"`);
}

function printEvidenceResult(action: string, card: EvidenceCard, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, card }, null, 2));
    return;
  }
  console.log(`memory evidence: ${action} ${card.id}`);
  console.log(`  status: ${card.status}`);
}

function printGovernedWriteResult(
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

function printLinkedEvidenceResult(action: string, card: LinkedEvidenceReviewResult, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, card }, null, 2));
    return;
  }
  console.log(`memory evidence: ${action} ${card.id}`);
  console.log(`  status: ${card.status}`);
  console.log(`  card: ${card.path}`);
  if (card.proposalPath) console.log(`  proposal: ${card.proposalPath}`);
}

function printEvidenceList(cards: EvidenceCard[]): void {
  console.log(`memory evidence: ${cards.length} ${plural(cards.length, "card")}`);
  for (const card of cards) {
    const privacy = card.privacy.findings.length > 0 ? ` privacy=${card.privacy.findings.length}` : "";
    console.log(
      `  ${card.id} [${card.status}] ${card.summary.slice(0, 100)}${privacy} confidence=${card.confidence}`,
    );
  }
}

function printEvidenceCard(card: EvidenceCard): void {
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

function parseInboxStatusFilter(value: string | boolean | undefined): InboxStatus | undefined {
  if (value == null || value === false || value === "all") return undefined;
  if (value === true) throw new Error("--status requires a value");
  if (isInboxStatus(value)) return value;
  throw new Error(`invalid inbox status "${value}"`);
}

function isInboxStatus(value: string): value is InboxStatus {
  return ["quarantined", "approved", "rejected", "promoted"].includes(value);
}

function scopeContext(flags: Record<string, string | boolean>) {
  const level = parseMemoryScope(flags.scope);
  const id = stringFlag(flags, "scope-id");
  if (!level && !id) return undefined;
  return {
    ...(level ? { level } : {}),
    ...(id ? { id } : {}),
  };
}

function printInboxResult(action: string, item: MemoryInboxItem, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ state: action, item }, null, 2));
    return;
  }
  console.log(`memory inbox: ${action} ${item.id}`);
  if (item.promotedRid != null) console.log(`  promoted node: ${item.promotedRid}`);
}

function printInboxList(items: MemoryInboxItem[]): void {
  console.log(`memory inbox: ${items.length} ${plural(items.length, "item")}`);
  for (const item of items) {
    const privacy = item.privacyFindings.length > 0 ? ` privacy=${item.privacyFindings.length}` : "";
    console.log(
      `  ${item.id} [${item.status}] ${item.fact.slice(0, 100)}${privacy} confidence=${item.provenance.confidence}`,
    );
  }
}

function printInboxItem(item: MemoryInboxItem): void {
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

function formatInboxProvenance(item: MemoryInboxItem): string {
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

async function runProvenance(args: ParsedArgs): Promise<void> {
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

async function runClassify(args: ParsedArgs): Promise<void> {
  const candidate = args.positional.join(" ").trim();
  const result = classifyCandidateMemory(candidate);
  if (args.flags.json === true) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`memory classify: ${result.kind}`);
  console.log(`  tier: ${result.recommendedTier}`);
  console.log(`  scope: ${result.recommendedScope}`);
  if (result.safetyWarnings.length > 0) {
    console.log(`  warnings: ${result.safetyWarnings.join("; ")}`);
  }
  console.log(`  ${result.explanation}`);
}

async function runRecall(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to recall — pass a query: memory recall <query>");
  const config = await requireConfig(rootDir);
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : 10;
  const requestedLayer = parseLayerFlag(args.flags.layer);
  // Today only L3 is populated; explicit non-L3 requests return empty rather
  // than silently falling back to L3 (PRD #174 prepares the L1/L2 surfaces).
  const layerFiltersOut = requestedLayer != null && requestedLayer !== "L3";

  if (config.mode === "graph") {
    const asOf = stringFlag(args.flags, "as-of");
    const store = asOf
      ? await HistoricalMemoryStore.open({ uri: resolveStoreUri(rootDir, config), ref: asOf })
      : await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const { hits: rawHits, diagnostics } = await graphRecallResult(store, query, limit, {
        includeSuperseded: args.flags["include-superseded"] === true,
        scope: scopeFlags(args.flags),
        now: asOf ? 0 : undefined,
        ranking: config.recallRanking,
      });
      const hits = layerFiltersOut ? [] : rawHits;
      if (args.flags.json === true) {
        printLegacyGraphRecall(query, hits, diagnostics);
        return;
      }
      if (hits.length === 0) {
        printRecallToon({
          items: [],
          query,
          store: "graph",
          ranking: "hybrid-rrf",
          vector: diagnostics.vector,
        });
        return;
      }
      printRecallToon({
        items: hits.map((hit) => ({
          id: hit.id,
          score: hit.score,
          kind: hit.node_type,
          content: `${hit.label} ${hit.excerpt}`.trim(),
        })),
        query,
        store: "graph",
        ranking: "hybrid-rrf",
        vector: diagnostics.vector,
      });
    } finally {
      await store.close();
    }
    return;
  }

  const hits = layerFiltersOut
    ? []
    : await recall(resolveNotesDir(rootDir, config), query, limit);
  if (args.flags.json === true) {
    printLegacyMarkdownRecall(query, hits);
    return;
  }
  if (hits.length === 0) {
    printRecallToon({
      items: [],
      query,
      store: "markdown",
      ranking: "term-count",
    });
    return;
  }
  printRecallToon({
    items: hits.map((hit) => ({
      id: hit.id,
      score: hit.score,
      kind: "note",
      content: hit.excerpt,
    })),
    query,
    store: "markdown",
    ranking: "term-count",
  });
}

type RecallToonItem = {
  id: string;
  score: number;
  kind: string;
  content: string;
};

function printRecallToon(opts: {
  items: RecallToonItem[];
  query: string;
  store: "markdown" | "graph";
  ranking: string;
  vector?: {
    status: "unavailable" | "available" | "contributed";
    candidates: number;
    contributed: number;
    reason?: string;
  };
}): void {
  const zero = opts.items.length === 0;
  console.log(
    renderToonOutput({
      rowsKey: "items",
      rows: opts.items,
      fields: ["id", "score", "kind", "content"],
      summary: {
        status: zero ? "0 results" : `${opts.items.length} results`,
        results: opts.items.length,
        query: opts.query,
        store: opts.store,
        ranking: opts.ranking,
        ...(opts.vector ? { vector: opts.vector } : {}),
      },
      extra: zero
        ? {
            next: 'try `memory store "..."` to add governed context, then rerun recall',
          }
        : {},
    }),
  );
}

function printLegacyMarkdownRecall(query: string, hits: Array<{ id: string; score: number; excerpt: string }>): void {
  if (hits.length === 0) {
    console.log(`memory: no matches for "${query}"`);
    return;
  }
  console.log(`memory: ${hits.length} match(es) for "${query}"`);
  for (const hit of hits) {
    console.log(`  [${hit.score}] ${hit.id}`);
    console.log(`        ${hit.excerpt}`);
  }
}

function printLegacyGraphRecall(
  query: string,
  hits: GraphRecallHit[],
  diagnostics: { vector: Parameters<typeof formatVectorRecallDiagnostic>[0] },
): void {
  if (hits.length === 0) {
    console.log(`memory: no matches for "${query}"`);
    console.log(`  ${formatVectorRecallDiagnostic(diagnostics.vector)}`);
    return;
  }
  console.log(`memory: ${hits.length} match(es) for "${query}"`);
  console.log(`  ${formatVectorRecallDiagnostic(diagnostics.vector)}`);
  for (const hit of hits) {
    console.log(`  [${hit.score}] ${hit.id} (${hit.node_type}) ${hit.label}`);
    console.log(`        ${hit.excerpt}`);
    for (const line of renderSignalProvenance(hit.signal_provenance)) {
      console.log(`        ${line}`);
    }
    if (hit.hooks && hit.hooks.length > 0) {
      const parts = hit.hooks.map((h) => `${h.lifecycle}=${h.exit_code}`);
      console.log(`        hooks: ${parts.join(", ")}`);
    }
    if (hit.superseded_by != null) {
      const window = [
        hit.valid_from != null ? `valid_from=${hit.valid_from}` : "",
        hit.valid_until != null ? `valid_until=${hit.valid_until}` : "",
      ]
        .filter(Boolean)
        .join(" ");
      console.log(
        `        lineage: superseded_by=memory_nodes:${hit.superseded_by}${window ? ` ${window}` : ""}`,
      );
    }
  }
}

async function runFederate(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = (stringFlag(args.flags, "query") ?? args.positional.join(" ")).trim();
  if (!query) {
    throw new Error(
      'nothing to federate — pass --query "<topic>" or memory federate <topic>',
    );
  }
  const report = await buildFederationReport(rootDir, query, {
    limit: intFlag(args.flags, "limit"),
    perRootLimit: intFlag(args.flags, "per-root-limit"),
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(
    `memory federate: "${report.query}" — ${report.results.length} hit(s) across ${report.roots_queried} root(s)`,
  );
  if (report.roots_queried === 0) {
    console.log("  no federation roots configured (.red/memory/federation.yaml)");
    return;
  }
  for (const root of report.roots) {
    const tag = root.status === "ok" ? `${root.hits} hit(s)` : root.status;
    console.log(`  root ${root.origin_repo}: ${tag}`);
  }
  for (const result of report.results) {
    console.log(`  [${result.score}] @${result.origin_repo} ${result.id}`);
    console.log(`        ${result.excerpt}`);
  }
}

async function runAutocure(args: ParsedArgs): Promise<void> {
  const apply = args.flags.apply === true;
  const { store } = await openGraphStore(args);
  try {
    const report = await runAutoCure(store, {
      apply,
      staleDays: intFlag(args.flags, "stale-days"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    const mode = report.dry_run ? "dry-run" : "apply";
    console.log(
      `memory autocure (${mode}): ${report.actions_proposed.length} proposed, ${report.actions_applied.length} applied, ${report.skipped_claim_guarded.length} skipped (claim-guarded)`,
    );
    console.log(
      `  entropy: ${report.entropy_before} -> ${report.entropy_after} (nodes=${report.totals.nodes}, edges=${report.totals.edges}, claim_guarded=${report.totals.claim_guarded})`,
    );
    for (const [kind, counts] of Object.entries(report.by_kind)) {
      if (counts.proposed === 0 && counts.applied === 0) continue;
      console.log(`  ${kind}: proposed=${counts.proposed} applied=${counts.applied}`);
    }
    for (const action of report.actions_proposed.slice(0, 10)) {
      const target = `${action.target.node_type}:${action.target.label}#${action.target.rid}`;
      const peer = action.with
        ? ` -> ${action.with.node_type}:${action.with.label}#${action.with.rid}`
        : "";
      console.log(`  [${action.kind}] ${target}${peer}`);
      console.log(`        ${action.reason}`);
    }
    if (report.skipped_claim_guarded.length > 0) {
      console.log("  claim-guarded (skipped):");
      for (const action of report.skipped_claim_guarded.slice(0, 10)) {
        console.log(`    ${action.kind} on #${action.target.rid}`);
      }
    }
    if (report.dry_run) {
      console.log("\nRe-run with --apply to mutate (claim-guarded nodes still skipped).");
    }
  } finally {
    await store.close();
  }
}

async function runReasoningReplay(args: ParsedArgs): Promise<void> {
  const task = (stringFlag(args.flags, "task") ?? args.positional.join(" ")).trim();
  if (!task) {
    throw new Error(
      "nothing to replay — pass --task \"<descriptor>\" or memory reasoning-replay <descriptor>",
    );
  }
  const { store } = await openGraphStore(args);
  try {
    const report = await buildReasoningReplay(store, task, {
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory reasoning-replay: "${report.task}" — ${report.results.length}/${report.total_attempts} attempt(s)`,
    );
    if (report.results.length === 0) {
      console.log("  no past attempts in the reasoning tier yet");
      return;
    }
    for (const result of report.results) {
      console.log(
        `  [${result.similarity.toFixed(4)}] ${result.attempt_id}  ${result.when}`,
      );
      console.log(`        ${result.summary}`);
    }
  } finally {
    await store.close();
  }
}

async function runWhatif(args: ParsedArgs): Promise<void> {
  // Collect every `--change <value>` from process.argv since the shared
  // parser only keeps the last value per flag.
  const rawChanges = collectRepeatedFlag(process.argv.slice(2), "change");
  const positionalChanges = args.positional.filter((p) => p.length > 0);
  const sources = [...rawChanges, ...positionalChanges];
  if (sources.length === 0) {
    throw new Error(
      'nothing to evaluate — pass one or more --change "<descriptor>" or memory whatif "<descriptor>" ["<descriptor>" ...]',
    );
  }
  const changes: WhatifChange[] = sources.map(parseWhatifChange);
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWhatifReport(store, changes, {
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory whatif: ${report.changes.length} change(s) — breakage_likelihood ${report.breakage_likelihood.toFixed(3)} (self_confidence ${report.self_confidence.toFixed(2)})`,
    );
    console.log(
      `  affected: ${report.affected.files.length} file(s), ${report.affected.symbols.length} symbol(s), ${report.affected.tests.length} test(s)`,
    );
    for (const file of report.affected.files.slice(0, 8)) {
      console.log(`    file  ${file}`);
    }
    for (const symbol of report.affected.symbols.slice(0, 8)) {
      console.log(`    sym   ${symbol}`);
    }
    if (report.historical_attempts.length === 0) {
      console.log("  no similar past attempts in the reasoning tier");
    } else {
      console.log(`  historical attempts (${report.historical_attempts.length}):`);
      for (const attempt of report.historical_attempts) {
        console.log(
          `    [${attempt.similarity.toFixed(3)}] ${attempt.attempt_id} (${attempt.outcome})  ${attempt.when}`,
        );
      }
    }
  } finally {
    await store.close();
  }
}

function collectRepeatedFlag(argv: string[], key: string): string[] {
  const flag = `--${key}`;
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const value = argv[i + 1];
    if (value !== undefined && !value.startsWith("--")) {
      out.push(value);
      i++;
    }
  }
  return out;
}

async function runSmartSearch(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to search — pass a query: memory smart-search <query>");
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemorySmartSearch(store, query, {
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      recall: {
        scope: scopeFlags(args.flags),
        includeSuperseded: args.flags["include-superseded"] === true,
      },
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory smart-search: "${query}"`);
    console.log(
      `  recall=${report.summary.recall_hits} docs=${report.summary.doc_hits} vector=${report.summary.vector_hits} (${report.summary.vector_status})`,
    );
    for (const result of report.top_results.slice(0, 8)) {
      const ref = result.ref.path ?? result.ref.label ?? result.ref.rid ?? result.id;
      console.log(
        `  #${result.rank} ${result.kind} [${result.score.toFixed(3)}] ${ref} (${result.sources.join("+")})`,
      );
      console.log(`      ${result.excerpt}`);
    }
    for (const action of report.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

async function runSmartSearchViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) {
    throw new Error("nothing to render — pass a query: memory smart-search-viewer <query>");
  }
  const safeName = createHash("sha256").update(query).digest("hex").slice(0, 12);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, `.red/memory/smart-search-${safeName}.html`),
  );
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemorySmartSearch(store, query, {
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      recall: {
        scope: scopeFlags(args.flags),
        includeSuperseded: args.flags["include-superseded"] === true,
      },
    });
    const artifact = buildMemorySmartSearchViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: smart-search viewer written ${outPath}`);
    console.log(`  results: ${report.top_results.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

function formatVectorRecallDiagnostic(d: {
  status: "unavailable" | "available" | "contributed";
  candidates: number;
  contributed: number;
  reason?: string;
}): string {
  if (d.status === "contributed") {
    return `vector retrieval contributed ${d.contributed} candidate(s)`;
  }
  if (d.status === "available") {
    return "vector retrieval available; 0 candidate(s) contributed";
  }
  const reason = d.reason ? `: ${d.reason}` : "";
  return `vector retrieval unavailable${reason}`;
}

async function runContextPack(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to pack — pass a goal: memory context-pack <goal>");
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `context-pack needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const budgetChars =
    typeof args.flags.budget === "string" ? Number(args.flags.budget) : undefined;
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : undefined;
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const skillRollups = await readSkillRollups(store);
    const pack = await buildContextPack(store, goal, {
      budgetChars,
      limit,
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    await appendContextPackGenerationEvent(store, {
      pack,
      surface: "cli",
      metadata: { command: "context-pack", json: args.flags.json === true },
    });
    // Recall telemetry from a real run (#828): additive, never blocks the pack.
    await appendRecallObservationEvent(
      store,
      recallObservationFromContextPack(pack, { surface: "context-pack" }),
    );
    if (args.flags.json === true) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }
    printContextPackToon(pack);
  } finally {
    await store.close();
  }
}

type ContextPackToonEntry = {
  section: string;
  title: string;
  nodeType: string;
  importance: number;
  confidence: string;
  trust: number;
  citation: string;
  reason: string;
  excerpt: string;
  expandHandle: string;
};

function printContextPackToon(pack: ContextPack): void {
  const rows: ContextPackToonEntry[] = pack.entries.map((entry) => ({
    section: entry.section,
    title: entry.title,
    nodeType: entry.nodeType,
    importance: entry.importance,
    confidence: entry.confidence,
    trust: entry.trust,
    citation: entry.citation.urn,
    reason: entry.reason,
    excerpt: entry.excerpt,
    expandHandle: entry.expandHandle,
  }));
  console.log(
    renderToonOutput({
      rowsKey: "entries",
      rows,
      fields: [
        "section",
        "title",
        "nodeType",
        "importance",
        "confidence",
        "trust",
        "citation",
        "reason",
        "excerpt",
        "expandHandle",
      ],
      summary: {
        status: pack.status,
        goal: pack.goal,
        entries: pack.entries.length,
        coreContext: pack.coreContext.length,
        warnings: pack.warnings.length,
        omittedEntries: pack.omittedEntries,
        budgetChars: pack.budgetChars,
        usedChars: pack.usedChars,
      },
      extra: {
        warnings: pack.warnings.map((warning) => ({
          kind: warning.kind,
          message: warning.message,
        })),
        ...(pack.entries.length === 0
          ? {
              next: 'run `memory store "..." --root <root>` or `memory ingest . --root <root>`, then rerun context-pack',
            }
          : {}),
      },
    }),
  );
}

async function runCapsule(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to package — pass a goal: memory capsule <goal>");
  const { store } = await openGraphStore(args);
  try {
    const source = capsuleSourceFlag(args.flags);
    const skillRollups = source === "context-pack" ? await readSkillRollups(store) : [];
    const capsule = await buildMemoryCapsule(store, goal, {
      source,
      budgetChars: intFlag(args.flags, "budget"),
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(capsule, null, 2));
      return;
    }
    process.stdout.write(capsule.markdown);
  } finally {
    await store.close();
  }
}

function capsuleSourceFlag(flags: ParsedArgs["flags"]): MemoryCapsuleSourceKind {
  const source = stringFlag(flags, "source") ?? "context-pack";
  if (source === "context-pack" || source === "handoff") return source;
  throw new Error(`invalid capsule source "${source}" — expected context-pack or handoff`);
}

async function runContextPackViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const goal = args.positional.join(" ").trim();
  if (!goal) {
    throw new Error("nothing to inspect — pass a goal: memory context-pack-viewer <goal>");
  }
  const { store } = await openGraphStore(args);
  try {
    const skillRollups = await readSkillRollups(store);
    const pack = await buildContextPack(store, goal, {
      budgetChars: intFlag(args.flags, "budget"),
      limit: intFlag(args.flags, "limit"),
      depth: intFlag(args.flags, "depth"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    const artifact = buildContextPackViewerArtifact(pack);
    const safeName = slugify(goal).slice(0, 60) || "context-pack";
    const outPath = resolve(
      stringFlag(args.flags, "out") ??
        join(rootDir, `.red/memory/context-pack-${safeName}.html`),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    await appendContextPackGenerationEvent(store, {
      pack,
      surface: "cli-viewer",
      metadata: { command: "context-pack-viewer", out_path: outPath },
    });
    console.log(`memory: context pack viewer written ${outPath}`);
    console.log(`  status: ${pack.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runRecommend(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind !== "skills") {
    throw new Error("recommend needs a kind — supported: memory recommend skills <task>");
  }
  const task = args.positional.slice(1).join(" ").trim();
  if (!task) throw new Error("nothing to recommend — pass a task: memory recommend skills <task>");

  const { store } = await openGraphStore(args);
  try {
    const skillRollups = await readSkillRollups(store);
    const report = await buildSkillRecommendations(store, task, {
      limit: intFlag(args.flags, "limit"),
      scope: scopeFlags(args.flags),
      skillRollups,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory: skill recommendations for "${task}"`);
    process.stdout.write(renderSkillRecommendationsSection(report));
  } finally {
    await store.close();
  }
}

async function runPreflight(args: ParsedArgs): Promise<void> {
  const task = args.positional.join(" ").trim();
  if (!task) throw new Error("nothing to brief — pass a task: memory preflight <task>");
  const { store } = await openGraphStore(args);
  try {
    const brief = await buildPreflightBrief(store, task, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(brief, null, 2));
      return;
    }
    process.stdout.write(brief.markdown);
  } finally {
    await store.close();
  }
}

async function runReadiness(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) throw new Error("nothing to assess — pass a goal: memory readiness <goal>");
  const { store } = await openGraphStore(args);
  try {
    const envelope = await buildReadinessEnvelope(store, goal, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(envelope, null, 2));
      return;
    }
    printReadinessEnvelope(envelope);
  } finally {
    await store.close();
  }
}

async function runReadinessViewer(args: ParsedArgs): Promise<void> {
  const goal = args.positional.join(" ").trim();
  if (!goal) {
    throw new Error("nothing to inspect — pass a goal: memory readiness-viewer <goal>");
  }
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/readiness-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const envelope = await buildReadinessEnvelope(store, goal, {
      limit: intFlag(args.flags, "limit"),
      minEvidence: intFlag(args.flags, "min-evidence"),
      staleDays: intFlag(args.flags, "stale-days"),
      scope: scopeFlags(args.flags),
    });
    const artifact = buildReadinessViewerArtifact(envelope);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: readiness viewer written ${outPath}`);
    console.log(`  goal: ${envelope.request.goal}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runDashboard(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const dashboard = await buildMemoryOperationalDashboard(store, rootDir, {
      staleDays: intFlag(args.flags, "stale-days"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(dashboard, null, 2));
      return;
    }
    const outFlag = stringFlag(args.flags, "out");
    if (outFlag !== undefined) {
      const outPath = resolve(outFlag);
      const artifact = buildMemoryOperationalDashboardArtifact(dashboard);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, artifact.html, "utf8");
      console.log(`memory: operational dashboard written ${outPath}`);
      console.log(`  state: ${dashboard.state}`);
      console.log(`  contract: ${artifact.contract.consumes}`);
      return;
    }
    printDashboardToon(dashboard);
  } finally {
    await store.close();
  }
}

type DashboardToonSection = {
  area: string;
  status: string;
  metric: string;
  value: number;
  detail: string;
};

function printDashboardToon(dashboard: MemoryOperationalDashboard): void {
  const sections: DashboardToonSection[] = [
    {
      area: "stats",
      status: dashboard.state,
      metric: "nodes",
      value: dashboard.stats.nodes,
      detail: `${dashboard.stats.docs} docs; ${dashboard.stats.edges} edges`,
    },
    {
      area: "vector",
      status: dashboard.vector.overall,
      metric: "ready",
      value: dashboard.vector.ready,
      detail: `${dashboard.vector.total} total; ${dashboard.vector.unavailable} unavailable; ${dashboard.vector.failed} failed`,
    },
    {
      area: "docs",
      status: dashboard.docs.ungrounded > 0 ? "attention" : "ready",
      metric: "grounded",
      value: dashboard.docs.grounded,
      detail: `${dashboard.docs.total} total; ${dashboard.docs.warnings} warning(s)`,
    },
    {
      area: "hooks",
      status: dashboard.hooks.actionable_gaps > 0 ? "attention" : "ready",
      metric: "wired_events",
      value: dashboard.hooks.wired_events,
      detail: `${dashboard.hooks.enabled_events} enabled; ${dashboard.hooks.actionable_gaps} actionable gap(s)`,
    },
    {
      area: "extraction",
      status: dashboard.extraction.inferred_available ? "ready" : "unavailable",
      metric: "inferred_facts",
      value: dashboard.extraction.inferred_facts,
      detail: dashboard.extraction.egress ?? "no inferred extraction egress",
    },
    {
      area: "stale",
      status: dashboard.stale.stale_nodes > 0 ? "attention" : "ready",
      metric: "stale_nodes",
      value: dashboard.stale.stale_nodes,
      detail: `${dashboard.stale.total_nodes} total; ${dashboard.stale.stale_days} day policy`,
    },
    {
      area: "decay",
      status: dashboard.decay.status,
      metric: "review",
      value: dashboard.decay.review,
      detail: `${dashboard.decay.keep} keep; ${dashboard.decay.deprecate} deprecate; ${dashboard.decay.expire} expire`,
    },
  ];
  const empty = dashboard.stats.nodes === 0 && dashboard.stats.docs === 0;
  console.log(
    renderToonOutput({
      rowsKey: "sections",
      rows: sections,
      fields: ["area", "status", "metric", "value", "detail"],
      summary: {
        status: empty ? "empty" : dashboard.state,
        state: dashboard.state,
        nodes: dashboard.stats.nodes,
        edges: dashboard.stats.edges,
        docs: dashboard.stats.docs,
        warnings: dashboard.warnings.length,
        actions: dashboard.recommended_next_actions.length + (empty ? 1 : 0),
        schema: dashboard.schema_version,
      },
      extra: {
        warnings: dashboard.warnings.map((message) => ({ message })),
        next: [
          ...dashboard.recommended_next_actions.map((action) => ({ action })),
          ...(empty
            ? [{ action: "run `memory ingest . --root <root>` to populate dashboard evidence" }]
            : []),
        ],
      },
    }),
  );
}

async function runWorkbench(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const workbench = await buildMemoryWorkbench(store, rootDir, {
      staleDays: intFlag(args.flags, "stale-days"),
      sessionId: stringFlag(args.flags, "session"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(workbench, null, 2));
      return;
    }
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/workbench.html"),
    );
    const artifact = buildMemoryWorkbenchArtifact(workbench);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: workbench written ${outPath}`);
    console.log(`  state: ${workbench.dashboard.state}`);
    console.log(`  contract: ${artifact.contract.consumes.join(", ")}`);
  } finally {
    await store.close();
  }
}

async function runCapabilities(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const catalog = await buildMemoryCapabilityCatalog(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(catalog, null, 2));
      return;
    }
    console.log(
      `memory capabilities: ${catalog.summary.ready}/${catalog.summary.total} ready, ${catalog.summary.red_db_backed} RedDB-backed`,
    );
    for (const item of catalog.capabilities) {
      console.log(`  ${item.category}/${item.id}: ${item.status}`);
      if (item.cli.length > 0) console.log(`      cli: ${item.cli.join(", ")}`);
      if (item.mcp.length > 0) console.log(`      mcp: ${item.mcp.join(", ")}`);
    }
  } finally {
    await store.close();
  }
}

async function runReferenceRadar(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const { store } = await openGraphStore(args);
  try {
    const radar = await buildMemoryReferenceRadar(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(radar, null, 2));
      return;
    }
    console.log(
      `memory references radar: ${radar.summary.references} reference(s), ${radar.summary.degraded_or_not_configured} gap signal(s)`,
    );
    console.log(`  note: ${radar.note}`);
    for (const reference of radar.references) {
      console.log(
        `  ${reference.repository}: ${reference.posture} score=${reference.score.toFixed(3)} capabilities=${reference.relevant_capabilities}`,
      );
      for (const gap of reference.gaps) {
        console.log(`      gap: ${gap.capability_id} (${gap.status}) -> ${gap.next_action}`);
      }
    }
  } finally {
    await store.close();
  }
}

async function runMemoryLayers(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryLayersReport(store);
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory layers: ${report.summary.ready_layers}/${report.summary.total_layers} ready, ${report.summary.red_db_backed_layers} RedDB-backed`,
    );
    for (const layer of report.layers) {
      console.log(`  ${layer.id}: ${layer.status}`);
      const counts = Object.entries(layer.counts)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ");
      if (counts) console.log(`      ${counts}`);
    }
  } finally {
    await store.close();
  }
}

async function runMemoryLayersViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/layers-viewer.html"),
    );
    const report = await buildMemoryLayersReport(store);
    const artifact = buildMemoryLayersViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: layers viewer written ${outPath}`);
    console.log(
      `  ready: ${report.summary.ready_layers}/${report.summary.total_layers}`,
    );
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runHandoff(args: ParsedArgs): Promise<void> {
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryHandoff(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
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

async function runHandoffViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryHandoff(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildMemoryHandoffViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/handoff-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: handoff viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runWorkFrontier(args: ParsedArgs): Promise<void> {
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWorkFrontier(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
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

async function runWorkFrontierViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const focus = args.positional.join(" ").trim();
  const { store } = await openGraphStore(args);
  try {
    const report = await buildWorkFrontier(store, {
      focus: focus || undefined,
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildWorkFrontierViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/work-frontier.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: work frontier viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runMemoryDecay(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryDecayReport(store, {
      stale_days: intFlag(args.flags, "stale-days"),
      deprecate_days: intFlag(args.flags, "deprecate-days"),
      limit: intFlag(args.flags, "limit"),
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

async function runMemoryDecayViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryDecayReport(store, {
      stale_days: intFlag(args.flags, "stale-days"),
      deprecate_days: intFlag(args.flags, "deprecate-days"),
      limit: intFlag(args.flags, "limit"),
    });
    const artifact = buildMemoryDecayViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/decay.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: decay viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runMemoryMergePass(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "execute") return runMemoryMergePassExecute(args);
  if (action === "unmerge") return runMemoryMergePassUnmerge(args);
  if (action && action !== "report") {
    throw new Error(
      "memory merge-pass action must be one of: report, execute, unmerge",
    );
  }

  const { store } = await openGraphStore(args);
  try {
    const report = await buildMemoryMergePassReport(store, {
      min_score: numberFlag(args.flags, "min-score"),
      limit: intFlag(args.flags, "limit"),
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

async function runMemoryMergePassExecute(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory merge-pass execute requires explicit --yes approval");
  }
  const { store } = await openGraphStore(args);
  try {
    const result = await executeMemoryMergeBatch(store, {
      candidate_ranks: commaIntegerFlag(args.flags, "candidate-ranks"),
      approver: stringFlag(args.flags, "approver") ?? "",
      batch_id: stringFlag(args.flags, "batch-id"),
      reason: stringFlag(args.flags, "reason"),
      min_score: numberFlag(args.flags, "min-score"),
      limit: intFlag(args.flags, "limit"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory merge-pass execute: batch ${result.batch_id} merged ${result.summary.merged}/${result.summary.requested} candidate(s)`,
    );
    for (const edge of result.merged_edges) {
      console.log(
        `  ${edge.label} memory_nodes:${edge.duplicate_rid} -> memory_nodes:${edge.canonical_rid} rank=${edge.candidate_rank} score=${edge.score.toFixed(4)}`,
      );
    }
  } finally {
    await store.close();
  }
}

async function runMemoryMergePassUnmerge(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory merge-pass unmerge requires explicit --yes approval");
  }
  const { store } = await openGraphStore(args);
  try {
    const result = await unmergeMemoryMergeBatch(
      store,
      stringFlag(args.flags, "batch-id") ?? "",
    );
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory merge-pass unmerge: batch ${result.batch_id} removed ${result.summary.removed}/${result.summary.found} edge(s)`,
    );
    for (const edge of result.removed_edges) {
      console.log(
        `  ${edge.removed ? "removed" : "missing"} ${edge.label} memory_nodes:${edge.duplicate_rid} -> memory_nodes:${edge.canonical_rid}`,
      );
    }
  } finally {
    await store.close();
  }
}

async function runTidyReview(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "refresh") return runTidyReviewRefresh(args);
  if (action === "accept") return runTidyReviewAccept(args);
  if (action === "dismiss") return runTidyReviewDismiss(args);
  throw new Error("memory tidy-review action must be one of: refresh, accept, dismiss");
}

async function runTidyReviewRefresh(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const result = await refreshGovernanceTidyReviewArtifacts(store, {
      providerConfig: config.provider,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory tidy-review refresh: ${result.summary.recommendations} open/current recommendation(s), ${result.summary.stale} stale`,
    );
    for (const artifact of result.artifacts) {
      console.log(`  ${artifact.status} ${artifact.artifact_id}`);
    }
    for (const artifact of result.stale_artifacts) {
      console.log(`  stale ${artifact.artifact_id}`);
    }
  } finally {
    await store.close();
  }
}

async function runTidyReviewAccept(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory tidy-review accept requires explicit --yes approval");
  }
  const id = args.positional[1] ?? "";
  const { store } = await openGraphStore(args);
  try {
    const result = await acceptGovernanceTidyRecommendation(store, {
      id,
      approver: stringFlag(args.flags, "approver") ?? "",
      reason: stringFlag(args.flags, "reason"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(
      `memory tidy-review accept: ${result.edge.label} memory_nodes:${result.edge.from_rid} -> memory_nodes:${result.edge.to_rid}`,
    );
    console.log(`  artifact: ${result.artifact_id}`);
  } finally {
    await store.close();
  }
}

async function runTidyReviewDismiss(args: ParsedArgs): Promise<void> {
  if (args.flags.yes !== true) {
    throw new Error("memory tidy-review dismiss requires explicit --yes approval");
  }
  const id = args.positional[1] ?? "";
  const { store } = await openGraphStore(args);
  try {
    const result = await dismissGovernanceTidyRecommendation(store, {
      id,
      approver: stringFlag(args.flags, "approver") ?? "",
      reason: stringFlag(args.flags, "reason"),
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`memory tidy-review dismiss: ${result.artifact_id}`);
  } finally {
    await store.close();
  }
}

async function runSessionShow(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const id = await sessionCurrent(rootDir);
  if (args.flags.json === true) {
    console.log(JSON.stringify({ session_id: id }, null, 2));
    return;
  }
  console.log(id ?? "none");
}

async function runSessionStart(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const explicit = stringFlag(args.flags, "id");
  const id = await sessionStart(rootDir, explicit ? { id: explicit } : {});
  if (args.flags.json === true) {
    console.log(JSON.stringify({ session_id: id }, null, 2));
    return;
  }
  console.log(`memory: session started — ${id}`);
}

async function runSessionEnd(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  await sessionEnd(rootDir);
  if (args.flags.json === true) {
    console.log(JSON.stringify({ ok: true }, null, 2));
    return;
  }
  console.log("memory: session ended");
}

async function runSession(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (action === "show") return runSessionShow(args);
  if (action === "start") return runSessionStart(args);
  if (action === "end") return runSessionEnd(args);
  if (action !== "timeline" && action !== "timeline-viewer") {
    throw new Error(
      "session needs an action — supported: memory session show|start|end|timeline|timeline-viewer",
    );
  }
  const { store } = await openGraphStore(args);
  try {
    const timeline = await buildSessionTimeline(store, {
      sessionId: stringFlag(args.flags, "session"),
      limit: intFlag(args.flags, "limit"),
    });
    if (action === "timeline-viewer") {
      const rootDir = rootOf(args.flags);
      const outPath = resolve(
        stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/session-timeline.html"),
      );
      const artifact = buildSessionTimelineViewerArtifact(timeline);
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, artifact.html, "utf8");
      console.log(`memory: session timeline viewer written ${outPath}`);
      console.log(`  events: ${timeline.summary.events}`);
      console.log(`  contract: ${artifact.contract.consumes}`);
      return;
    }
    if (args.flags.json === true) {
      console.log(JSON.stringify(timeline, null, 2));
      return;
    }
    const scope = timeline.filter.session_id ? ` for ${timeline.filter.session_id}` : "";
    console.log(`memory: session timeline${scope} — ${timeline.summary.events} event(s)`);
    for (const entry of timeline.entries) {
      console.log(
        `  ${entry.occurred_at} ${entry.session_id} ${entry.actor} ${entry.title} [${entry.outcome}]`,
      );
      if (entry.detail) console.log(`      ${entry.detail}`);
    }
    for (const action of timeline.recommended_next_actions) console.log(`  next: ${action}`);
  } finally {
    await store.close();
  }
}

async function runWorking(args: ParsedArgs): Promise<void> {
  const action = args.positional[0];
  if (
    action !== "append" &&
    action !== "get" &&
    action !== "raw" &&
    action !== "evict"
  ) {
    throw new Error(
      "working needs an action — supported: memory working append|get|raw|evict",
    );
  }
  const rootDir = rootOf(args.flags);
  const { store } = await openGraphStore(args);
  try {
    if (action === "append") {
      const type = stringFlag(args.flags, "type");
      const value = stringFlag(args.flags, "value");
      if (!type) throw new Error("working append requires --type <event-type>");
      if (value == null) throw new Error("working append requires --value <text>");
      const event = await workingAppendEvent(store, rootDir, { type, value });
      if (args.flags.json === true) {
        console.log(JSON.stringify(event, null, 2));
        return;
      }
      console.log(
        `memory: working append ok — session=${event.session_id} type=${event.type} seq=${event.sequence}`,
      );
      return;
    }
    if (action === "get") {
      const type = stringFlag(args.flags, "type");
      const events = await workingListEvents(store, rootDir, type ? { type } : {});
      if (args.flags.json === true) {
        console.log(JSON.stringify({ events }, null, 2));
        return;
      }
      const scope = type ? ` type=${type}` : "";
      console.log(`memory: working get${scope} — ${events.length} event(s)`);
      for (const e of events) {
        console.log(`  #${e.sequence} ${new Date(e.created_at).toISOString()} ${e.type}  ${e.value}`);
      }
      return;
    }
    if (action === "evict") {
      const config = await readConfig(rootDir);
      const defaults = resolveL2Policy(config);
      const ttlMs = intFlag(args.flags, "ttl-ms") ?? defaults.ttlMs;
      const byteBudget = intFlag(args.flags, "byte-budget") ?? defaults.byteBudget;
      const report = await evictL2(store, { ttlMs, byteBudget });
      if (args.flags.json === true) {
        console.log(JSON.stringify(report, null, 2));
        return;
      }
      console.log(
        `memory: working evict — scanned=${report.scanned_nodes} evicted=${report.evicted.length} (ttl_ms=${ttlMs} byte_budget=${byteBudget})`,
      );
      for (const rec of report.evicted) {
        console.log(`  ${rec.reason}  rid=${rec.rid}  session=${rec.session_id}  ${rec.label}  bytes=${rec.bytes}`);
      }
      for (const s of report.by_session) {
        if (s.byte_budget_triggered) {
          console.log(
            `  session=${s.session_id}: ${s.bytes_before}B → ${s.bytes_after}B (${s.evicted} event(s) evicted by budget)`,
          );
        }
      }
      return;
    }
    // action === "raw"
    const setVal = stringFlag(args.flags, "set");
    if (setVal != null) {
      const result = await workingSetRaw(store, rootDir, setVal);
      if (args.flags.json === true) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(
        `memory: working raw set — session=${result.session_id} bytes=${Buffer.byteLength(result.value, "utf8")}`,
      );
      return;
    }
    const got = await workingGetRaw(store, rootDir);
    if (args.flags.json === true) {
      console.log(JSON.stringify(got, null, 2));
      return;
    }
    if (!got) {
      console.log("memory: working raw — (none)");
      return;
    }
    console.log(got.value);
  } finally {
    await store.close();
  }
}

async function runLearningDebt(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `learning-debt needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await buildLearningDebtReport(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
      skillTelemetryEnabled: telemetryEnabled,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    process.stdout.write(report.markdown);
  } finally {
    await store.close();
  }
}

async function runLearningDebtViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `learning-debt-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await buildLearningDebtReport(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
      skillTelemetryEnabled: telemetryEnabled,
    });
    const artifact = buildLearningDebtViewerArtifact(report);
    const outPath = resolve(
      stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/learning-debt-viewer.html"),
    );
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: learning debt viewer written ${outPath}`);
    console.log(`  status: ${report.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runOnboardingMap(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  if (args.positional[0] === "export") {
    return runOnboardingMapExport(args, rootDir);
  }
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify(map, null, 2));
      return;
    }
    process.stdout.write(map.markdown);
  } finally {
    await store.close();
  }
}

async function runOnboardingMapViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const outPath =
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/onboarding-map-viewer.html");
  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    const artifact = buildOnboardingMapViewerArtifact(map);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: onboarding map viewer written ${outPath}`);
    console.log(`  status: ${artifact.map.status}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runRoutingGuide(args: ParsedArgs): Promise<void> {
  const guide = buildMemoryRoutingGuide({ agent: routingAgentFlag(args.flags) });
  if (args.flags.json === true) {
    console.log(JSON.stringify(guide, null, 2));
    return;
  }
  printRoutingGuide(guide);
}

async function runRoutingGuideViewer(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const guide = buildMemoryRoutingGuide({ agent: routingAgentFlag(args.flags) });
  const artifact = buildMemoryRoutingGuideViewerArtifact(guide);
  const outPath =
    stringFlag(args.flags, "out") ??
    join(rootDir, ".red/memory", `routing-guide-${guide.agent}.html`);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  console.log(`memory: routing guide viewer written ${outPath}`);
  console.log(`  agent: ${guide.agent}`);
  console.log(`  contract: ${artifact.contract.consumes}`);
}

async function runAgentIntegrationStatus(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await buildMemoryAgentIntegrationStatus(rootDir, {
    agent: routingAgentFlag(args.flags),
  });
  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`memory: agent integration status (${report.schema_version})`);
  console.log(
    `  ready=${report.summary.ready} partial=${report.summary.partial} missing=${report.summary.missing}`,
  );
  for (const agent of report.agents) {
    console.log(`  ${agent.agent}: ${agent.state} (${agent.target_files.map((file) => file.path).join(", ")})`);
  }
}

async function runAgentIntegrationStatusViewer(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await buildMemoryAgentIntegrationStatus(rootDir, {
    agent: routingAgentFlag(args.flags),
  });
  const artifact = buildMemoryAgentIntegrationStatusViewerArtifact(report);
  const outPath =
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/agent-integration-status.html");
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, artifact.html, "utf8");
  console.log(`memory: agent integration status viewer written ${outPath}`);
  console.log(`  ready: ${report.summary.ready}/${report.summary.agents}`);
  console.log(`  contract: ${artifact.contract.consumes}`);
}

function routingAgentFlag(flags: Record<string, string | boolean>): MemoryRoutingAgent | undefined {
  const value = stringFlag(flags, "agent");
  if (value == null) return undefined;
  if (
    value === "codex" ||
    value === "claude" ||
    value === "cursor" ||
    value === "gemini" ||
    value === "aider" ||
    value === "opencode" ||
    value === "generic"
  ) {
    return value;
  }
  throw new Error("routing-guide --agent must be codex, claude, cursor, gemini, aider, opencode, or generic");
}

function printRoutingGuide(guide: MemoryRoutingGuide): void {
  console.log(`memory: routing guide (${guide.schemaVersion}, agent=${guide.agent})`);
  console.log(`target files: ${guide.targetFiles.join(", ")}`);
  console.log("");
  process.stdout.write(guide.installSnippet);
}

interface PublicCodebaseMapMetadata {
  schemaVersion: 1;
  kind: "memory.codebase-map.public-export";
  publicSafe: true;
  generatedAt: string;
  source: {
    gitCommit: string | null;
    graphState: {
      nodes: number;
      edges: number;
      maxRid: number;
      fingerprint: string;
    };
  };
  privacy: {
    scanned: true;
    status: PrivacyReport["status"];
    findings: number;
    findingKinds: string[];
    redacted: boolean;
    strict: boolean;
    warnings: string[];
  };
  artifacts: {
    json: string;
    markdown: string;
  };
}

async function runOnboardingMapExport(args: ParsedArgs, rootDir: string): Promise<void> {
  if (args.flags["public-safe"] !== true) {
    throw new Error(
      "onboarding-map export writes demo/comparison artifacts and requires --public-safe",
    );
  }

  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `onboarding-map export needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const target = args.positional[1] ?? ".red/memory/public-codebase-map";
  const outDir = isAbsolute(target) ? target : resolve(rootDir, target);
  const strict = args.flags.strict === true;
  const privacy = await scanPrivacy(resolve(rootDir));
  if (privacy.status !== "ok") {
    throw new Error(
      `public-safe export refused: privacy scan could not guarantee safe output (${privacy.warnings.join("; ") || privacy.status})`,
    );
  }
  if (strict && privacy.findings.length > 0) {
    throw new Error(publicSafeRefusalMessage(privacy.findings));
  }

  const telemetryEnabled = skillTelemetryEnabled(config);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const map = await buildOnboardingMap(store, {
      staleDays: intFlag(args.flags, "stale-days"),
      rollups: telemetryEnabled ? await readSkillRollups(store) : [],
    });
    const safeMap = redactSensitiveValue(map) as OnboardingMapExportShape;
    const [nodes, edges] = await Promise.all([store.listNodes(), store.listEdges()]);
    const redacted = privacy.findings.length > 0;
    const artifacts = {
      jsonPath: join(outDir, "codebase-map.json"),
      markdownPath: join(outDir, "codebase-map.md"),
      metadataPath: join(outDir, "public-export-metadata.json"),
    };
    const metadata: PublicCodebaseMapMetadata = {
      schemaVersion: 1,
      kind: "memory.codebase-map.public-export",
      publicSafe: true,
      generatedAt: new Date().toISOString(),
      source: {
        gitCommit: await currentGitCommit(rootDir),
        graphState: graphStateMetadata(nodes, edges),
      },
      privacy: {
        scanned: true,
        status: privacy.status,
        findings: privacy.findings.length,
        findingKinds: [...new Set(privacy.findings.map((finding) => finding.kind))].sort(),
        redacted,
        strict,
        warnings: privacy.warnings,
      },
      artifacts: {
        json: "codebase-map.json",
        markdown: "codebase-map.md",
      },
    };

    await mkdir(outDir, { recursive: true });
    await Promise.all([
      writeFile(artifacts.jsonPath, `${JSON.stringify(safeMap, null, 2)}\n`, "utf8"),
      writeFile(artifacts.markdownPath, safeMap.markdown, "utf8"),
      writeFile(artifacts.metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8"),
    ]);

    const payload = {
      publicSafe: true,
      redacted,
      privacy: {
        scanned: true,
        status: privacy.status,
        findings: privacy.findings.length,
        diagnostics: privacy.findings.map(publicFindingDiagnostic),
        warnings: privacy.warnings,
      },
      artifacts,
      metadata,
    };
    if (args.flags.json === true) {
      console.log(JSON.stringify(payload, null, 2));
      return;
    }
    const evidenceItems =
      safeMap.summary.concepts +
      safeMap.summary.workflows +
      safeMap.summary.decisions +
      safeMap.summary.risks +
      safeMap.summary.validations;
    console.log(`memory: public-safe codebase map export — ${evidenceItems} evidence item(s)`);
    if (privacy.findings.length > 0) {
      console.log(`  warning: redacted ${privacy.findings.length} privacy finding(s)`);
      for (const finding of privacy.findings.slice(0, 10)) {
        const diagnostic = publicFindingDiagnostic(finding);
        console.log(`  - ${diagnostic.kind} ${diagnostic.location}: ${diagnostic.excerpt}`);
      }
    }
    console.log(`  json:     ${artifacts.jsonPath}`);
    console.log(`  markdown: ${artifacts.markdownPath}`);
    console.log(`  metadata: ${artifacts.metadataPath}`);
  } finally {
    await store.close();
  }
}

type OnboardingMapExportShape = Awaited<ReturnType<typeof buildOnboardingMap>>;

function publicSafeRefusalMessage(findings: PrivacyFinding[]): string {
  const lines = [
    `public-safe export refused: privacy scan found ${findings.length} sensitive-looking value(s); rerun without --strict to write redacted artifacts.`,
  ];
  for (const finding of findings.slice(0, 10)) {
    const diagnostic = publicFindingDiagnostic(finding);
    lines.push(`- ${diagnostic.kind} ${diagnostic.location}: ${diagnostic.excerpt}`);
  }
  if (findings.length > 10) lines.push(`- ... and ${findings.length - 10} more`);
  return lines.join("\n");
}

function publicFindingDiagnostic(finding: PrivacyFinding): {
  kind: PrivacyFinding["kind"];
  location: string;
  excerpt: string;
} {
  return {
    kind: finding.kind,
    location: finding.location,
    excerpt: finding.excerpt,
  };
}

async function currentGitCommit(rootDir: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function graphStateMetadata(
  nodes: Array<{ rid: number; node_type: string }>,
  edges: Record<string, unknown>[],
): PublicCodebaseMapMetadata["source"]["graphState"] {
  const structural = {
    nodes: nodes
      .map((node) => ({ rid: node.rid, node_type: node.node_type }))
      .sort((a, b) => a.rid - b.rid),
    edges: edges
      .map((edge) => ({
        rid: Number(edge.rid ?? edge.red_entity_id ?? 0),
        label: String(edge.label ?? edge.LABEL ?? ""),
        from: Number(edge.from ?? edge.from_id ?? edge.from_rid ?? edge.source ?? edge.FROM ?? 0),
        to: Number(edge.to ?? edge.to_id ?? edge.to_rid ?? edge.target ?? edge.TO ?? 0),
      }))
      .sort(
        (a, b) =>
          a.rid - b.rid || a.label.localeCompare(b.label) || a.from - b.from || a.to - b.to,
      ),
  };
  return {
    nodes: structural.nodes.length,
    edges: structural.edges.length,
    maxRid: Math.max(0, ...structural.nodes.map((node) => node.rid)),
    fingerprint: createHash("sha256").update(JSON.stringify(structural)).digest("hex"),
  };
}

async function runAsk(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const question = args.positional.join(" ").trim();
  if (!question) throw new Error("nothing to ask — pass a question: memory ask <question>");
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `ask needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const result = await ask(store, question, { rootDir });
    if (args.flags.json === true) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log(`memory ask: ${result.status}`);
    if (result.answer) console.log(result.answer);
    if (result.error) console.log(`provider: unavailable (${result.error})`);
    console.log(`citations: ${result.citations.length}`);
    for (const item of [...result.evidence.active, ...result.evidence.superseded]) {
      const source = item.source ? ` source=${item.source}` : "";
      console.log(
        `  ${item.citation} memory_nodes:${item.rid} ${item.title} (${item.confidence}, ${item.status}${source})`,
      );
    }
    if (result.evidence.contradictory.length > 0) {
      console.log(`contradictions: ${result.evidence.contradictory.length}`);
      for (const item of result.evidence.contradictory) {
        const state = item.resolved ? `resolved active=${item.activeRid}` : "unresolved";
        const reason = item.reason ? ` reason=${item.reason}` : "";
        console.log(`  ${item.from.citation} contradicts ${item.to.citation} (${state}${reason})`);
      }
    }
    console.log(`gap analysis: ${result.gap_analysis.status}`);
    console.log(`  ${result.gap_analysis.summary}`);
    for (const gap of result.gap_analysis.gaps) console.log(`  gap: ${gap}`);
    for (const action of result.gap_analysis.next_actions) console.log(`  next: ${action}`);
    if (result.what_i_dont_know.length > 0) {
      console.log(`what I don't know: ${result.what_i_dont_know.length}`);
      for (const item of result.what_i_dont_know) console.log(`  - ${item}`);
    }
    if (result.federation_hits.length > 0) {
      console.log(`federation hits: ${result.federation_hits.length}`);
      for (const hit of result.federation_hits) {
        console.log(
          `  ${hit.origin_repo}${hit.id ? `:${hit.id}` : ""} score=${hit.score} local=${hit.confidence_local} remote=${hit.confidence_remote}`,
        );
      }
    }
    if (result.cost) {
      console.log(
        `cost: ${result.cost.provider}/${result.cost.model} prompt=${result.cost.prompt_tokens} completion=${result.cost.completion_tokens} usd=${result.cost.cost_usd}`,
      );
    }
  } finally {
    await store.close();
  }
}

async function runDocs(args: ParsedArgs): Promise<void> {
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

async function runRegistryCliOperation(
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
    if (operation.outputKind.kind === "viewer") {
      const outPath = await writeViewerArtifact(operation, output, transportInput);
      process.stdout.write(viewerCliSummary(operation, output, outPath));
      return;
    }
    if (args.flags.json === true) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    if (isRecord(output) && typeof output.markdown === "string") {
      process.stdout.write(output.markdown);
      return;
    }
    console.log(JSON.stringify(output, null, 2));
  } finally {
    if (operationNeedsGraphStore(operation)) await graphContext.store.close();
    if (args.flags.local === true && operation.id.startsWith("memory.vector-")) {
      if (previousProvider == null) delete process.env.RED_MEMORY_VECTOR_PROVIDER;
      else process.env.RED_MEMORY_VECTOR_PROVIDER = previousProvider;
    }
  }
}

function operationNeedsGraphStore(operation: ReadOnlyMemoryOperation): boolean {
  return !new Set([
    "memory.agent-integration-status",
    "memory.agent-integration-status-viewer",
    "memory.hook-coverage",
    "memory.hook-coverage-viewer",
    "memory.routing-guide",
    "memory.routing-guide-viewer",
  ]).has(operation.id);
}

function flagsForRegistryTransport(args: ParsedArgs): Record<string, unknown> {
  const flags: Record<string, unknown> = { ...args.flags };
  for (const [key, values] of Object.entries(repeatedFlags(process.argv.slice(2)))) {
    if (values.length > 1) flags[key] = values;
  }
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

function repeatedFlags(argv: readonly string[]): Record<string, string[]> {
  const repeated: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token?.startsWith("--") || token === "--") continue;
    const raw = token.slice(2);
    const eq = raw.indexOf("=");
    const key = eq >= 0 ? raw.slice(0, eq) : raw;
    const inlineValue = eq >= 0 ? raw.slice(eq + 1) : undefined;
    if (key.startsWith("no-")) continue;
    const value =
      inlineValue ??
      (argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--") ? argv[++i] : undefined);
    if (value === undefined) continue;
    (repeated[key] ??= []).push(value);
  }
  return repeated;
}

function registryCliOperationFor(
  command: string | undefined,
  positional: readonly string[],
): ReadOnlyMemoryOperation | undefined {
  if (!command) return undefined;
  for (const [registeredCommand, operation] of REGISTRY_CLI_OPERATIONS) {
    const parts = registeredCommand.split(" ");
    if (parts[0] !== command) continue;
    const rest = parts.slice(1);
    if (rest.length === 0) {
      const legacySubcommands = LEGACY_SUBCOMMANDS_BY_REGISTRY_COMMAND[registeredCommand] ?? [];
      if (legacySubcommands.includes(positional[0] ?? "")) continue;
      return operation;
    }
    if (rest.every((part, index) => positional[index] === part)) return operation;
  }
  return undefined;
}

async function runAssets(args: ParsedArgs): Promise<void> {
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

async function runAssetsViewer(args: ParsedArgs): Promise<void> {
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

function formatAssetBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function runDocsBundle(args: ParsedArgs): Promise<void> {
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

async function runDocsSearchViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsBundleViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsCoverage(args: ParsedArgs): Promise<void> {
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

async function runDocsCoverageViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsReferenceGraph(args: ParsedArgs): Promise<void> {
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

async function runDocsReferenceGraphViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsRelated(args: ParsedArgs): Promise<void> {
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

async function runDocsBacklinks(args: ParsedArgs): Promise<void> {
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

async function runDocsBacklinksViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsRelatedViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsRead(args: ParsedArgs): Promise<void> {
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

async function runDocsEvidencePack(args: ParsedArgs): Promise<void> {
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

async function runDocsEvidencePackViewer(args: ParsedArgs): Promise<void> {
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

async function runDocsRestore(args: ParsedArgs): Promise<void> {
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

async function runBackup(args: ParsedArgs): Promise<void> {
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

async function runServe(args: ParsedArgs): Promise<void> {
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

async function runHooks(args: ParsedArgs): Promise<void> {
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

async function runHooksCoverageViewer(args: ParsedArgs): Promise<void> {
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

async function runClaimCheck(args: ParsedArgs): Promise<void> {
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

function printClaimCheck(result: ClaimCheckResult): void {
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

async function runIngest(args: ParsedArgs): Promise<void> {
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

/**
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

/** Resolve the PR's changed files: an explicit `--changed-files <path>` list, or a `git diff` against `--base`. */
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

/** Resolve the head commit message: an explicit `--head-message <path>`, or `git log -1` at HEAD. */
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

/** Read `.red/memory/.audit.log` lines if the project maintains that surface; absent is fine. */
async function driftGuardAuditLog(rootDir: string): Promise<string[] | undefined> {
  try {
    const body = await readFile(join(rootDir, ".red/memory/.audit.log"), "utf8");
    return body.split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/** Best-effort append of the drift event to the local Memory event log. Swallows all failure. */
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

async function runBootstrap(args: ParsedArgs): Promise<void> {
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

async function runRefresh(args: ParsedArgs): Promise<void> {
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

async function refreshPaths(rootDir: string, args: ParsedArgs): Promise<string[]> {
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

function splitPathList(input: string): string[] {
  return input
    .split(/\0|\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function gitDiffPaths(rootDir: string, mode: "changed" | "staged"): Promise<string[]> {
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

async function runSkillEvent(args: ParsedArgs): Promise<void> {
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

/**
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

async function runCurate(args: ParsedArgs): Promise<void> {
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

/**
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



interface ProposalFileSummary {
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

async function runImproveProposals(args: ParsedArgs): Promise<void> {
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

async function runImproveProposalsList(args: ParsedArgs): Promise<void> {
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

async function runImproveProposalsShow(args: ParsedArgs): Promise<void> {
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

async function runImproveProposalsArchive(args: ParsedArgs): Promise<void> {
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

async function listPendingProposalFiles(rootDir: string): Promise<ProposalFileSummary[]> {
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

async function summarizeProposalFile(rootDir: string, proposalPath: string, body: string): Promise<ProposalFileSummary> {
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

function firstProposalField(body: string, pattern: RegExp): string | null {
  const match = body.match(pattern);
  return match ? match[1].trim() : null;
}

function proposalRoot(rootDir: string): string {
  return join(rootDir, ".red", "memory", "proposals");
}

function assertInsideProposalTree(rootDir: string, filePath: string): void {
  const rel = relative(proposalRoot(rootDir), filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error("proposal file must stay inside .red/memory/proposals");
  }
}

function isArchiveReason(reason: string): reason is "applied" | "rejected" | "stale" {
  return reason === "applied" || reason === "rejected" || reason === "stale";
}

interface SkillPatchBlock {
  path: string;
  oldString: string;
  newString: string;
}

async function runImproveApply(args: ParsedArgs): Promise<void> {
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

function parseSkillPatchBlock(proposal: string): SkillPatchBlock {
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

function assertInsideRoot(rootDir: string, filePath: string, label: string): void {
  const rel = relative(rootDir, filePath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new Error(`${label} must stay inside --root`);
  }
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(needle, index)) !== -1) {
    count++;
    index += needle.length;
  }
  return count;
}

interface SkillImprovementProposalSummary {
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

interface SkillTelemetryEvidenceCardArtifact {
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

interface SkillImprovementBuildResult {
  proposals: SkillImprovementProposalSummary[];
  evidenceCards: SkillTelemetryEvidenceCardArtifact[];
}

async function buildSkillImprovementProposals(
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

type SkillTelemetryEvidenceCardStatus =
  | "captured"
  | "routed"
  | "proposed"
  | "approved"
  | "rejected"
  | "promoted"
  | "archived";

interface ExistingSkillTelemetryEvidenceCardRef {
  file: string;
  id: string;
  fingerprint: string;
  status: SkillTelemetryEvidenceCardStatus;
  createdAt: string | null;
  proposalPath: string | null;
  revision: number;
  review: SkillTelemetryEvidenceCard["review"];
}

async function countSkillTelemetryEvidenceCardsForSignal(
  evidenceCardDir: string,
  signalFingerprint: string,
): Promise<number> {
  return (await listSkillTelemetryEvidenceCardsForSignal(evidenceCardDir, signalFingerprint)).length;
}

async function findReusableSkillTelemetryEvidenceCard(
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

async function listSkillTelemetryEvidenceCardsForSignal(
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

function firstTopLevelYamlScalarField(body: string, key: string): string | null {
  const match = body.match(new RegExp(`^${escapeRegExp(key)}:\\s*([^\\n]*)$`, "m"));
  if (!match) return null;
  return parseYamlScalar(match[1]);
}

function lastYamlScalarField(body: string, key: string): string | null {
  const matches = [...body.matchAll(new RegExp(`^\\s*${escapeRegExp(key)}:\\s*([^\\n]*)$`, "gm"))];
  const match = matches.at(-1);
  if (!match) return null;
  return parseYamlScalar(match[1]);
}

function parseYamlScalar(value: string): string | null {
  const raw = value.trim();
  if (raw === "" || raw === "null") return null;
  try {
    return String(JSON.parse(raw));
  } catch {
    return raw;
  }
}

function parseSkillTelemetryEvidenceCardStatus(value: string | null): SkillTelemetryEvidenceCardStatus {
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

function isUnresolvedSkillTelemetryEvidenceCardStatus(status: SkillTelemetryEvidenceCardStatus): boolean {
  return status === "captured" || status === "routed" || status === "proposed";
}

function skillTelemetryReviewHasHumanDecision(review: SkillTelemetryEvidenceCard["review"]): boolean {
  return Boolean(review.reviewed_at || review.decision);
}

function proposalFingerprint(input: {
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

function skillTelemetryEvidenceSource(skillName: string, evidence: readonly SkillEventSummary[]): string {
  const sourceKinds = topValues(evidence.map((event) => event.source_kind));
  return `skill-telemetry:${skillName}:${sourceKinds.length > 0 ? sourceKinds.join("+") : "unknown-source"}`;
}

function skillTelemetryEvidenceRoute(category: string, skillPath: string): string {
  return `skill-improvement:${category}:${skillPath}`;
}

function skillTelemetryDominantErrorPattern(input: {
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

function skillTelemetryWindow(evidence: readonly SkillEventSummary[]): string {
  const timestamps = evidence.map((event) => event.timestamp).filter(Boolean).sort();
  if (timestamps.length === 0) return "none";
  return `${timestamps[0]}..${timestamps[timestamps.length - 1]} count=${timestamps.length}`;
}

function skillTelemetrySignalFingerprint(input: {
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

interface SkillTelemetryEvidenceCard {
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

function buildSkillTelemetryEvidenceCard(input: {
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

function suggestedSectionOrAnchor(
  dominantErrorStage: string | null,
  dominantErrorClass: string | null,
): string {
  if (dominantErrorStage) return `stage:${dominantErrorStage}`;
  if (dominantErrorClass) return `error_class:${dominantErrorClass}`;
  return "safe-tail-anchor";
}

function renderEvidenceCardYaml(card: SkillTelemetryEvidenceCard): string {
  return `${yamlValue(card)}\n`;
}

function yamlValue(value: unknown, indent = 0): string {
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function yamlScalar(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

async function renderSkillImprovementProposal(
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


function recentFailureEvidence(skillName: string, events: readonly SkillEventSummary[]): SkillEventSummary[] {
  return events
    .filter((event) => event.name === skillName && event.event_type === "result" && event.status === "failed")
    .slice(0, 5);
}

function renderRecentFailureEvidence(evidence: readonly SkillEventSummary[]): string {
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

function semanticTroubleshootingNote(reason: string, evidence: readonly SkillEventSummary[]): string {
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

function topValues(values: readonly (string | undefined)[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (!value) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([value]) => value);
}

async function renderDraftSkillPatchBlock(
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


function semanticSectionAnchor(text: string, evidence: readonly SkillEventSummary[]): string | null {
  const stage = topValues(evidence.map((event) => event.error_stage))[0];
  const klass = topValues(evidence.map((event) => event.error_class))[0];
  const headings = semanticHeadingCandidates(stage, klass);
  for (const heading of headings) {
    const section = markdownSectionByHeading(text, heading);
    if (section && countOccurrences(text, section) === 1) return section;
  }
  return null;
}

function semanticHeadingCandidates(stage: string | undefined, klass: string | undefined): RegExp[] {
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

function markdownSectionByHeading(text: string, headingPattern: RegExp): string | null {
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

function uniqueTailAnchor(text: string): string | null {
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

function reportImproveState(
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

/**
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


/**
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

/**
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

async function runHealthViewer(args: ParsedArgs): Promise<void> {
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

async function runGovernance(args: ParsedArgs): Promise<void> {
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

async function runGovernanceViewer(args: ParsedArgs): Promise<void> {
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

function printGovernance(report: MemoryGovernanceReport): void {
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

async function runLint(args: ParsedArgs): Promise<void> {
  const rootDir = resolve(rootOf(args.flags));
  const report = await lintMemory(rootDir);

  if (args.flags.json === true) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printLintReport(report);
}

async function runPrivacy(args: ParsedArgs): Promise<void> {
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

function printPrivacyReport(report: PrivacyReport): void {
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

function printLintReport(report: LintReport): void {
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

async function healthReport(rootDir: string) {
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

function healthState(input: {
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

function healthRecommendations(input: {
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


type CheckName =
  | "agent-rules"
  | "domain-glossary"
  | "memory-initialized"
  | "memory-graph"
  | "graph-freshness"
  | "skill-telemetry"
  | "wiki-ready"
  | "adr-context";

interface ContextCheck {
  name: CheckName;
  ok: boolean;
  reason: string;
}

async function runContextStatus(args: ParsedArgs): Promise<void> {
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

async function contextStatusReport(rootDir: string) {
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

function contextRecommendations(input: {
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

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function countMarkdownFiles(dir: string): Promise<number> {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).length;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw err;
  }
}

async function storeExists(rootDir: string, storePath: string): Promise<boolean> {
  const abs = isAbsolute(storePath) ? storePath : join(rootDir, storePath);
  try {
    const info = await stat(abs);
    return info.isFile() || info.isDirectory();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}


async function graphFreshnessStatus(rootDir: string, storePath: string): Promise<{
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

async function scanProjectFreshness(rootDir: string, storeMtimeMs: number): Promise<{
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

async function newestMtimeMs(path: string): Promise<number | null> {
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

function shouldSkipFreshnessPath(rel: string, isDir: boolean): boolean {
  const first = rel.split("/")[0];
  if ([".git", "node_modules", "dist", "build", "coverage", ".turbo", ".next"].includes(first)) {
    return true;
  }
  if (rel === ".red/memory" || rel.startsWith(".red/memory/")) return true;
  if (rel === ".red/wiki" || rel.startsWith(".red/wiki/")) return true;
  if (isDir && entryLooksLikeCache(first)) return true;
  return false;
}

function entryLooksLikeCache(name: string): boolean {
  return name === ".cache" || name === ".pytest_cache" || name === ".vitest";
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

function enabledHookNames(hooks: {
  sessionStart: boolean;
  postToolUse: boolean;
  stop: boolean;
  preCompact: boolean;
}): string[] {
  return Object.entries(hooks)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
}

function yesNo(value: boolean): string {
  return value ? "yes" : "no";
}

/** Print a non-enabled status state in either JSON or human-readable form. */
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

/** Compact `succeeded=3 failed=1` summary of a rollup's outcome counts. */
function formatOutcomes(counts: SkillRollup["outcome_counts"]): string {
  return Object.entries(counts)
    .filter(([, n]) => typeof n === "number" && n > 0)
    .map(([status, n]) => `${status}=${n}`)
    .join(" ");
}

function skillEventFromFlags(flags: Record<string, string | boolean>): Record<string, unknown> {
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

function plural(count: number, singular: string): string {
  return count === 1 ? singular : `${singular}s`;
}

/**
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

async function runExtraction(args: ParsedArgs): Promise<void> {
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

async function runExtractionStatusViewer(args: ParsedArgs): Promise<void> {
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

async function runMap(args: ParsedArgs): Promise<void> {
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

/**
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

async function runCodeCurate(args: ParsedArgs): Promise<void> {
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

function codeCurationOutput(state: EngineeringCodeCurationState, changed: boolean) {
  return {
    changed,
    schemaVersion: state.schemaVersion,
    suggestedVersion: state.suggestedVersion,
    suggested: suggestedEngineeringCodes(state),
    promoted: state.promoted,
    aliases: state.aliases,
  };
}

function renderCodeDriftGroups(groups: CodeDriftCountGroup[]): void {
  if (groups.length === 0) {
    console.log("    (none)");
    return;
  }
  for (const group of groups) {
    console.log(`    count ${group.count}: ${group.codes.join(", ")}`);
  }
}

/** Open the graph store for a read verb, erroring clearly outside graph mode. */
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

function applyConfiguredProviderEnv(provider: MemoryConfig["provider"]): void {
  if (!provider) return;
  try {
    applyProviderEnv(resolveProvider(provider), provider.apiKeyEnv);
  } catch {
    // Provider-aware commands report invalid config. Deterministic graph reads
    // should still be able to open the store and degrade locally.
  }
}

function intFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  return typeof flags[key] === "string" ? Number(flags[key]) : undefined;
}

function numberFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  if (typeof flags[key] !== "string") return undefined;
  const value = Number(flags[key]);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a finite number`);
  return value;
}

function commaIntegerFlag(flags: Record<string, string | boolean>, key: string): number[] {
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

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  return typeof flags[key] === "string" ? flags[key] : undefined;
}

function isIntegerText(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

function strFlag<T extends string>(
  flags: Record<string, string | boolean>,
  key: string,
  fallback: T,
): T {
  return typeof flags[key] === "string" ? (flags[key] as T) : fallback;
}

async function runSearch(args: ParsedArgs): Promise<void> {
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

async function runMapContext(args: ParsedArgs): Promise<void> {
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

function mapContextModeFlag(flags: Record<string, string | boolean>): "bfs" | "dfs" {
  const mode = strFlag(flags, "mode", "bfs");
  if (mode === "bfs" || mode === "dfs") return mode;
  throw new Error("map-context --mode must be bfs or dfs");
}

async function runNeighbors(args: ParsedArgs): Promise<void> {
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

async function runTraverse(args: ParsedArgs): Promise<void> {
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

async function runPath(args: ParsedArgs): Promise<void> {
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

async function runPathExplain(args: ParsedArgs): Promise<void> {
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

async function runPathExplainViewer(args: ParsedArgs): Promise<void> {
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

async function runConfidence(args: ParsedArgs): Promise<void> {
  const nodeArg = stringFlag(args.flags, "node") ?? args.positional[0];
  if (!nodeArg) {
    throw new Error("pass a node rid: memory confidence --node <rid>");
  }
  const { store } = await openGraphStore(args);
  try {
    const report = await buildConfidenceReport(store, nodeArg);
    if (!report) {
      throw new Error(`memory: no node with rid=${nodeArg}`);
    }
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(renderConfidenceMarkdown(report));
  } finally {
    await store.close();
  }
}

async function runConflicts(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const conflicts = await listContradictions(store, {
      includeResolved: args.flags["include-resolved"] === true,
    });
    if (args.flags.json === true) {
      console.log(JSON.stringify({ conflicts }, null, 2));
      return;
    }
    printConflicts(conflicts);
  } finally {
    await store.close();
  }
}

async function runSupersede(args: ParsedArgs): Promise<void> {
  const [oldArg, newArg] = args.positional;
  if (!oldArg || !newArg) {
    throw new Error("pass two node rids: memory supersede <old-rid> <new-rid>");
  }
  const oldRid = parseRid(oldArg, "old-rid");
  const newRid = parseRid(newArg, "new-rid");
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const { store } = await openGraphStore(args);
  try {
    await resolveConflict(store, { activeRid: newRid, supersededRid: oldRid, reason });
    console.log(`memory: superseded ${oldRid} -> ${newRid}`);
    if (reason) console.log(`  reason: ${reason}`);
  } finally {
    await store.close();
  }
}

async function runResolveConflict(args: ParsedArgs): Promise<void> {
  const activeArg = typeof args.flags.active === "string" ? args.flags.active : args.positional[0];
  const supersededArg =
    typeof args.flags.superseded === "string" ? args.flags.superseded : args.positional[1];
  if (!activeArg || !supersededArg) {
    throw new Error(
      "pass active and superseded rids: memory resolve-conflict <active-rid> <superseded-rid>",
    );
  }
  const activeRid = parseRid(activeArg, "active-rid");
  const supersededRid = parseRid(supersededArg, "superseded-rid");
  const reason = typeof args.flags.reason === "string" ? args.flags.reason : undefined;
  const { store } = await openGraphStore(args);
  try {
    await resolveConflict(store, { activeRid, supersededRid, reason });
    console.log(`memory: resolved conflict with active ${activeRid}; superseded ${supersededRid}`);
    if (reason) console.log(`  reason: ${reason}`);
  } finally {
    await store.close();
  }
}

async function runTimeline(args: ParsedArgs): Promise<void> {
  const topic = args.positional.join(" ").trim();
  if (!topic) throw new Error("pass a topic or rid: memory timeline <topic|rid>");
  const { store } = await openGraphStore(args);
  try {
    const timeline = await supersessionTimeline(store, topic);
    if (args.flags.json === true) {
      console.log(JSON.stringify(timeline, null, 2));
      return;
    }
    printTimelineToon(timeline, { includeAudit: args.flags["include-audit"] === true });
  } finally {
    await store.close();
  }
}

async function runCommunities(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation("memory.communities", { store }, {
      cache: args.flags["no-cache"] === true ? "off" : "read-write",
    })) as CommunityAnalyticsReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(
      `memory: ${report.communities.length} community(ies), ${report.assignments.length} assigned node(s)`,
    );
    console.log(
      `  navigation: ${report.node_analytics.length} ranked node(s), ${report.inter_community_edges.length} inter-community edge(s)`,
    );
    console.log(`  graph hash: ${report.graph_hash}`);
    console.log(`  cache: ${report.cached ? "hit" : "miss"}`);
    for (const community of report.communities) {
      console.log(
        `  ${community.id}: ${community.count} node(s), degree ${community.total_degree}, centrality ${community.avg_centrality}`,
      );
      if (community.titles.length > 0) {
        console.log(`        top titles: ${community.titles.join(", ")}`);
      }
      if (community.labels.length > 0) {
        console.log(`        labels: ${community.labels.join(", ")}`);
      }
    }
  } finally {
    await store.close();
  }
}

async function runCommunitiesViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const outPath = stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/communities-viewer.html");
  const { store } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation("memory.communities", { store }, {
      cache: args.flags["no-cache"] === true ? "off" : "read-write",
    })) as CommunityAnalyticsReport;
    const artifact = buildCommunitiesViewerArtifact(report);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: communities viewer written ${outPath}`);
    console.log(`  communities: ${artifact.report.communities.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runCommunityDigest(args: ParsedArgs): Promise<void> {
  const { store, config } = await openGraphStore(args);
  try {
    const report = (await executeReadOnlyMemoryOperation(
      "memory.community-digest",
      { store, providerConfig: config.provider },
      {
        cache: args.flags["no-cache"] === true ? "off" : "read-write",
      },
    )) as CommunityDigestReport;
    if (args.flags.json === true) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }
    console.log(`memory: ${report.community_count} community digest(s)`);
    console.log(`  graph hash: ${report.graph_hash}`);
    console.log(`  cache: ${report.cached ? "hit" : "miss"}`);
    console.log(
      `  provider: ${report.provider.status}${
        report.provider.error ? ` (${report.provider.error})` : ""
      }`,
    );
    for (const digest of report.digests) {
      console.log(`  ${digest.community_id}: ${digest.size} node(s)`);
      console.log(`        top label: ${digest.top_label}`);
      console.log(`        top type: ${digest.top_node_type}`);
      if (digest.top_engineering_code) {
        console.log(`        top code: ${digest.top_engineering_code}`);
      }
      if (digest.narrative_summary) {
        console.log(`        summary: ${digest.narrative_summary}`);
      }
    }
  } finally {
    await store.close();
  }
}

function parseRid(value: string, name: string): number {
  const rid = Number(value);
  if (!Number.isInteger(rid) || rid <= 0) throw new Error(`${name} must be a positive integer`);
  return rid;
}

function printConflicts(conflicts: ContradictionSummary[]): void {
  if (conflicts.length === 0) {
    console.log("memory: no unresolved contradictions");
    return;
  }
  console.log(`memory: ${conflicts.length} likely contradiction(s)`);
  for (const conflict of conflicts) {
    const status = conflict.resolved ? `resolved -> ${conflict.activeRid}` : "unresolved";
    console.log(
      `  [${status}] ${conflict.from.rid} ${conflict.from.label} <-> ${conflict.to.rid} ${conflict.to.label}`,
    );
    if (conflict.reason) console.log(`        ${conflict.reason}`);
  }
}

function printTimeline(timeline: TopicTimeline, opts: { includeAudit: boolean }): void {
  if (timeline.entries.length === 0) {
    console.log(`memory: no timeline entries for "${timeline.topic}"`);
    return;
  }
  console.log(`memory: timeline for "${timeline.topic}"`);
  for (const entry of timeline.entries) {
    const marker = entry.status === "active" ? "active" : `superseded -> ${entry.activeRid}`;
    console.log(`  [${marker}] ${entry.rid} (${entry.nodeType}) ${entry.label}`);
    if (entry.content) console.log(`        ${entry.content.slice(0, 200)}`);
  }
  if (opts.includeAudit) {
    if (timeline.auditLinks.length === 0) {
      console.log("  audit: no contradiction or supersession links");
      return;
    }
    console.log("  audit:");
    for (const edge of timeline.auditLinks) {
      const reason = edge.reason ? ` - ${edge.reason}` : "";
      console.log(`    ${edge.label} ${edge.fromRid} -> ${edge.toRid}${reason}`);
    }
  }
}

type TimelineToonEntry = {
  rid: number;
  status: string;
  activeRid: number;
  nodeType: string;
  label: string;
  title: string;
  content: string;
};

function printTimelineToon(timeline: TopicTimeline, opts: { includeAudit: boolean }): void {
  const rows: TimelineToonEntry[] = timeline.entries.map((entry) => ({
    rid: entry.rid,
    status: entry.status,
    activeRid: entry.activeRid,
    nodeType: entry.nodeType,
    label: entry.label,
    title: entry.title,
    content: entry.content,
  }));
  const zero = rows.length === 0;
  console.log(
    renderToonOutput({
      rowsKey: "entries",
      rows,
      fields: ["rid", "status", "activeRid", "nodeType", "label", "title", "content"],
      summary: {
        status: zero ? "0 entries" : `${rows.length} entries`,
        topic: timeline.topic,
        entries: rows.length,
        active: rows.filter((entry) => entry.status === "active").length,
        superseded: rows.filter((entry) => entry.status === "superseded").length,
        auditLinks: timeline.auditLinks.length,
      },
      extra: {
        ...(opts.includeAudit
          ? {
              auditLinks: timeline.auditLinks.map((edge) => ({
                label: edge.label,
                fromRid: edge.fromRid,
                toRid: edge.toRid,
                reason: edge.reason,
              })),
            }
          : {}),
        ...(zero
          ? {
              next: "store or ingest topic evidence, then rerun `memory timeline <topic>`",
            }
          : {}),
      },
    }),
  );
}

async function runStructuralImpact(args: ParsedArgs): Promise<void> {
  const target: StructuralImpactTarget = {
    file: typeof args.flags.file === "string" ? args.flags.file : undefined,
    symbol: typeof args.flags.symbol === "string" ? args.flags.symbol : undefined,
  };
  if (!target.file && !target.symbol) {
    throw new Error("pass --file <path>, --symbol <name>, or both");
  }
  const { store } = await openGraphStore(args);
  try {
    const impact = await structuralImpactReader(store)(target);
    printStructuralImpact(target, impact);
  } finally {
    await store.close();
  }
}

async function runPrePrReview(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `pre-pr-review needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const comparison = stringFlag(args.flags, "range") ?? stringFlag(args.flags, "comparison");
  const changedFiles = await readChangedFiles(rootDir, comparison);
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const review = await buildPrePrMemoryReview(store, { changedFiles, comparison });
    if (args.flags.json === true) {
      console.log(JSON.stringify(review, null, 2));
      return;
    }
    printPrePrReview(review);
  } finally {
    await store.close();
  }
}

async function runPrePrReviewViewer(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `pre-pr-review-viewer needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  const comparison = stringFlag(args.flags, "range") ?? stringFlag(args.flags, "comparison");
  const changedFiles = await readChangedFiles(rootDir, comparison);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/pre-pr-review-viewer.html"),
  );
  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const review = await buildPrePrMemoryReview(store, { changedFiles, comparison });
    const artifact = buildPrePrReviewViewerArtifact(review);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: pre-PR review viewer written ${outPath}`);
    console.log(`  changed files: ${review.changedFiles.length}`);
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

async function runStructuralImpactViewer(args: ParsedArgs): Promise<void> {
  const target: StructuralImpactTarget = {
    file: typeof args.flags.file === "string" ? args.flags.file : undefined,
    symbol: typeof args.flags.symbol === "string" ? args.flags.symbol : undefined,
  };
  if (!target.file && !target.symbol) {
    throw new Error("pass --file <path>, --symbol <name>, or both");
  }
  const rootDir = rootOf(args.flags);
  const outPath = resolve(
    stringFlag(args.flags, "out") ?? join(rootDir, ".red/memory/structural-impact-viewer.html"),
  );
  const { store } = await openGraphStore(args);
  try {
    const impact = await structuralImpactReader(store)(target);
    const artifact = buildStructuralImpactViewerArtifact(target, impact);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, artifact.html, "utf8");
    console.log(`memory: structural impact viewer written ${outPath}`);
    console.log(`  target: ${target.file ?? ""}${target.symbol ? ` ${target.symbol}` : ""}`.trim());
    console.log(`  contract: ${artifact.contract.consumes}`);
  } finally {
    await store.close();
  }
}

function printStructuralImpact(target: StructuralImpactTarget, impact: StructuralImpact): void {
  const label = [target.file ? `file ${target.file}` : "", target.symbol ? `symbol ${target.symbol}` : ""]
    .filter(Boolean)
    .join(", ");
  const lines: string[] = [];

  for (const edge of impact.imports) {
    lines.push(`${edge.from.properties.title} imports ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.importedBy) {
    lines.push(`${edge.from.properties.title} imports this target through ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.calls) {
    lines.push(`${edge.from.properties.title} calls ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.calledBy) {
    lines.push(`${edge.from.properties.title} calls this target`);
  }
  for (const edge of impact.usesTypes) {
    lines.push(`${edge.from.properties.title} uses type ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.usedByTypes) {
    lines.push(`${edge.from.properties.title} uses this target as a type`);
  }
  for (const edge of impact.references) {
    lines.push(`${edge.from.properties.title} references ${edge.to.properties.title ?? edge.to.label}`);
  }
  for (const edge of impact.referencedBy) {
    lines.push(`${edge.from.properties.title} references this target`);
  }
  for (const node of impact.defines) {
    lines.push(`${impact.definedIn?.properties.title ?? target.file ?? "target file"} defines ${node.properties.title}`);
  }
  if (impact.definedIn && target.symbol) {
    lines.push(`${target.symbol} is defined in ${impact.definedIn.properties.title}`);
  }

  if (lines.length === 0) {
    console.log(`memory: no structural impact for ${label}`);
    return;
  }
  console.log(`memory: structural impact for ${label}`);
  for (const line of lines) console.log(`  ${line}`);
}

async function readChangedFiles(rootDir: string, comparison?: string): Promise<string[]> {
  const args = comparison
    ? ["diff", "--name-only", "--diff-filter=ACMRTUXB", comparison, "--"]
    : ["diff", "--name-only", "--diff-filter=ACMRTUXB", "HEAD", "--"];
  try {
    const { stdout } = await execFileAsync("git", args, { cwd: rootDir });
    return parseChangedFiles(stdout);
  } catch (err) {
    if (comparison) throw err;
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--name-only", "--diff-filter=ACMRTUXB", "--"],
      { cwd: rootDir },
    );
    return parseChangedFiles(stdout);
  }
}

function parseChangedFiles(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function printPrePrReview(review: PrePrMemoryReview): void {
  const scope = review.comparison ? ` for ${review.comparison}` : "";
  console.log(`memory: pre-PR review${scope}`);
  if (review.changedFiles.length === 0) {
    console.log("changed files: no diff evidence");
  } else {
    console.log(`changed files: ${review.changedFiles.length}`);
    for (const file of review.changedFiles) console.log(`  ${file}`);
  }

  printPrePrSection("impacted concepts", review.impactedConcepts);
  printPrePrSection("related decisions", review.relatedDecisions);
  printPrePrSection("known failures", review.knownFailures);
  printPrePrSection("suggested validations", review.suggestedValidations);
  printPrePrSection("risks", review.risks);

  if (review.missingEvidence.length > 0) {
    console.log(`missing evidence: ${review.missingEvidence.join(", ")}`);
  }
  if (review.evidence.length > 0) {
    console.log("evidence:");
    for (const item of review.evidence) {
      const source = item.source ? ` source=${item.source}` : "";
      console.log(
        `  ${item.marker} ${item.urn} ${item.title} (${item.nodeType}, ${item.confidence}${source})`,
      );
    }
  }
}

function printPrePrSection(title: string, section: PrePrReviewSection): void {
  console.log(`${title}:`);
  if (section.items.length === 0) {
    console.log("  missing evidence");
    return;
  }
  for (const item of section.items) {
    const citations = item.evidence.map((e) => e.marker).join(" ");
    console.log(`  - ${item.title} ${citations}`);
    console.log(`    ${item.summary}`);
  }
}

function printReadinessEnvelope(envelope: MemoryReadinessEnvelope): void {
  console.log(`memory: readiness — ${envelope.status}`);
  console.log(`  goal: ${envelope.request.goal}`);
  console.log(
    `  evidence: ${envelope.retrieval.recall.active_evidence_count}/${envelope.retrieval.recall.evidence_count} active`,
  );
  console.log(
    `  vector: ${envelope.retrieval.vector.overall} (${envelope.retrieval.vector.ready}/${envelope.retrieval.vector.total} ready)`,
  );
  console.log(
    `  trust: provenance=${envelope.trust.provenance.nodes_with_provenance}/${envelope.trust.provenance.total_nodes} ` +
      `superseded=${envelope.trust.supersession.superseded_nodes} ` +
      `contradictions=${envelope.trust.contradictions.unresolved} ` +
      `privacy-findings=${envelope.trust.privacy.findings}`,
  );
  console.log(
    `  vcs: ${envelope.vcs.time_travel} (${envelope.vcs.collections
      .map((collection) => `${collection.name}:${collection.status}`)
      .join(", ")})`,
  );
  console.log(
    `  telemetry: ${envelope.operations.event_log.total_events} event(s) ` +
      `community-signals=${envelope.communities.communities}/${envelope.communities.assignments}`,
  );
  if (envelope.evidence.missing.missing) {
    console.log(
      `  missing evidence: ${envelope.evidence.missing.active_count}/${envelope.evidence.missing.expected_minimum} active`,
    );
    for (const message of envelope.evidence.missing.messages) console.log(`    ${message}`);
  }
  if (envelope.evidence.contradictions.length > 0) {
    console.log(`  contradictions: ${envelope.evidence.contradictions.length}`);
    for (const warning of envelope.evidence.contradictions) console.log(`    ${warning.message}`);
  }
  if (envelope.evidence.superseded.length > 0) {
    console.log(`  superseded evidence: ${envelope.evidence.superseded.length}`);
  }
  if (envelope.evidence.stale.length > 0) {
    console.log(`  stale evidence: ${envelope.evidence.stale.length}`);
  }
  if (envelope.skills.signal_status === "available" && envelope.skills.recommendations.length > 0) {
    console.log(
      `  skills: ${envelope.skills.recommendations.map((item) => item.name).join(", ")}`,
    );
  } else {
    console.log(`  skills: ${envelope.skills.status}`);
  }
  console.log(
    `  learning debt: ${envelope.learning_debt.status}` +
      (envelope.learning_debt.status === "available"
        ? ` (${envelope.learning_debt.debt_status})`
        : ""),
  );
  if (envelope.next_actions.length > 0) {
    console.log("  next actions:");
    for (const action of envelope.next_actions) console.log(`    - ${action}`);
  }
}

async function runStats(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const stats = await store.stats();
    console.log(`memory: ${stats.nodes} node(s), ${stats.edges} edge(s)`);
  } finally {
    await store.close();
  }
}

async function runVector(args: ParsedArgs): Promise<void> {
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

async function runDoctor(args: ParsedArgs): Promise<void> {
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

async function runExport(args: ParsedArgs): Promise<void> {
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

async function runGlobalSearch(args: ParsedArgs): Promise<void> {
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

/**
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

async function runArchitectureOverview(args: ParsedArgs): Promise<void> {
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

/** Read all of stdin (the runner's hook payload) into a string. */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const HOOK_EVENTS: readonly HookEvent[] = ["SessionStart", "PostToolUse", "Stop", "PreCompact"];

/**
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

const VCS_EVENTS: readonly VcsEvent[] = ["post-commit", "post-checkout"];

/**
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

async function runVcsRefresh(args: ParsedArgs): Promise<void> {
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

/** Resolve the repo's git hooks directory, falling back to `<root>/.git/hooks`. */
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
function resolveBootstrapPath(): string | undefined {
  const root = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.CODEX_PLUGIN_ROOT;
  const candidates = [
    root ? join(root, "scripts", "bootstrap.mjs") : undefined,
    // Dev/source layout: this file is <pluginRoot>/src/cli.ts.
    join(dirname(dirname(fileURLToPath(import.meta.url))), "scripts", "bootstrap.mjs"),
  ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return undefined;
}

async function runVcsInstallHooks(args: ParsedArgs): Promise<void> {
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

async function runVcsUninstallHooks(args: ParsedArgs): Promise<void> {
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

async function runAttempt(args: ParsedArgs): Promise<void> {
  const subcommand = args.positional[0];
  if (subcommand === "learn") {
    return runAttemptLearn(args);
  }
  if (subcommand !== "record") {
    throw new Error("unknown attempt command — expected: memory attempt record|learn");
  }

  const raw = await readStdin();
  if (!raw.trim()) throw new Error("attempt record needs a JSON payload on stdin");
  const payload = JSON.parse(raw) as ReasoningAttemptPayload;

  const { store } = await openGraphStore(args);
  try {
    const receipt = await recordReasoningAttempt(store, payload);
    console.log(
      `memory: recorded attempt ${payload.repository}#${payload.issueNumber}/${payload.attemptNumber} (rid ${receipt.attemptRid})`,
    );
  } finally {
    await store.close();
  }
}

async function runAttemptLearn(args: ParsedArgs): Promise<void> {
  const action = args.positional[1];
  if (action === "apply") return runAttemptLearnApply(args);
  if (action != null) throw new Error("memory attempt learn supports: apply");

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const writeProposal = args.flags["write-proposal"] === true;
  const { store } = await openGraphStore(args);
  try {
    const report = await buildAttemptLearningReport(store);
    const proposalFile = writeProposal
      ? await writeAttemptLearningProposalFile(rootDir, report)
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
    console.log(`memory: attempt learning - ${state}`);
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

async function runAttemptLearnApply(args: ParsedArgs): Promise<void> {
  const proposalArg = args.positional[2];
  if (!proposalArg) throw new Error("memory attempt learn apply needs a proposal file");
  if (args.flags.yes !== true) {
    throw new Error("memory attempt learn apply requires explicit --yes approval");
  }

  const rootDir = rootOf(args.flags);
  const json = args.flags.json === true;
  const proposalPath = resolve(rootDir, proposalArg);
  assertInsideRoot(rootDir, proposalPath, "proposal file");
  assertInsideProposalTree(rootDir, proposalPath);
  const body = await readFile(proposalPath, "utf8");
  const report = parseAttemptLearningProposal(body);
  const { store } = await openGraphStore(args);
  try {
    const result = await applyAttemptLearningProposal(store, report);
    const output = {
      state: "applied",
      proposal: toPosix(relative(rootDir, proposalPath)),
      ...result,
    };
    if (json) {
      console.log(JSON.stringify(output, null, 2));
      return;
    }
    console.log(`memory: applied attempt learning proposal ${output.proposal}`);
    console.log(`  learned nodes: ${result.applied}`);
  } finally {
    await store.close();
  }
}

async function runImport(args: ParsedArgs): Promise<void> {
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

function parseComplementaryMapKind(
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

async function runPromoteCmd(args: ParsedArgs): Promise<void> {
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

async function runAfkFinalize(args: ParsedArgs): Promise<void> {
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

async function main(): Promise<void> {
  const args = parseLooseArgs(process.argv.slice(2));
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

main().catch((err: unknown) => {
  console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
