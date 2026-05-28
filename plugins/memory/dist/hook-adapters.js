import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
function str(payload, key) {
    const v = payload[key];
    return typeof v === "string" && v.trim() ? v : undefined;
}
/** Read a transcript file into raw text for the extractor; absent/unreadable
 *  → undefined (the flush handler then no-ops rather than throwing). */
async function readTranscript(path) {
    if (!path)
        return undefined;
    try {
        return await readFile(path, "utf8");
    }
    catch {
        return undefined;
    }
}
function absUnder(cwd, file) {
    if (isAbsolute(file))
        return file;
    return resolve(cwd ?? process.cwd(), file);
}
/**
 * Pull edited file paths out of a tool-call payload, covering both runners'
 * shapes: Claude's `Edit`/`Write` put a single `file_path` in `tool_input`;
 * Codex's `apply_patch` carries one or more paths (`paths`, `changes`, or a
 * single `file_path`). Anything unrecognized yields no files (the hook no-ops).
 */
function changedFilesFrom(payload, cwd) {
    const input = (payload.tool_input ?? payload.toolInput ?? {});
    const files = [];
    const single = str(input, "file_path") ?? str(input, "filePath");
    if (single)
        files.push(single);
    const list = input.paths ?? input.files;
    if (Array.isArray(list)) {
        for (const p of list)
            if (typeof p === "string" && p.trim())
                files.push(p);
    }
    // Codex apply_patch may describe edits as a map keyed by path.
    const changes = input.changes;
    if (changes && typeof changes === "object" && !Array.isArray(changes)) {
        for (const p of Object.keys(changes))
            if (p.trim())
                files.push(p);
    }
    return [...new Set(files)].map((f) => absUnder(cwd, f));
}
/**
 * Claude Code → {@link NormalizedInput}. Claude's payload carries the event
 * name, `session_id`, `transcript_path`, `cwd`, and (on SessionStart) optional
 * `branch`/`goal` focus signals; on `Edit`/`Write` the file is in `tool_input`.
 */
export async function parseClaudeInput(event, payload) {
    const cwd = str(payload, "cwd");
    const transcriptPath = str(payload, "transcript_path");
    return {
        event,
        runner: "claude",
        sessionId: str(payload, "session_id"),
        transcriptPath,
        cwd,
        branch: str(payload, "branch"),
        goal: str(payload, "goal") ?? str(payload, "prompt"),
        changedFiles: event === "PostToolUse" ? changedFilesFrom(payload, cwd) : [],
        transcriptText: event === "Stop" || event === "PreCompact"
            ? await readTranscript(transcriptPath)
            : undefined,
    };
}
/**
 * Codex → {@link NormalizedInput}. Codex's payload is
 * `{session_id, transcript_path, cwd, hook_event_name, model, permission_mode}`
 * (+ `turn_id` on turn events) with no `branch`/`goal`/`turn_count` — so the
 * SessionStart focus is derived from `cwd` downstream. File edits come through
 * the `apply_patch` tool. Codex has no `PreCompact` event, so it is never built
 * here (the manifest does not wire one).
 */
export async function parseCodexInput(event, payload) {
    const cwd = str(payload, "cwd");
    const transcriptPath = str(payload, "transcript_path");
    return {
        event,
        runner: "codex",
        sessionId: str(payload, "session_id"),
        transcriptPath,
        cwd,
        branch: undefined,
        goal: undefined,
        changedFiles: event === "PostToolUse" ? changedFilesFrom(payload, cwd) : [],
        transcriptText: event === "Stop" || event === "PreCompact"
            ? await readTranscript(transcriptPath)
            : undefined,
    };
}
/** Parse a runner's payload into the normalized input. */
export function parseInput(runner, event, payload) {
    return runner === "codex"
        ? parseCodexInput(event, payload)
        : parseClaudeInput(event, payload);
}
/**
 * Render a {@link HookResult} into the runner's stdout JSON. A no-op result is
 * an empty object for both runners — exit 0, nothing injected. Only an
 * injection (SessionStart recall) carries a body; side-effect results
 * (re-index, flush) print nothing.
 */
export function formatOutput(runner, event, result) {
    if (result.noop || !result.inject)
        return "{}";
    if (runner === "codex") {
        // Codex injects via systemMessage (also accepts hookSpecificOutput).
        return JSON.stringify({ systemMessage: result.inject });
    }
    return JSON.stringify({
        hookSpecificOutput: {
            hookEventName: event,
            additionalContext: result.inject,
        },
    });
}
