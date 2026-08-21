// statusline-stdin — the Claude Code payload the host pipes into the statusline.
//
// Claude Code invokes its `statusLine.command` once per render and writes a JSON
// document on the child's stdin: the model, the workspace directory, the context
// window, and (for Pro/Max, after the first API response) the rolling rate-limit
// windows. That document is the ONLY source of the bedrock's model, context and
// usage blocks — ADR 0141 §1 — so a producer that ignores stdin renders half a
// line, which is exactly the defect this module exists to close.
//
// **Absent input is the normal case, never an error.** The same binary is run by
// hand from a terminal, by a hook with no payload, and by a host that writes
// malformed JSON. Every one of those yields `null` and the caller renders the
// facts it can still reach. Two failure modes are specifically refused:
//
//   - **A hang.** A statusline that blocks on a stdin nobody will close freezes
//     the operator's prompt. The read carries a hard deadline and returns what
//     arrived; it is a bounded read with a stated escalation, not a poll loop.
//   - **An unbounded buffer.** The payload is a few hundred bytes; a caller that
//     redirected a log file into it must cost a truncation, not the heap.
//
// The parse is PURE and total: every field is optional, every type is checked,
// and an unparseable document is `null` rather than a partially-trusted object.

import type { ClaudeInput } from "./statusline-bedrock.js";

/**
 * The read deadline. Claude Code writes the payload immediately and closes, so
 * 150ms is generous; past it the operator gets the tail rather than a stall.
 */
export const STATUSLINE_STDIN_DEADLINE_MS = 150;

/** Most stdin bytes retained. The payload is a few hundred; the rest is a mistake. */
export const STATUSLINE_STDIN_MAX_BYTES = 64 * 1024;

/** What the host payload tells the bedrock. */
export interface StatuslineStdinPayload {
  /** The model / context / usage facts, ready for the bedrock render. */
  readonly claude: ClaudeInput;
  /** `.workspace.current_dir` (or `.cwd`) — the directory the session is in. */
  readonly cwd?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(source: Record<string, unknown> | null, key: string): string | undefined {
  const value = source?.[key];
  return typeof value === "string" && value !== "" ? value : undefined;
}

function numberAt(source: Record<string, unknown> | null, key: string): number | undefined {
  const value = source?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Parse one Claude Code statusline payload. Returns `null` when the text is not
 * a JSON object — the caller's cue to render the tail alone. A well-formed
 * object with none of the fields we read yields an EMPTY claude record rather
 * than null, because "the host spoke and had nothing to say" is not the same
 * fact as "nobody spoke".
 */
export function parseStatuslineStdinPayload(text: string): StatuslineStdinPayload | null {
  if (text.trim() === "") return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return null;
  }
  const root = asRecord(decoded);
  if (root === null) return null;

  const claude: {
    model?: string;
    effort?: string;
    contextTokens?: number;
    contextPercent?: number;
    usage5h?: number;
    usage7d?: number;
  } = {};
  const model = stringAt(asRecord(root.model), "display_name");
  if (model !== undefined) claude.model = model;
  const effort = stringAt(asRecord(root.effort), "level");
  if (effort !== undefined) claude.effort = effort;

  const context = asRecord(root.context_window);
  const contextTokens = numberAt(context, "total_input_tokens");
  if (contextTokens !== undefined) claude.contextTokens = contextTokens;
  const contextPercent = numberAt(context, "used_percentage");
  if (contextPercent !== undefined) claude.contextPercent = contextPercent;

  const limits = asRecord(root.rate_limits);
  const usage5h = numberAt(asRecord(limits?.five_hour), "used_percentage");
  if (usage5h !== undefined) claude.usage5h = usage5h;
  const usage7d = numberAt(asRecord(limits?.seven_day), "used_percentage");
  if (usage7d !== undefined) claude.usage7d = usage7d;

  const cwd = stringAt(asRecord(root.workspace), "current_dir") ?? stringAt(root, "cwd");
  return cwd === undefined ? { claude } : { claude, cwd };
}

/** The stream shape the reader needs; `process.stdin` satisfies it. */
export interface StatuslineStdinStream {
  readonly isTTY?: boolean;
  setEncoding(encoding: string): unknown;
  on(event: string, listener: (...args: never[]) => void): unknown;
  removeListener(event: string, listener: (...args: never[]) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  unref?(): unknown;
}

export interface ReadStatuslineStdinOptions {
  readonly stream?: StatuslineStdinStream;
  readonly deadlineMs?: number;
  readonly maxBytes?: number;
}

/**
 * Read the host payload off stdin under a hard deadline, then parse it.
 *
 * A TTY stdin means a human ran the command directly and nothing is coming, so
 * the read is skipped entirely rather than deadlined — the difference between an
 * instant answer and a 150ms pause on every manual invocation. Whatever the
 * outcome, the stream is paused and unref'd on the way out: this command sets
 * `process.exitCode` rather than calling `process.exit`, so a listener left
 * attached would hold the event loop open after the line was already printed.
 */
export async function readStatuslineStdinPayload(
  options: ReadStatuslineStdinOptions = {},
): Promise<StatuslineStdinPayload | null> {
  const stream = options.stream ?? (process.stdin as unknown as StatuslineStdinStream);
  if (stream.isTTY === true) return null;
  const maxBytes = options.maxBytes ?? STATUSLINE_STDIN_MAX_BYTES;
  const deadlineMs = options.deadlineMs ?? STATUSLINE_STDIN_DEADLINE_MS;

  const text = await new Promise<string>((resolve) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => finish(), deadlineMs);
    const onData = (chunk: string): void => {
      buffer += chunk;
      if (buffer.length >= maxBytes) {
        buffer = buffer.slice(0, maxBytes);
        finish();
      }
    };
    const onEnd = (): void => finish();
    const onError = (): void => finish();
    function finish(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeListener("data", onData as never);
      stream.removeListener("end", onEnd as never);
      stream.removeListener("error", onError as never);
      stream.pause();
      stream.unref?.();
      resolve(buffer);
    }
    try {
      stream.setEncoding("utf8");
      stream.on("data", onData as never);
      stream.on("end", onEnd as never);
      stream.on("error", onError as never);
      stream.resume();
    } catch {
      finish();
    }
  });

  return parseStatuslineStdinPayload(text);
}
