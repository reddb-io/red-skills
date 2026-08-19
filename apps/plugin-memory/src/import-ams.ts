/**
 * AMS importer (PRD #174, issue #184). One-shot offline migration from a Redis
 * `agent-memory-server` (AMS) JSON dump into our local-first graph.
 *
 * Mapping (see `docs/migrating-from-ams.md`):
 *   - AMS `working_memory[]` → L2 typed event stream + raw transcript blob,
 *     partitioned by `session_id`.
 *   - AMS `long_term_memory[]` → L3 typed nodes. Each entry runs through the
 *     PromotionEngine dedup gate against the live L3 graph (and against
 *     previously-imported entries in the same pass), so re-running the importer
 *     on the same dump bumps reinforcement counts instead of duplicating nodes.
 *
 * Conflicts surface as `CONTRADICTS` edges via `MemoryStore.upsertNode`'s
 * built-in detector (issue #179) — no silent overwrites.
 *
 * Pure orchestration: read JSON → derive typed candidates → call existing
 * working-memory / store / promotion-engine APIs. The heuristic that maps free-
 * form AMS text to typed candidates is intentionally simple (regex + memory_type
 * field); the goal is a starting point users can refine with `memory recall`
 * and `memory doctor`, not a perfect classifier.
 */
import { readFile } from "node:fs/promises";
import {
  CONFLICT_NODE_TYPES,
  detectConflicts,
  type ConflictNode,
} from "./conflict-detector.js";
import type { MemoryStore } from "./graph-store.js";
import {
  runPromotionEngine,
  type PromotionCandidate,
  type PromotionExistingNode,
} from "./promotion-engine.js";
import type { MemoryNode, NodeType } from "./schema.js";
import { start as sessionStart, current as sessionCurrent } from "./session-manager.js";
import { slugify } from "./store.js";
import {
  appendEvent,
  setRawTranscript,
} from "./working-memory.js";

export interface AmsMemoryEntry {
  /** AMS opaque id (preserved as provenance evidence). */
  id?: string;
  text?: string;
  memory_type?: string;
  /** Free-form topic / entity hints (used in keyword classification). */
  topics?: string[];
  entities?: string[];
  /** ISO-8601 timestamps from AMS; reused on the imported node when available. */
  created_at?: string;
  updated_at?: string;
  /** L2/L3 session affinity. Required for working_memory entries to land on a
   *  meaningful L2 session; long_term entries may omit it. */
  session_id?: string;
  /** Multi-tenant axis we do not model — ignored at import. */
  user_id?: string;
  /** AMS namespace; preserved as a tag for filterable recall. */
  namespace?: string;
}

export interface AmsMessageEntry {
  role?: string;
  content?: string;
  timestamp?: string;
}

export interface AmsWorkingMemoryBlock {
  session_id?: string;
  user_id?: string;
  messages?: AmsMessageEntry[];
  memories?: AmsMemoryEntry[];
}

export interface AmsDump {
  working_memory?: AmsWorkingMemoryBlock[];
  long_term_memory?: AmsMemoryEntry[];
}

export interface ImportReport {
  working: {
    sessions: string[];
    events: number;
    transcripts: number;
  };
  long_term: {
    promoted: number;
    reinforced: number;
    skipped: number;
    promoted_rids: number[];
    reinforced_rids: number[];
  };
}

const DECISION_PREFIX = /^\s*decision\s*[:\-]/i;
const FIX_PREFIX = /^\s*fix\s*[:\-]/i;
const GOTCHA_PREFIX = /^\s*gotcha\s*[:\-]/i;
const WHY_PREFIX = /^\s*(why|reason|because)\s*[:\-]/i;
const PROBLEM_PREFIX = /^\s*problem\s*[:\-]/i;
const SOLUTION_PREFIX = /^\s*solution\s*[:\-]/i;
const VALIDATION_PREFIX = /^\s*(validation|verified|confirmed)\s*[:\-]/i;
const GOAL_PREFIX = /^\s*goal\s*[:\-]/i;

/**
 * Best-effort classifier mapping free-form AMS text + the AMS `memory_type`
 * field onto one of our typed node_types. Explicit AMS hints win; the regex
 * fallback handles AMS dumps that store decisions/fixes as plain "Decision: …"
 * sentences. Falls back to `concept` so every entry is importable.
 */
export function inferNodeType(entry: AmsMemoryEntry): NodeType {
  const explicit = (entry.memory_type ?? "").toLowerCase();
  switch (explicit) {
    case "decision":
      return "decision";
    case "fix":
      return "fix";
    case "why_note":
    case "reasoning":
    case "why":
      return "why_note";
    case "solution":
      return "solution";
    case "problem":
      return "problem";
    case "validation":
      return "validation";
    case "goal":
      return "goal";
  }
  const text = entry.text ?? "";
  if (DECISION_PREFIX.test(text)) return "decision";
  if (FIX_PREFIX.test(text)) return "fix";
  if (GOTCHA_PREFIX.test(text)) return "why_note";
  if (PROBLEM_PREFIX.test(text)) return "problem";
  if (SOLUTION_PREFIX.test(text)) return "solution";
  if (VALIDATION_PREFIX.test(text)) return "validation";
  if (GOAL_PREFIX.test(text)) return "goal";
  if (WHY_PREFIX.test(text)) return "why_note";
  return "concept";
}

/** Same heuristic, but for the L2 candidate event_type label. */
function inferEventType(entry: AmsMemoryEntry): string {
  const node = inferNodeType(entry);
  if (node === "concept") {
    const explicit = (entry.memory_type ?? "").toLowerCase();
    if (explicit === "message") return "user_input";
    if (explicit === "episodic") return "episode";
    return "note_candidate";
  }
  return `${node}_candidate`;
}

function titleFromText(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text;
  return firstLine.replace(/^\s*\w+\s*[:\-]\s*/i, "").trim().slice(0, 200) || firstLine.slice(0, 200);
}

function isoToEpoch(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const n = Date.parse(iso);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read an AMS dump and write its contents into the local memory graph.
 * Idempotent on long_term entries (dedup gate); working_memory replays append
 * fresh L2 events but the session id is preserved, so successive imports stack
 * cleanly into the same session timeline.
 */
export async function importAmsDump(
  store: MemoryStore,
  rootDir: string,
  dumpPath: string,
): Promise<ImportReport> {
  const raw = await readFile(dumpPath, "utf8");
  const dump = parseAmsDump(raw, dumpPath);
  return importAms(store, rootDir, dump);
}

export function parseAmsDump(raw: string, source = "<ams-dump>"): AmsDump {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `${source}: invalid JSON — ${(err as Error).message}`,
    );
  }
  if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a JSON object at the top level`);
  }
  const obj = parsed as Record<string, unknown>;
  const wm = obj.working_memory;
  const ltm = obj.long_term_memory;
  if (wm !== undefined && !Array.isArray(wm)) {
    throw new Error(`${source}: \`working_memory\` must be an array if present`);
  }
  if (ltm !== undefined && !Array.isArray(ltm)) {
    throw new Error(`${source}: \`long_term_memory\` must be an array if present`);
  }
  return {
    working_memory: wm as AmsWorkingMemoryBlock[] | undefined,
    long_term_memory: ltm as AmsMemoryEntry[] | undefined,
  };
}

/**
 * Apply an already-parsed AMS dump. Kept separate from {@link importAmsDump}
 * so tests can drive synthetic dumps without round-tripping through a file.
 */
export async function importAms(
  store: MemoryStore,
  rootDir: string,
  dump: AmsDump,
): Promise<ImportReport> {
  const workingReport = {
    sessions: [] as string[],
    events: 0,
    transcripts: 0,
  };
  const sessionsSeen = new Set<string>();

  // Preserve the caller's "current" session so the importer never silently
  // hijacks an active session-manager.
  const originalSession = await sessionCurrent(rootDir);

  try {
    for (const block of dump.working_memory ?? []) {
      const sessionId = (block.session_id ?? "").trim();
      if (!sessionId) {
        // AMS occasionally omits session_id on stateless message dumps; mint a
        // synthetic one rather than dropping the data.
        const synthetic = `ams-import-${sessionsSeen.size + 1}`;
        await sessionStart(rootDir, { id: synthetic });
        sessionsSeen.add(synthetic);
        workingReport.sessions.push(synthetic);
      } else {
        await sessionStart(rootDir, { id: sessionId });
        if (!sessionsSeen.has(sessionId)) {
          sessionsSeen.add(sessionId);
          workingReport.sessions.push(sessionId);
        }
      }

      for (const memory of block.memories ?? []) {
        const text = (memory.text ?? "").trim();
        if (!text) continue;
        await appendEvent(store, rootDir, {
          type: inferEventType(memory),
          value: text,
        });
        workingReport.events++;
      }

      const messages = block.messages ?? [];
      if (messages.length > 0) {
        const transcript = messages
          .map((m) => {
            const role = (m.role ?? "unknown").trim() || "unknown";
            const content = (m.content ?? "").trim();
            return `${role}: ${content}`;
          })
          .join("\n");
        await setRawTranscript(store, rootDir, transcript);
        workingReport.transcripts++;
      }
    }
  } finally {
    // Restore caller's session (or clear it if there was none).
    if (originalSession) {
      await sessionStart(rootDir, { id: originalSession });
    }
  }

  const longTerm = await importLongTerm(store, rootDir, dump.long_term_memory ?? []);

  return {
    working: workingReport,
    long_term: longTerm,
  };
}

async function importLongTerm(
  store: MemoryStore,
  _rootDir: string,
  entries: AmsMemoryEntry[],
): Promise<ImportReport["long_term"]> {
  const promoted_rids: number[] = [];
  const reinforced_rids: number[] = [];

  // PromotionEngine wants typed candidates + existing nodes; we run it once
  // per entry against the live L3 graph (refreshed each iteration because
  // upsertNode mutates it). That keeps in-batch dedup honest even across two
  // entries that both target the same node type with similar text.
  let skipped = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    const text = (entry.text ?? "").trim();
    if (!text) {
      skipped++;
      continue;
    }
    const nodeType = inferNodeType(entry);
    const title = titleFromText(text);
    // Always carry full text as content so downstream conflict / dedup checks
    // see the polarity-bearing words (e.g. "not", "never") even when the title
    // truncated them out.
    const content = text;

    const candidate: PromotionCandidate = {
      id: entry.id ?? `ams-ltm-${i}`,
      type: nodeType,
      title,
      content,
    };

    const allNodes = await store.listNodes();
    const overlay = await store.reinforcementRecords();
    const existing: PromotionExistingNode[] = [];
    const conflictPeers: ConflictNode[] = [];
    for (const n of allNodes) {
      if (n.properties.layer === "L2") continue;
      existing.push({
        rid: n.rid,
        type: n.node_type,
        title: String(n.properties.title ?? n.label),
        content: typeof n.properties.content === "string" ? n.properties.content : undefined,
        reinforced: overlay.get(n.rid) ?? (Number(n.properties.reinforced ?? 0) || 0),
      });
      if (n.node_type === nodeType) {
        conflictPeers.push({
          rid: n.rid,
          label: n.label,
          node_type: n.node_type,
          properties: n.properties,
        });
      }
    }

    // Build the L3 node we *would* write so the conflict detector can probe it
    // against existing peers before we let the dedup gate run. Import-time
    // contradictions must surface as CONTRADICTS edges (issue #184 / #179) —
    // letting the dedup gate collapse a polarity flip into a reinforcement
    // would hide exactly the disagreement the importer is supposed to expose.
    const candidateNode: ConflictNode = {
      label: slugify(title || String(candidate.id)),
      node_type: nodeType,
      properties: {
        title,
        content,
      },
    };
    const contradicts =
      CONFLICT_NODE_TYPES.has(nodeType) && detectConflicts(candidateNode, conflictPeers).length > 0;

    if (!contradicts) {
      const result = runPromotionEngine({
        candidates: [candidate],
        existing,
        options: {
          // Import accepts every type we mapped, even ones the default whitelist
          // would reject (e.g. `concept`). The dedup gate still applies.
          promotableTypes: new Set([nodeType]),
        },
      });

      if (result.skipped.length > 0) {
        skipped++;
        continue;
      }

      if (result.reinforce.length > 0) {
        const r = result.reinforce[0];
        await store.recordReinforcement(r.target_rid);
        reinforced_rids.push(r.target_rid);
        continue;
      }
    }

    // Promote: build a real L3 node and upsert. upsertNode wires the conflict
    // detector automatically (issue #179) — contradictions land as
    // `CONTRADICTS` edges from the new node.
    const node: MemoryNode = {
      label: slugify(title || String(candidate.id)),
      node_type: nodeType,
      properties: {
        title,
        content,
        ...(entry.namespace ? { ams_namespace: entry.namespace } : {}),
        source: `ams-import${entry.id ? `:${entry.id}` : ""}`,
        confidence: "EXTRACTED",
        layer: "L3",
        ...(isoToEpoch(entry.created_at) != null
          ? { created_at: isoToEpoch(entry.created_at) }
          : {}),
        ...(isoToEpoch(entry.updated_at) != null
          ? { updated_at: isoToEpoch(entry.updated_at) }
          : {}),
        ...(entry.session_id ? { scope: "session", scope_id: entry.session_id } : {}),
        provenance: {
          source_kind: "system",
          writer: "memory",
          command: "memory import ams",
          evidence: [
            entry.id ? `ams_id:${entry.id}` : "ams_id:<missing>",
            entry.session_id ? `ams_session:${entry.session_id}` : "ams_session:<missing>",
          ],
        },
      },
    };
    const rid = await store.upsertNode(node);
    promoted_rids.push(rid);
  }

  return {
    promoted: promoted_rids.length,
    reinforced: reinforced_rids.length,
    skipped,
    promoted_rids,
    reinforced_rids,
  };
}
