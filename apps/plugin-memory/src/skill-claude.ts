import { contentHash } from "./hash.js";
import {
  parseSkillEvent,
  type SkillEvent,
  type SkillEventType,
  type SkillResultStatus,
} from "./skill-events.js";

/**
 * Claude Code → Memory Skill telemetry adapter.
 *
 * Claude exposes skill activity through its hook stream: skills are loaded by
 * reading a `SKILL.md`, invoked through the `Skill` tool, and their `SKILL.md`
 * files are edited like any other file. This module translates those
 * Claude-specific shapes into the runner-neutral {@link SkillEvent} contract the
 * Memory plugin owns — so `dev` never needs to know RedDB or graph internals.
 *
 * Everything here is fail-open: a malformed, partial, or unrecognized payload
 * yields zero events rather than throwing, so wiring this into a hook can never
 * break a normal Claude Code turn. Only the high-level contract is emitted; no
 * transcript or free-text is ever carried through.
 */

const RUNNER = "claude";

/** A single raw Claude hook payload (shape varies, so keep it open). */
export type ClaudeHookPayload = Record<string, unknown>;

/** Caller-supplied context the Claude payload does not always carry itself. */
export interface ClaudeSkillContext {
  /** Stable turn identifier; falls back to a session-derived marker. */
  turnId?: string;
  /** ISO timestamp for the event; defaults to now. Injectable for determinism. */
  now?: string;
}

function str(payload: ClaudeHookPayload, key: string): string | undefined {
  const v = payload[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pull the skill name out of a `Skill` tool call's input (`skill` or `name`). */
function skillNameFromInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input) return undefined;
  const name = input.skill ?? input.name;
  return typeof name === "string" && name.trim() ? name.trim() : undefined;
}

/**
 * Classify where a skill comes from. A namespaced name (`dev:tdd`) or a path
 * under a plugin's `skills/` tree is a plugin skill; a `SKILL.md` elsewhere is a
 * project skill; anything else defaults to `user`.
 */
function inferSourceKind(name: string, path: string): string {
  if (name.includes(":")) return "plugin";
  if (/\/plugins\/[^/]+\/.*skills\//.test(path)) return "plugin";
  if (path.includes("/.claude/skills/")) return "user";
  if (/skills?\//i.test(path)) return "project";
  return "user";
}

/** Synthesize a stable path for skills invoked by name (the `Skill` tool case). */
function skillPath(name: string, filePath: string | undefined): string {
  return filePath ?? `skill://${name}`;
}

/** Map a Claude `Skill` PostToolUse response to a result outcome, fail-open. */
function resultStatus(payload: ClaudeHookPayload): SkillResultStatus {
  const response = record(payload.tool_response ?? payload.toolResponse);
  if (!response) return "unknown";
  // Claude flags failures a few ways depending on the tool surface.
  if (response.is_error === true || response.error != null || response.success === false) {
    return "failed";
  }
  if (response.success === true || response.is_error === false) return "succeeded";
  return "unknown";
}

/**
 * Build a deterministic event id from the runner, session, turn, skill, event
 * type, path, and any stable discriminator Claude hands us (`tool_use_id`). The
 * same payload always hashes to the same id, so replayed hooks de-duplicate at
 * ingest time.
 */
function eventId(
  parts: {
    sessionId: string;
    turnId: string;
    name: string;
    eventType: SkillEventType;
    path: string;
  },
  discriminator: string | undefined,
): string {
  return contentHash(
    RUNNER,
    parts.sessionId,
    parts.turnId,
    parts.name,
    parts.eventType,
    parts.path,
    discriminator,
  );
}

/** True when a path is a skill manifest (`SKILL.md`, case-insensitive). */
function isSkillManifest(path: string): boolean {
  return /(?:^|\/)SKILL\.md$/i.test(path);
}

/** A view event fires when a `SKILL.md` is read into context. */
function viewedFrom(
  payload: ClaudeHookPayload,
  filePath: string | undefined,
): { eventType: SkillEventType; name: string; path: string } | undefined {
  const tool = str(payload, "tool_name") ?? str(payload, "toolName");
  if (tool !== "Read") return undefined;
  if (!filePath || !isSkillManifest(filePath)) return undefined;
  return { eventType: "viewed", name: skillNameFromPath(filePath), path: filePath };
}

/** Derive a skill name from a `SKILL.md` path: its containing directory name. */
function skillNameFromPath(path: string): string {
  const segments = path.split("/").filter(Boolean);
  // …/<skill-dir>/SKILL.md → the skill name is <skill-dir>.
  return segments.length >= 2 ? segments[segments.length - 2] : path;
}

/** A change/patch event fires when a `SKILL.md` is written or edited. */
function editFrom(
  payload: ClaudeHookPayload,
  filePath: string | undefined,
): { eventType: SkillEventType; name: string; path: string } | undefined {
  const tool = str(payload, "tool_name") ?? str(payload, "toolName");
  if (!tool || !filePath || !isSkillManifest(filePath)) return undefined;
  if (tool === "Write") return { eventType: "changed", name: skillNameFromPath(filePath), path: filePath };
  if (tool === "Edit" || tool === "MultiEdit")
    return { eventType: "patched", name: skillNameFromPath(filePath), path: filePath };
  return undefined;
}

/**
 * Translate one Claude hook payload into zero or more {@link SkillEvent}s.
 *
 * Recognized signals:
 * - `Read` of a `SKILL.md`              → `viewed`
 * - `Skill` tool PreToolUse             → `used`
 * - `Skill` tool PostToolUse            → `result` (status from the tool response)
 * - `Write` of a `SKILL.md`             → `changed`
 * - `Edit`/`MultiEdit` of a `SKILL.md`  → `patched`
 *
 * Anything else — or any payload that fails the contract's validation — yields
 * `[]`. Never throws.
 */
export function claudeSkillEvents(
  payload: ClaudeHookPayload,
  context: ClaudeSkillContext = {},
): SkillEvent[] {
  try {
    if (!payload || typeof payload !== "object") return [];

    const sessionId = str(payload, "session_id") ?? str(payload, "sessionId");
    if (!sessionId) return [];
    const turnId = context.turnId?.trim() || str(payload, "turn_id") || `t:${sessionId}`;
    const timestamp = context.now ?? new Date().toISOString();

    const hookEvent = str(payload, "hook_event_name") ?? str(payload, "hookEventName");
    const tool = str(payload, "tool_name") ?? str(payload, "toolName");
    const input = record(payload.tool_input ?? payload.toolInput);
    const filePath =
      (input && (typeof input.file_path === "string" ? input.file_path : undefined)) ??
      (input && (typeof input.filePath === "string" ? input.filePath : undefined));
    const discriminator = str(payload, "tool_use_id") ?? str(payload, "toolUseId");

    let kind: { eventType: SkillEventType; name: string; path: string } | undefined;
    let result: SkillEvent["result"] | undefined;

    if (tool === "Skill") {
      const name = skillNameFromInput(input);
      if (!name) return [];
      const path = skillPath(name, filePath);
      if (hookEvent === "PostToolUse") {
        kind = { eventType: "result", name, path };
        result = { status: resultStatus(payload) };
      } else {
        // PreToolUse (or an unlabeled Skill call) is the invocation itself.
        kind = { eventType: "used", name, path };
      }
    } else {
      kind = viewedFrom(payload, filePath) ?? editFrom(payload, filePath);
    }

    if (!kind) return [];

    const candidate: Record<string, unknown> = {
      event_type: kind.eventType,
      event_id: eventId(
        { sessionId, turnId, name: kind.name, eventType: kind.eventType, path: kind.path },
        discriminator,
      ),
      timestamp,
      session_id: sessionId,
      turn_id: turnId,
      name: kind.name,
      source_kind: inferSourceKind(kind.name, kind.path),
      path: kind.path,
      runner: RUNNER,
    };
    if (result) candidate.result = result;

    return [parseSkillEvent(candidate)];
  } catch {
    // Fail open: a bad payload must never break a Claude turn.
    return [];
  }
}
