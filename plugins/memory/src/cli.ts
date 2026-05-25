#!/usr/bin/env node
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import {
  DEFAULT_MEMORY_EVENT_RETENTION_DAYS,
  readConfig,
  resolveNotesDir,
  resolveStoreUri,
  skillTelemetryEnabled,
} from "./config.js";
import type { CommunityAnalyticsReport } from "./communities.js";
import { buildContextPack } from "./context-pack.js";
import { claimCheck, type ClaimCheckResult } from "./claim-check.js";
import { diagnose, prune } from "./doctor.js";
import { ask, neighbors, path as shortestPath, search, traverse } from "./engine.js";
import { exportGraph } from "./export.js";
import {
  extractConversation,
  factsToGraph,
  resolveProvider,
} from "./extract-conversation.js";
import { formatOutput, parseInput, type RawPayload } from "./hook-adapters.js";
import { dispatch, type HookEvent, type Runner } from "./hook-runtime.js";
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
import { graphRecallResult } from "./graph-recall.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { HistoricalMemoryStore } from "./historical-memory-store.js";
import { ingestProject, refreshFiles } from "./ingest.js";
import { initGraph, initMarkdownOnly } from "./init.js";
import { lintMemory, type LintReport } from "./lint.js";
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
import { buildLearningDebtReport } from "./learning-debt.js";
import { buildOnboardingMap } from "./onboarding-map.js";
import { buildPreflightBrief } from "./preflight.js";
import { buildReadinessEnvelope, type MemoryReadinessEnvelope } from "./readiness.js";
import { buildReadinessViewerArtifact } from "./readiness-viewer.js";
import { executeReadOnlyMemoryOperation } from "./operations.js";
import { recall } from "./recall.js";
import { commitMemoryGraph, type MemoryGraphCommitResult } from "./vcs-commit.js";
import {
  structuralImpactReader,
  type StructuralImpact,
  type StructuralImpactTarget,
} from "./structural-impact-reader.js";
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
import type { Confidence, MemoryProvenance, MemoryScope } from "./schema.js";
import { slugify, storeNote } from "./store.js";

const USAGE = `memory — persistent memory for code agents

Usage:
  memory init [--mode markdown-only|graph] [--hooks] [--skill-telemetry] [--event-retention-days N] [--root <dir>] [--yes]
  memory store <fact...>            [--root <dir>] [--scope project|repo|branch|worktree|session|agent-run|user] [--scope-id ID]
  memory inbox quarantine <fact...> [--root <dir>] --reason <text> --evidence <summary> [--confidence EXTRACTED|INFERRED|AMBIGUOUS] [--source-kind manual|hook|derived|system] [--writer <name>] [--command <cmd>] [--hook <event>] [--json]
  memory inbox list                 [--root <dir>] [--status quarantined|approved|rejected|promoted|all] [--json]
  memory inbox inspect <id>         [--root <dir>] [--json]
  memory inbox approve <id>         [--root <dir>] --yes [--json]
  memory inbox reject <id>          [--root <dir>] --reason <text> --yes [--json]
  memory inbox promote <id>         [--root <dir>] --yes [--json]
  memory classify <candidate...>    [--root <dir>] [--json]
  memory recall <query...>          [--root <dir>] [--limit N] [--include-superseded] [--scope ...] [--scope-id ID] [--include-narrower-scopes] [--as-of <reddb-ref>]
  memory context-pack <goal...>     [--root <dir>] [--budget N] [--limit N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory recommend skills <task...> [--root <dir>] [--limit N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory claim-check <assertion...> [--root <dir>] [--json]
  memory preflight <task...>        [--root <dir>] [--limit N] [--min-evidence N] [--stale-days N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory readiness <goal...>        [--root <dir>] [--limit N] [--min-evidence N] [--stale-days N] [--json] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory readiness-viewer <goal...> [--root <dir>] [--out <file>] [--limit N] [--min-evidence N] [--stale-days N] [--scope ...] [--scope-id ID] [--include-narrower-scopes]
  memory learning-debt              [--root <dir>] [--stale-days N] [--json]
  memory onboarding-map             [--root <dir>] [--stale-days N] [--json]
  memory onboarding-map export <out-dir> --public-safe [--strict] [--root <dir>] [--json]
  memory ask <question...>          [--root <dir>] [--json]
  memory provenance <rid|label>     [--root <dir>] [--json]
  memory ingest <path>              [--root <dir>] [--max-files N]
  memory refresh [<path...>]         [--root <dir>] [--stdin] [--changed|--staged] [--json]
  memory extract [<transcript-file>] [--root <dir>]   (reads stdin if no file)
  memory event skill                [--root <dir>] [--event-type ...] ... (or JSON/JSONL on stdin)
  memory curate skills              [--root <dir>] [--stale-days N] [--json]   (report-only)
  memory improve skills             [--root <dir>] [--write-proposal] [--json]   (proposal-gated)
  memory improve proposals list      [--root <dir>] [--json]
  memory improve proposals show <proposal> [--root <dir>] [--json]
  memory improve proposals archive <proposal> --reason applied|rejected|stale --yes [--root <dir>] [--json]
  memory improve apply <proposal>    [--root <dir>] --yes [--json]   (explicit patch apply)
  memory health                    [--root <dir>] [--json]   (operational healthcheck, read-only)
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
  memory neighbors <label>          [--root <dir>] [--depth N] [--direction outgoing|incoming|both]
  memory traverse <label>           [--root <dir>] [--depth N] [--strategy bfs|dfs] [--direction ...]
  memory path <from> <to>           [--root <dir>] [--algorithm bfs|dijkstra]
  memory conflicts                  [--root <dir>] [--include-resolved] [--json]
  memory supersede <old-rid> <new-rid> [--root <dir>] [--reason <text>]
  memory resolve-conflict <active-rid> <superseded-rid> [--root <dir>] [--reason <text>]
  memory timeline <topic|rid>       [--root <dir>] [--include-audit] [--json]
  memory communities                [--root <dir>] [--no-cache] [--json]
  memory structural-impact          [--root <dir>] [--file <path>] [--symbol <name>]
  memory pre-pr-review              [--root <dir>] [--range <git-range>] [--json]
  memory vector status              [--root <dir>] [--json]
  memory vector maintain            [--root <dir>] [--strict] [--json]
  memory stats                      [--root <dir>]
  memory doctor                     [--root <dir>] [--stale-days N] [--prune] [--yes]
  memory export [<out-dir>]         [--root <dir>] [--communities]
  memory graph  [<out-dir>]         [--root <dir>] [--communities]   (alias of export)

  Auto-firing hooks (invoked by the plugin manifest, reads payload on stdin):
  memory hook <event> --runner <claude|codex>   [--root <dir>]

Two storage modes: markdown-only (plain notes, no engine) and graph (a typed
knowledge graph over a per-project RedDB store). Run \`memory init\` once to pick
one, then use /memory:store and /memory:recall (or the CLI verbs) — they route
to whichever mode init configured.`;

interface ParsedArgs {
  command: string | undefined;
  positional: string[];
  flags: Record<string, string | boolean>;
}

const execFileAsync = promisify(execFile);

function parseArgs(argv: string[]): ParsedArgs {
  const [command, ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command, positional, flags };
}

function rootOf(flags: Record<string, string | boolean>): string {
  return typeof flags.root === "string" ? flags.root : process.cwd();
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
        "What do you want to use? [markdown-only] / graph (hybrid lands in a later release): ",
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

  if (config.mode === "graph") {
    const asOf = stringFlag(args.flags, "as-of");
    const store = asOf
      ? await HistoricalMemoryStore.open({ uri: resolveStoreUri(rootDir, config), ref: asOf })
      : await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const { hits, diagnostics } = await graphRecallResult(store, query, limit, {
        includeSuperseded: args.flags["include-superseded"] === true,
        scope: scopeFlags(args.flags),
        now: asOf ? 0 : undefined,
      });
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
      }
    } finally {
      await store.close();
    }
    return;
  }

  const hits = await recall(resolveNotesDir(rootDir, config), query, limit);
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
    if (args.flags.json === true) {
      console.log(JSON.stringify(pack, null, 2));
      return;
    }
    process.stdout.write(pack.markdown);
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
    const result = await ask(store, question);
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
    if (result.cost) {
      console.log(
        `cost: ${result.cost.provider}/${result.cost.model} prompt=${result.cost.prompt_tokens} completion=${result.cost.completion_tokens} usd=${result.cost.cost_usd}`,
      );
    }
  } finally {
    await store.close();
  }
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

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const report = await ingestProject(store, { cwd, maxFiles });
    console.log(`memory: ingested ${cwd}`);
    console.log(
      `  ${report.files} file(s) → ${report.nodes} node(s), ${report.edges} edge(s), ${report.docs} doc(s) in ${report.durationMs}ms`,
    );
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
async function runCurate(args: ParsedArgs): Promise<void> {
  const kind = args.positional[0];
  if (kind !== "skills") {
    throw new Error("curate needs a kind — supported: memory curate skills");
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

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  let report;
  try {
    const rollups = await readSkillRollups(store);
    report = curateSkills(rollupsToCuratorInput(rollups), {
      staleDays: intFlag(args.flags, "stale-days"),
    });
  } finally {
    await store.close();
  }

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
  try {
    const rollups = await readSkillRollups(store);
    recent = await readRecentSkillEvents(store, 50);
    report = curateSkills(rollupsToCuratorInput(rollups), {
      staleDays: intFlag(args.flags, "stale-days"),
    });
  } finally {
    await store.close();
  }

  const proposals = await buildSkillImprovementProposals(rootDir, report.recommendations, recent, writeProposal);
  const state = proposals.length === 0 ? "no-candidates" : writeProposal ? "proposal-written" : "proposal-ready";

  if (json) {
    console.log(JSON.stringify({ state, proposals }, null, 2));
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
  reusedExisting: boolean;
  path: string | null;
  written: boolean;
}

async function buildSkillImprovementProposals(
  rootDir: string,
  recommendations: readonly { name: string; category: string; reason: string; path: string; curatable: boolean }[],
  recentEvents: readonly SkillEventSummary[],
  writeProposal: boolean,
): Promise<SkillImprovementProposalSummary[]> {
  const candidates = recommendations.filter((rec) => rec.curatable && rec.category === "frequently-failing");
  const proposals: SkillImprovementProposalSummary[] = [];
  const proposalDir = join(rootDir, ".red", "memory", "proposals");
  if (writeProposal && candidates.length > 0) await mkdir(proposalDir, { recursive: true });

  const pendingProposals = writeProposal ? await listPendingProposalFiles(rootDir) : [];

  for (const rec of candidates) {
    const evidence = recentFailureEvidence(rec.name, recentEvents);
    const dominantErrorStage = topValues(evidence.map((event) => event.error_stage))[0] ?? null;
    const dominantErrorClass = topValues(evidence.map((event) => event.error_class))[0] ?? null;
    const relSkillPath = isAbsolute(rec.path) ? toPosix(relative(rootDir, rec.path)) : rec.path;
    const fingerprint = proposalFingerprint({
      skill: rec.name,
      category: rec.category,
      skillPath: relSkillPath,
      dominantErrorStage,
      dominantErrorClass,
    });
    const body = await renderSkillImprovementProposal(rootDir, rec, evidence, fingerprint);
    const patchDrafted = body.includes("```json memory-skill-patch");
    const priority = computeProposalPriority({
      reason: rec.reason,
      recentFailures: evidence.length,
      dominantErrorStage,
      dominantErrorClass,
      patchDrafted,
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
      await writeFile(proposalPath, body, "utf8");
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
      reusedExisting,
      path: proposalPath,
      written: writeProposal,
    });
  }
  return sortProposalSummaries(proposals);
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

async function renderSkillImprovementProposal(
  rootDir: string,
  rec: { name: string; category: string; reason: string; path: string },
  evidence: SkillEventSummary[],
  fingerprint: string,
): Promise<string> {
  const relSkillPath = isAbsolute(rec.path) ? toPosix(relative(rootDir, rec.path)) : rec.path;
  const evidenceBlock = renderRecentFailureEvidence(evidence);
  const patchBlock = await renderDraftSkillPatchBlock(rootDir, rec, relSkillPath, evidence);
  return `# Skill Improvement Proposal: ${rec.name}

Status: approval-gated
Generated: ${new Date().toISOString()}
Fingerprint: ${fingerprint}

## Evidence

- Skill: ${rec.name}
- Category: ${rec.category}
- Reason: ${rec.reason}
- Skill path: ${relSkillPath}

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
    console.log(JSON.stringify({ state, reason, proposals }, null, 2));
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

  if (telemetryEnabled) {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      rollups = await readSkillRollups(store);
      const recent = await readRecentSkillEvents(store, 50);
      const curated = curateSkills(rollupsToCuratorInput(rollups));
      topProposals = await buildSkillImprovementProposals(
        rootDir,
        curated.recommendations,
        recent,
        false,
      );
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
 * LLM conversation extraction (the `INFERRED` write path). Reads a transcript
 * from a file or stdin, routes it through the configured RedDB AI provider, and
 * upserts the inferred facts into the graph. Requires graph mode and a
 * configured `provider`. This is an explicit write verb — the Stop hook and
 * `/memory:store` invoke it; recall/search never do.
 */
async function runExtract(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);

  if (config.mode !== "graph") {
    throw new Error(
      `extract needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  if (!config.provider) {
    throw new Error(
      "extract needs an AI provider configured — set `provider` in .red/memory/config.json",
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

  const resolved = resolveProvider(config.provider);
  applyProviderEnv(resolved, config.provider.apiKeyEnv);

  const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
  try {
    const facts = await extractConversation(transcript, redDbProviderClient(store));
    if (facts.length === 0) {
      console.log("memory: no facts extracted");
      return;
    }
    const { nodes, edges } = factsToGraph(facts);
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
    console.log(
      `memory: extracted ${nodes.length} INFERRED fact(s), ${edgeCount} edge(s) via ${resolved.mode} (${resolved.egress})`,
    );
  } finally {
    await store.close();
  }
}

/** Open the graph store for a read verb, erroring clearly outside graph mode. */
async function openGraphStore(args: ParsedArgs): Promise<{ store: MemoryStore }> {
  const rootDir = rootOf(args.flags);
  const config = await requireConfig(rootDir);
  if (config.mode !== "graph") {
    throw new Error(
      `this verb needs graph mode — this project is "${config.mode}". Re-run \`memory init --mode graph\` first`,
    );
  }
  return { store: await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) }) };
}

function intFlag(flags: Record<string, string | boolean>, key: string): number | undefined {
  return typeof flags[key] === "string" ? Number(flags[key]) : undefined;
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  return typeof flags[key] === "string" ? flags[key] : undefined;
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
    printTimeline(timeline, { includeAudit: args.flags["include-audit"] === true });
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
    console.log(`  graph hash: ${report.graph_hash}`);
    console.log(`  cache: ${report.cached ? "hit" : "miss"}`);
    for (const community of report.communities) {
      console.log(`  ${community.id}: ${community.count} node(s)`);
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
  if (action !== "status" && action !== "maintain") {
    throw new Error("vector needs an action — supported: memory vector status|maintain");
  }
  const { store } = await openGraphStore(args);
  try {
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
  } finally {
    await store.close();
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
  const { store } = await openGraphStore(args);
  try {
    const result = await exportGraph(store, outDir, { communities });
    console.log(`memory: exported ${result.nodes} node(s), ${result.edges} edge(s)`);
    if (communities) console.log(`  communities: coloured via native Louvain`);
    console.log(`  graph:  ${result.htmlPath}`);
    console.log(`  json:   ${result.jsonPath}`);
    console.log(`  audit:  ${result.auditPath}`);
  } finally {
    await store.close();
  }
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
    const result = await dispatch(input, rootDir);
    process.stdout.write(formatOutput(runner, event, result));
  } catch {
    // A hook must never abort the agent's turn — fail open, silently.
    process.stdout.write("{}");
  }
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init":
      return runInit(args);
    case "store":
      return runStore(args);
    case "commit":
      return runCommit(args);
    case "inbox":
      return runInbox(args);
    case "classify":
      return runClassify(args);
    case "recall":
      return runRecall(args);
    case "context-pack":
      return runContextPack(args);
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
    case "learning-debt":
      return runLearningDebt(args);
    case "onboarding-map":
      return runOnboardingMap(args);
    case "ask":
      return runAsk(args);
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
    case "search":
      return runSearch(args);
    case "neighbors":
      return runNeighbors(args);
    case "traverse":
      return runTraverse(args);
    case "path":
      return runPath(args);
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
    case "structural-impact":
      return runStructuralImpact(args);
    case "pre-pr-review":
      return runPrePrReview(args);
    case "vector":
      return runVector(args);
    case "stats":
      return runStats(args);
    case "doctor":
      return runDoctor(args);
    case "export":
    case "graph":
      return runExport(args);
    case "hook":
      return runHook(args);
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
