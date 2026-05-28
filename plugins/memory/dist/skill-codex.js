import { contentHash } from "./hash.js";
import { parseSkillEvent, } from "./skill-events.js";
/**
 * Codex CLI → Memory Skill telemetry adapter.
 *
 * Codex surfaces skill activity through its hook stream — the same high-level
 * lifecycle as Claude, but with Codex-specific mechanics: skills are loaded by
 * reading a `SKILL.md` (`read_file`), invoked through a `skill` tool, and their
 * `SKILL.md` files are edited through `apply_patch` rather than `Edit`/`Write`.
 * This module translates those Codex shapes into the runner-neutral
 * {@link SkillEvent} contract the Memory plugin owns — so `dev` never needs to
 * know RedDB or graph internals, and so a Codex event stores the same logical
 * shape as a Claude one.
 *
 * Everything here is fail-open: a malformed, partial, or unrecognized payload
 * yields zero events rather than throwing, so wiring this into a hook can never
 * break a normal Codex turn. Only the high-level contract is emitted; no
 * transcript or free-text is ever carried through.
 */
const RUNNER = "codex";
function str(payload, key) {
    const v = payload[key];
    return typeof v === "string" && v.trim() ? v.trim() : undefined;
}
function record(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
/** Pull the skill name out of a `skill` tool call's input (`skill` or `name`). */
function skillNameFromInput(input) {
    if (!input)
        return undefined;
    const name = input.skill ?? input.name;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
}
/**
 * Classify where a skill comes from. A namespaced name (`dev:tdd`) or a path
 * under a plugin's `skills/` tree is a plugin skill; Codex's per-user skill
 * directory is `user`; a `SKILL.md` elsewhere under a `skills/` tree is a
 * project skill; anything else defaults to `user`.
 */
function inferSourceKind(name, path) {
    if (name.includes(":"))
        return "plugin";
    if (/\/plugins\/[^/]+\/.*skills\//.test(path))
        return "plugin";
    if (path.includes("/.codex/skills/"))
        return "user";
    if (/skills?\//i.test(path))
        return "project";
    return "user";
}
/** Synthesize a stable path for skills invoked by name (the `skill` tool case). */
function skillPath(name, filePath) {
    return filePath ?? `skill://${name}`;
}
/** Map a Codex `skill` PostToolUse response to a result outcome, fail-open. */
function resultStatus(payload) {
    const response = record(payload.tool_response ?? payload.toolResponse);
    if (!response)
        return "unknown";
    // Codex flags failures a few ways depending on the tool surface.
    if (response.is_error === true || response.error != null || response.success === false) {
        return "failed";
    }
    if (response.success === true || response.is_error === false)
        return "succeeded";
    return "unknown";
}
/**
 * Build a deterministic event id from the runner, session, turn, skill, event
 * type, path, and any stable discriminator Codex hands us (`call_id`). The same
 * payload always hashes to the same id, so replayed hooks de-duplicate at
 * ingest time.
 */
function eventId(parts, discriminator) {
    return contentHash(RUNNER, parts.sessionId, parts.turnId, parts.name, parts.eventType, parts.path, discriminator);
}
/** True when a path is a skill manifest (`SKILL.md`, case-insensitive). */
function isSkillManifest(path) {
    return /(?:^|\/)SKILL\.md$/i.test(path);
}
/** Derive a skill name from a `SKILL.md` path: its containing directory name. */
function skillNameFromPath(path) {
    const segments = path.split("/").filter(Boolean);
    // …/<skill-dir>/SKILL.md → the skill name is <skill-dir>.
    return segments.length >= 2 ? segments[segments.length - 2] : path;
}
/** The path key Codex read-style tools use varies, so probe the common ones. */
function readPath(input) {
    if (!input)
        return undefined;
    for (const key of ["path", "file_path", "filePath"]) {
        const v = input[key];
        if (typeof v === "string" && v.trim())
            return v.trim();
    }
    return undefined;
}
/** A view event fires when a `SKILL.md` is read into context (`read_file`). */
function viewedFrom(tool, input) {
    if (tool !== "read_file" && tool !== "Read")
        return undefined;
    const path = readPath(input);
    if (!path || !isSkillManifest(path))
        return undefined;
    return { eventType: "viewed", name: skillNameFromPath(path), path };
}
/** Parse the `*** Add/Update/Delete File:` lines out of an apply_patch envelope. */
function patchOpsFromEnvelope(text) {
    const ops = [];
    const re = /^\*\*\*\s+(Add|Update|Delete)\s+File:\s*(.+?)\s*$/gim;
    let match;
    while ((match = re.exec(text)) !== null) {
        ops.push({ op: match[1].toLowerCase(), path: match[2] });
    }
    return ops;
}
/** Read a structured `changes` map: `{ "<path>": { type: "add"|"update"|... } }`. */
function patchOpsFromChanges(changes) {
    const ops = [];
    for (const [path, value] of Object.entries(changes)) {
        if (!path.trim())
            continue;
        const meta = record(value);
        const raw = (meta && (typeof meta.type === "string" ? meta.type : typeof meta.kind === "string" ? meta.kind : undefined)) ??
            undefined;
        const op = raw === "add" || raw === "delete" ? raw : "update";
        ops.push({ op, path: path.trim() });
    }
    return ops;
}
/** Collect every file operation an `apply_patch` payload describes. */
function patchOps(input) {
    if (!input)
        return [];
    const envelope = (typeof input.input === "string" ? input.input : undefined) ??
        (typeof input.patch === "string" ? input.patch : undefined);
    if (envelope)
        return patchOpsFromEnvelope(envelope);
    const changes = record(input.changes);
    if (changes)
        return patchOpsFromChanges(changes);
    return [];
}
/**
 * Map an `apply_patch` operation on a `SKILL.md` to a change/patch event. A
 * wholesale add (or delete) of the manifest is a `changed`; an in-place update
 * is a `patched` — mirroring Claude's `Write`→`changed`, `Edit`→`patched`.
 */
function editsFrom(tool, input) {
    if (tool !== "apply_patch")
        return [];
    return patchOps(input)
        .filter((op) => isSkillManifest(op.path))
        .map((op) => ({
        eventType: op.op === "update" ? "patched" : "changed",
        name: skillNameFromPath(op.path),
        path: op.path,
    }));
}
/**
 * Translate one Codex hook payload into zero or more {@link SkillEvent}s.
 *
 * Recognized signals:
 * - `read_file` of a `SKILL.md`         → `viewed`
 * - `skill` tool PreToolUse             → `used`
 * - `skill` tool PostToolUse            → `result` (status from the tool response)
 * - `apply_patch` adding a `SKILL.md`   → `changed`
 * - `apply_patch` updating a `SKILL.md` → `patched`
 *
 * A single `apply_patch` can touch several manifests, so it can yield several
 * events. Anything else — or any candidate that fails the contract's
 * validation — is dropped. Never throws.
 */
export function codexSkillEvents(payload, context = {}) {
    try {
        if (!payload || typeof payload !== "object")
            return [];
        const sessionId = str(payload, "session_id") ?? str(payload, "sessionId");
        if (!sessionId)
            return [];
        const turnId = context.turnId?.trim() ||
            str(payload, "turn_id") ||
            str(payload, "turnId") ||
            `t:${sessionId}`;
        const timestamp = context.now ?? new Date().toISOString();
        const hookEvent = str(payload, "hook_event_name") ?? str(payload, "hookEventName");
        const tool = str(payload, "tool_name") ?? str(payload, "toolName");
        const input = record(payload.tool_input ?? payload.toolInput);
        const discriminator = str(payload, "call_id") ?? str(payload, "tool_use_id") ?? str(payload, "toolUseId");
        const candidates = [];
        if (tool === "skill" || tool === "Skill") {
            const name = skillNameFromInput(input);
            if (!name)
                return [];
            const path = skillPath(name, readPath(input));
            if (hookEvent === "PostToolUse") {
                candidates.push({
                    kind: { eventType: "result", name, path },
                    result: { status: resultStatus(payload) },
                });
            }
            else {
                // PreToolUse (or an unlabeled skill call) is the invocation itself.
                candidates.push({ kind: { eventType: "used", name, path } });
            }
        }
        else {
            const viewed = viewedFrom(tool, input);
            if (viewed)
                candidates.push({ kind: viewed });
            for (const kind of editsFrom(tool, input))
                candidates.push({ kind });
        }
        const events = [];
        for (const { kind, result } of candidates) {
            const candidate = {
                event_type: kind.eventType,
                event_id: eventId({ sessionId, turnId, name: kind.name, eventType: kind.eventType, path: kind.path }, discriminator),
                timestamp,
                session_id: sessionId,
                turn_id: turnId,
                name: kind.name,
                source_kind: inferSourceKind(kind.name, kind.path),
                path: kind.path,
                runner: RUNNER,
            };
            if (result)
                candidate.result = result;
            events.push(parseSkillEvent(candidate));
        }
        return events;
    }
    catch {
        // Fail open: a bad payload must never break a Codex turn.
        return [];
    }
}
