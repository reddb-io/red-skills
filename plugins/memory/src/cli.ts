#!/usr/bin/env node
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import {
  readConfig,
  resolveNotesDir,
  resolveStoreUri,
  skillTelemetryEnabled,
} from "./config.js";
import { diagnose, prune } from "./doctor.js";
import { neighbors, path as shortestPath, search, traverse } from "./engine.js";
import { exportGraph } from "./export.js";
import {
  extractConversation,
  factsToGraph,
  resolveProvider,
} from "./extract-conversation.js";
import { formatOutput, parseInput, type RawPayload } from "./hook-adapters.js";
import { dispatch, type HookEvent, type Runner } from "./hook-runtime.js";
import { graphRecall } from "./graph-recall.js";
import { MemoryStore, factToNode } from "./graph-store.js";
import { ingestProject } from "./ingest.js";
import { initGraph, initMarkdownOnly } from "./init.js";
import { applyProviderEnv, redDbProviderClient } from "./provider-client.js";
import { recall } from "./recall.js";
import {
  structuralImpactReader,
  type StructuralImpact,
  type StructuralImpactTarget,
} from "./structural-impact-reader.js";
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
import { slugify, storeNote } from "./store.js";

const USAGE = `memory — persistent memory for code agents

Usage:
  memory init [--mode markdown-only|graph] [--hooks] [--skill-telemetry] [--root <dir>] [--yes]
  memory store <fact...>            [--root <dir>]
  memory recall <query...>          [--root <dir>] [--limit N] [--include-superseded]
  memory ingest <path>              [--root <dir>] [--max-files N]
  memory extract [<transcript-file>] [--root <dir>]   (reads stdin if no file)
  memory event skill                [--root <dir>] [--event-type ...] ... (or JSON/JSONL on stdin)
  memory curate skills              [--root <dir>] [--stale-days N] [--json]   (report-only)
  memory improve skills             [--root <dir>] [--write-proposal] [--json]   (proposal-gated)
  memory improve apply <proposal>    [--root <dir>] --yes [--json]   (explicit patch apply)
  memory status skills              [--root <dir>] [--all] [--limit N] [--json]   (diagnostic, read-only)
  memory status context             [--root <dir>] [--json]   (context stack healthcheck, read-only)

  Graph-mode read verbs (require \`memory init --mode graph\`):
  memory search <query...>          [--root <dir>] [--limit N]
  memory neighbors <label>          [--root <dir>] [--depth N] [--direction outgoing|incoming|both]
  memory traverse <label>           [--root <dir>] [--depth N] [--strategy bfs|dfs] [--direction ...]
  memory path <from> <to>           [--root <dir>] [--algorithm bfs|dijkstra]
  memory structural-impact          [--root <dir>] [--file <path>] [--symbol <name>]
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
    const result = await initGraph(rootDir, { hooks, skillTelemetry });
    const on = Object.values(result.config.hooks).some(Boolean);
    console.log(`memory: initialized graph mode`);
    console.log(`  config: ${result.configPath}`);
    console.log(`  store:  ${result.storeUri}`);
    console.log(`  hooks:  ${on ? "on" : "off"}    mcp: off    reddb: required`);
    console.log(`  skill telemetry: ${result.config.skillTelemetry ? "on" : "off"}`);
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
      const rid = await store.upsertNode(factToNode(fact, slugify));
      console.log(`memory: stored node ${rid}`);
    } finally {
      await store.close();
    }
    return;
  }

  const note = await storeNote(resolveNotesDir(rootDir, config), fact);
  console.log(`memory: stored ${note.id}`);
  console.log(`  ${note.path}`);
}

async function runRecall(args: ParsedArgs): Promise<void> {
  const rootDir = rootOf(args.flags);
  const query = args.positional.join(" ").trim();
  if (!query) throw new Error("nothing to recall — pass a query: memory recall <query>");
  const config = await requireConfig(rootDir);
  const limit = typeof args.flags.limit === "string" ? Number(args.flags.limit) : 10;

  if (config.mode === "graph") {
    const store = await MemoryStore.open({ uri: resolveStoreUri(rootDir, config) });
    try {
      const hits = await graphRecall(store, query, limit, {
        includeSuperseded: args.flags["include-superseded"] === true,
      });
      if (hits.length === 0) {
        console.log(`memory: no matches for "${query}"`);
        return;
      }
      console.log(`memory: ${hits.length} match(es) for "${query}"`);
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
  if (kind !== "skills") {
    throw new Error("improve needs a kind — supported: memory improve skills|apply");
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
  try {
    const rollups = await readSkillRollups(store);
    report = curateSkills(rollupsToCuratorInput(rollups), {
      staleDays: intFlag(args.flags, "stale-days"),
    });
  } finally {
    await store.close();
  }

  const proposals = await buildSkillImprovementProposals(rootDir, report.recommendations, writeProposal);
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
  path: string | null;
  written: boolean;
}

async function buildSkillImprovementProposals(
  rootDir: string,
  recommendations: readonly { name: string; category: string; reason: string; path: string; curatable: boolean }[],
  writeProposal: boolean,
): Promise<SkillImprovementProposalSummary[]> {
  const candidates = recommendations.filter((rec) => rec.curatable && rec.category === "frequently-failing");
  const proposals: SkillImprovementProposalSummary[] = [];
  const proposalDir = join(rootDir, ".red", "memory", "proposals");
  if (writeProposal && candidates.length > 0) await mkdir(proposalDir, { recursive: true });

  for (const rec of candidates) {
    const body = renderSkillImprovementProposal(rootDir, rec);
    let proposalPath: string | null = null;
    if (writeProposal) {
      const file = `skill-improvement-${slugify(rec.name)}-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
      proposalPath = join(proposalDir, file);
      await writeFile(proposalPath, body, "utf8");
    }
    proposals.push({
      skill: rec.name,
      category: rec.category,
      reason: rec.reason,
      skillPath: rec.path,
      path: proposalPath,
      written: writeProposal,
    });
  }
  return proposals;
}

function renderSkillImprovementProposal(
  rootDir: string,
  rec: { name: string; category: string; reason: string; path: string },
): string {
  const relSkillPath = isAbsolute(rec.path) ? toPosix(relative(rootDir, rec.path)) : rec.path;
  return `# Skill Improvement Proposal: ${rec.name}

Status: approval-gated
Generated: ${new Date().toISOString()}

## Evidence

- Skill: ${rec.name}
- Category: ${rec.category}
- Reason: ${rec.reason}
- Skill path: ${relSkillPath}

## Hypothesis

Telemetry indicates this skill is repeatedly failing. The most likely root cause is missing prerequisite checks, ambiguous execution steps, incomplete verification guidance, or outdated tool instructions.

## Proposed Patch

Do not apply blindly. Review ${relSkillPath} and patch the smallest section that addresses the observed failure pattern.

Suggested patch targets:

1. Add or tighten prerequisite checks before the failure stage.
2. Add a troubleshooting note for the observed failure mode.
3. Add an explicit verification command or expected output.
4. Add a pitfall warning if the failure is caused by a common misuse.

## Validation Plan

1. Re-run the task or fixture that produced the failure.
2. Run any repo-specific metadata and skill validators.
3. Record a new Skill result event after validation.
4. Keep this proposal with the review notes, or delete it if rejected.

## Apply Policy

This proposal is intentionally approval-gated. The Memory plugin wrote this proposal file only; it did not patch, archive, delete, or rewrite the Skill.
`;
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

async function runStats(args: ParsedArgs): Promise<void> {
  const { store } = await openGraphStore(args);
  try {
    const stats = await store.stats();
    console.log(`memory: ${stats.nodes} node(s), ${stats.edges} edge(s)`);
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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  switch (args.command) {
    case "init":
      return runInit(args);
    case "store":
      return runStore(args);
    case "recall":
      return runRecall(args);
    case "ingest":
      return runIngest(args);
    case "event":
      return runSkillEvent(args);
    case "curate":
      return runCurate(args);
    case "improve":
      return runImprove(args);
    case "status":
      return runStatus(args);
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
    case "structural-impact":
      return runStructuralImpact(args);
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
