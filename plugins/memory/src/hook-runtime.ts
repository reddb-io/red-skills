import { basename } from "node:path";
import {
  type HookConfig,
  type MemoryConfig,
  readConfig,
  resolveStoreUri,
} from "./config.js";
import { recall as engineRecall, type RecallResult } from "./engine.js";
import { MemoryStore } from "./graph-store.js";
import { type IngestReport, reindexFiles } from "./ingest.js";
import type { MemoryNode, NodeType } from "./schema.js";
import { slugify } from "./store.js";

/**
 * The four auto-firing hooks, identified by their Claude Code event names. The
 * runner adapters map a runner's native event onto one of these before the
 * dispatcher routes it. Codex has no `PreCompact` equivalent (see the README's
 * Codex-vs-Claude note); on Codex the flush leans on `Stop` + `SessionStart`.
 */
export type HookEvent = "SessionStart" | "PostToolUse" | "Stop" | "PreCompact";

/** Which `config.hooks` flag gates each event. */
const EVENT_FLAG: Record<HookEvent, keyof HookConfig> = {
  SessionStart: "sessionStart",
  PostToolUse: "postToolUse",
  Stop: "stop",
  PreCompact: "preCompact",
};

export type Runner = "claude" | "codex";

/**
 * Runner-neutral hook input. The adapters ({@link parseClaudeInput},
 * {@link parseCodexInput}) flatten each runner's distinct stdin payload into
 * this one shape so the dispatcher and handlers never branch on runner.
 */
export interface NormalizedInput {
  event: HookEvent;
  runner: Runner;
  sessionId?: string;
  transcriptPath?: string;
  cwd?: string;
  /** Focus signals for SessionStart recall. Claude supplies these directly;
   *  on Codex they are derived from `cwd`/`transcriptPath`. */
  branch?: string;
  goal?: string;
  /** PostToolUse: absolute paths the agent just edited/wrote. */
  changedFiles: string[];
  /** Stop / PreCompact: the conversation text to extract memories from. */
  transcriptText?: string;
}

/** Runner-neutral hook outcome; the adapters render it to each runner's shape. */
export interface HookResult {
  /** True when the hook deliberately did nothing (gated off / not initialized). */
  noop: boolean;
  /** Why it no-op'd, for diagnostics. */
  reason?: string;
  /** Context to inject into the model's turn (SessionStart). */
  inject?: string;
  /** Memories persisted (Stop / PreCompact). */
  stored?: number;
  /** Files re-indexed (PostToolUse). */
  indexed?: number;
}

/** A memory the extractor lifted out of a conversation turn. */
export interface ExtractedMemory {
  node_type: Extract<NodeType, "decision" | "why_note">;
  title: string;
  content: string;
}

/**
 * Pulls durable memories (decisions, why-notes) out of a conversation turn.
 * The production extractor is a bounded LLM call; the default is the
 * deterministic {@link heuristicExtractor} so the runtime works — and is
 * testable — with no LLM key. Inject a real one through {@link HookDeps}.
 */
export type Extractor = (
  transcript: string,
) => ExtractedMemory[] | Promise<ExtractedMemory[]>;

/** Seams the dispatcher reaches the outside world through; overridable in tests. */
export interface HookDeps {
  readConfig: typeof readConfig;
  openStore: (uri: string) => Promise<MemoryStore>;
  recall: typeof engineRecall;
  reindexFiles: typeof reindexFiles;
  extractor: Extractor;
}

const NOOP_NODE_LIMIT = 12;

/** Cue phrases that mark a sentence as a decision or a why-note. */
const DECISION_CUES =
  /\b(decided|decision|chose|choosing|we'?ll use|going with|switch(?:ed|ing)? to|approach is|opted to|settled on)\b/i;
const WHYNOTE_CUES =
  /\b(because|the reason|since|so that|to avoid|in order to|trade-?off|that'?s why|rationale)\b/i;

/**
 * Deterministic, zero-token fallback extractor. Splits the transcript into
 * sentences and keeps those carrying a decision or why-note cue, capped so a
 * long turn can't flood the store. Good enough to make the hooks useful with no
 * LLM configured; a bounded-LLM extractor replaces it in production.
 */
export const heuristicExtractor: Extractor = (transcript) => {
  const out: ExtractedMemory[] = [];
  const seen = new Set<string>();
  const sentences = transcript
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 12 && s.length <= 400);

  for (const sentence of sentences) {
    const isDecision = DECISION_CUES.test(sentence);
    const isWhy = WHYNOTE_CUES.test(sentence);
    if (!isDecision && !isWhy) continue;
    const key = sentence.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      node_type: isDecision ? "decision" : "why_note",
      title: sentence.slice(0, 120),
      content: sentence,
    });
    if (out.length >= NOOP_NODE_LIMIT) break;
  }
  return out;
};

/** Default deps: real config read, real store, real engine recall + extractor. */
export function defaultDeps(): HookDeps {
  return {
    readConfig,
    openStore: (uri) => MemoryStore.open({ uri }),
    recall: engineRecall,
    reindexFiles,
    extractor: heuristicExtractor,
  };
}

/** Build the SessionStart recall query from the available focus signals. */
function focusQuery(input: NormalizedInput): string {
  const parts = [input.goal, input.branch, input.cwd ? basename(input.cwd) : undefined];
  return parts.filter((p): p is string => Boolean(p && p.trim())).join(" ").trim();
}

function extractedToNode(m: ExtractedMemory, event: HookEvent): MemoryNode {
  return {
    label: slugify(m.title),
    node_type: m.node_type,
    properties: {
      title: m.title,
      content: m.content,
      source: `hook:${event}`,
      confidence: "EXTRACTED",
    },
  };
}

/**
 * Route a normalized hook input to its handler, gating on the per-project
 * config first. Returns a no-op result — never throws — when memory is not
 * initialized here or the matching hook flag is off, so an unconfigured repo
 * (markdown-only included) is silent (AC3). All engine work happens only in an
 * engine-backed mode with the flag on.
 */
export async function dispatch(
  input: NormalizedInput,
  rootDir: string,
  deps: HookDeps = defaultDeps(),
): Promise<HookResult> {
  const config = await deps.readConfig(rootDir);
  if (!config) return { noop: true, reason: "memory not initialized" };
  if (!config.hooks[EVENT_FLAG[input.event]]) {
    return { noop: true, reason: `${input.event} hook disabled` };
  }
  // Hooks require an engine; markdown-only never reaches here (its flags are
  // always off) but guard anyway so a hand-edited config can't crash a turn.
  if (config.mode === "markdown-only") {
    return { noop: true, reason: "hooks need an engine-backed mode" };
  }

  switch (input.event) {
    case "SessionStart":
      return handleSessionStart(input, rootDir, config, deps);
    case "PostToolUse":
      return handlePostToolUse(input, rootDir, config, deps);
    case "Stop":
    case "PreCompact":
      return handleFlush(input, rootDir, config, deps);
  }
}

async function handleSessionStart(
  input: NormalizedInput,
  rootDir: string,
  config: MemoryConfig,
  deps: HookDeps,
): Promise<HookResult> {
  const query = focusQuery(input);
  if (!query) return { noop: true, reason: "no focus signal to recall on" };
  const store = await deps.openStore(resolveStoreUri(rootDir, config));
  try {
    const result: RecallResult = await deps.recall(store, query, { k: 8, depth: 1 });
    if (result.nodes.length === 0) {
      return { noop: true, reason: "no relevant memory" };
    }
    return { noop: false, inject: result.context_md };
  } finally {
    await store.close();
  }
}

async function handlePostToolUse(
  input: NormalizedInput,
  rootDir: string,
  config: MemoryConfig,
  deps: HookDeps,
): Promise<HookResult> {
  if (input.changedFiles.length === 0) {
    return { noop: true, reason: "no changed files" };
  }
  const store = await deps.openStore(resolveStoreUri(rootDir, config));
  try {
    const report = await deps.reindexFiles(store, input.changedFiles);
    if (report.files === 0) return { noop: true, reason: "no indexable files changed" };
    return { noop: false, indexed: report.files };
  } finally {
    await store.close();
  }
}

async function handleFlush(
  input: NormalizedInput,
  rootDir: string,
  config: MemoryConfig,
  deps: HookDeps,
): Promise<HookResult> {
  const text = input.transcriptText?.trim();
  if (!text) return { noop: true, reason: "empty transcript" };
  const memories = await deps.extractor(text);
  if (memories.length === 0) return { noop: true, reason: "nothing worth keeping" };
  const store = await deps.openStore(resolveStoreUri(rootDir, config));
  try {
    let stored = 0;
    for (const m of memories) {
      await store.upsertNode(extractedToNode(m, input.event));
      stored += 1;
    }
    return { noop: false, stored };
  } finally {
    await store.close();
  }
}

export type { IngestReport };
