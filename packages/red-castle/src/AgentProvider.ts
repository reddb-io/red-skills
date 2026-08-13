import { mkdir, readFile, rm, writeFile, access } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { tmpdir } from "node:os";
import {
  claudeHostSessionPath,
  claudeSandboxSessionPath,
  claudeSubagentsDirOnHost,
  encodePiSessionDir,
  findClaudeSessionOnHost,
  findCodexSessionOnHost,
  findPiSessionOnHost,
  listClaudeSubagentSessionsInDir,
  locateClaudeSandboxSession,
  locateCodexHostSession,
  locateCodexSandboxSession,
  locatePiHostSession,
  locatePiSandboxSession,
  piSessionDirPath,
  transferClaudeSession,
  transferCodexSession,
  transferPiSession,
  type HostSessionLookup,
} from "./SessionStore.js";
import type { BindMountSandboxHandle } from "./SandboxProvider.js";

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export type ParsedStreamEvent =
  | { type: "text"; text: string }
  | { type: "result"; result: string }
  | { type: "tool_call"; name: string; args: string }
  | { type: "session_id"; sessionId: string }
  | { type: "usage"; usage: IterationUsage }
  // Model reasoning/thinking. Each runner surfaces it differently — claude
  // streams discrete `thinking` content blocks (carrying `text`); codex and
  // opencode do NOT stream a discrete reasoning event, only reasoning TOKEN
  // counts (codex: `turn.completed.usage.reasoning_output_tokens`; opencode:
  // `step_finish.part.tokens.reasoning`), so they emit a token-bearing
  // reasoning event. Consumers count events for a "how often is it reasoning"
  // signal and sum `tokens` for "how much". Both fields are optional: a claude
  // thinking block has `text` but no `tokens`; a codex/opencode step has
  // `tokens` but no `text`.
  | { type: "reasoning"; tokens?: number; text?: string };

const shellEscape = (s: string): string => "'" + s.replace(/'/g, "'\\''") + "'";

/**
 * Prepend a system/contract prompt to the user prompt for runners with NO
 * native system-prompt flag (codex, opencode, and the other arg/stdin-prompt
 * providers). The contract goes first, separated by a fence, so the agent reads
 * its operating rules before the task. claude uses `--append-system-prompt`
 * instead and never calls this. A no-op when `systemPrompt` is empty/undefined,
 * so the prompt is byte-for-byte unchanged when no contract is supplied.
 */
const withSystemPrompt = (
  systemPrompt: string | undefined,
  prompt: string,
): string =>
  systemPrompt && systemPrompt.length > 0
    ? `${systemPrompt}\n\n---\n\n${prompt}`
    : prompt;

/** Maps allowlisted tool names to the input field containing the display arg */
const TOOL_ARG_FIELDS: Record<string, string> = {
  Bash: "command",
  WebSearch: "query",
  WebFetch: "url",
  Agent: "description",
};

/**
 * Extract an error message from a parsed JSON error event.
 * Handles { error: "string" }, { error: { message: "string" } },
 * { error: { data: { message: "string" } } }, and { message: "string" }.
 */
const extractErrorMessage = (obj: any): string | undefined => {
  const err = obj.error;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null) {
    if (typeof err.message === "string") return err.message;
    if (typeof err.data?.message === "string") return err.data.message;
  }
  if (typeof obj.message === "string") return obj.message;
  return undefined;
};

/**
 * Map a Claude Code stream-json terminal `result` event to IterationUsage. The
 * result line carries the session's cumulative `usage` (input/output/cache
 * token counts) and `total_cost_usd`. Claude does NOT stream a discrete usage
 * event mid-run the way codex does (`turn.completed`), so this terminal line is
 * the only place its token/cost spend surfaces — without emitting a `usage`
 * event here the consumer's cost group (ADR 0065 in red-skills) stays zero for
 * every claude run.
 */
const parseClaudeResultUsage = (obj: any): IterationUsage | undefined => {
  const u = obj.usage;
  if (typeof u !== "object" || u === null) return undefined;
  if (
    typeof u.input_tokens !== "number" ||
    typeof u.output_tokens !== "number"
  ) {
    return undefined;
  }
  return {
    inputTokens: u.input_tokens,
    cacheCreationInputTokens:
      typeof u.cache_creation_input_tokens === "number"
        ? u.cache_creation_input_tokens
        : 0,
    cacheReadInputTokens:
      typeof u.cache_read_input_tokens === "number"
        ? u.cache_read_input_tokens
        : 0,
    outputTokens: u.output_tokens,
    ...(typeof obj.total_cost_usd === "number"
      ? { costUsd: obj.total_cost_usd }
      : {}),
  };
};

const parseStreamJsonLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    if (obj.type === "assistant" && Array.isArray(obj.message?.content)) {
      const events: ParsedStreamEvent[] = [];
      const texts: string[] = [];
      for (const block of obj.message.content as {
        type: string;
        text?: string;
        thinking?: string;
        name?: string;
        input?: Record<string, unknown>;
      }[]) {
        if (block.type === "text" && typeof block.text === "string") {
          texts.push(block.text);
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string"
        ) {
          // Discrete reasoning block (claude stream-json with extended thinking).
          // Flush any buffered text first so ordering is preserved, then emit a
          // text-bearing reasoning event (no token count — claude folds thinking
          // tokens into output_tokens and does not break them out here).
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({ type: "reasoning", text: block.thinking });
        } else if (
          block.type === "tool_use" &&
          typeof block.name === "string" &&
          block.input !== undefined
        ) {
          const argField = TOOL_ARG_FIELDS[block.name];
          if (argField === undefined) continue; // not allowlisted
          const argValue = block.input[argField];
          if (typeof argValue !== "string") continue; // missing/wrong arg field
          if (texts.length > 0) {
            events.push({ type: "text", text: texts.join("") });
            texts.length = 0;
          }
          events.push({
            type: "tool_call",
            name: block.name,
            args: argValue,
          });
        }
      }
      if (texts.length > 0) {
        events.push({ type: "text", text: texts.join("") });
      }
      return events;
    }
    if (obj.type === "result" && typeof obj.result === "string") {
      const usage = parseClaudeResultUsage(obj);
      return usage
        ? [
            { type: "result", result: obj.result },
            { type: "usage", usage },
          ]
        : [{ type: "result", result: obj.result }];
    }
    if (
      obj.type === "system" &&
      obj.subtype === "init" &&
      typeof obj.session_id === "string"
    ) {
      return [{ type: "session_id", sessionId: obj.session_id }];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options passed to buildPrintCommand and buildInteractiveArgs. */
export interface AgentCommandOptions {
  readonly prompt: string;
  readonly dangerouslySkipPermissions: boolean;
  /**
   * A system/contract prompt to deliver ALONGSIDE the user prompt. Only claude
   * has a per-invocation flag for this (`--append-system-prompt`); codex and
   * opencode have none, so for them the provider prepends this text to the user
   * prompt (see {@link withSystemPrompt}). Callers pass it once and the provider
   * picks the right delivery — the substrate owns "how", the caller owns "what".
   */
  readonly systemPrompt?: string;
  /** When set, the agent should resume the given session ID instead of starting fresh. */
  readonly resumeSession?: string;
  /**
   * When true alongside `resumeSession`, the agent should fork the session
   * instead of mutating it — Claude's `--fork-session`, Codex's
   * `codex exec fork`. The parent session JSONL is left intact and the agent
   * writes a new session under a fresh id.
   */
  readonly forkSession?: boolean;
}

/** Return type of buildPrintCommand — command string plus optional stdin content.
 *  When `stdin` is set, the sandbox pipes it to the child process's stdin
 *  instead of inlining the prompt in argv, avoiding the Linux 128 KB per-arg limit. */
export interface PrintCommand {
  readonly command: string;
  readonly stdin?: string;
}

/** Per-iteration token usage snapshot extracted from the agent session. */
export interface IterationUsage {
  readonly inputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly outputTokens: number;
  /** Reasoning/thinking output tokens for the turn, when the runner breaks them
   * out (codex `reasoning_output_tokens`, opencode `tokens.reasoning`). Absent
   * when the runner folds reasoning into `outputTokens` (claude). */
  readonly reasoningTokens?: number;
  /** Turn cost in USD, when the runner reports it directly. Absent otherwise —
   * consumers that need a cost without this field derive it from a price table. */
  readonly costUsd?: number;
}

export interface AgentSessionStorage {
  /** Transfer a session JSONL from the sandbox into the host store. */
  captureToHost(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: BindMountSandboxHandle;
  }): Promise<void>;
  /** Transfer a session JSONL from the host store into the sandbox. */
  resumeIntoSandbox(args: {
    hostCwd: string;
    sandboxCwd: string;
    sessionId: string;
    handle: BindMountSandboxHandle;
  }): Promise<void>;
  /** Read a captured session JSONL from the host store. Returns undefined when absent. */
  readHostSession(cwd: string, sessionId: string): Promise<string | undefined>;
  /** Whether a session with the given id exists in the host store keyed on cwd. */
  existsOnHost(cwd: string, sessionId: string): Promise<boolean>;
  /** Absolute host path where a session would be stored (for not-found error messages). */
  hostSessionFilePath(cwd: string, sessionId: string): string | undefined;
  /**
   * Locate a session on the host by its unique id, independent of cwd encoding.
   * Used by the no-sandbox resume precheck, where the agent runs on the host and
   * writes the session in place under a cwd-derived directory Sandcastle cannot
   * reliably reconstruct. Returns the located path (or `undefined`) plus the
   * directory that was searched (for not-found errors).
   */
  findByIdOnHost(sessionId: string): Promise<HostSessionLookup>;
}

export interface AgentProvider {
  readonly name: string;
  /** Environment variables injected by this agent provider. Merged at launch time with env resolver and sandbox provider env. */
  readonly env: Record<string, string>;
  /** When true, session capture is enabled for this provider. Default: true for Claude Code, false for others. */
  readonly captureSessions: boolean;
  /** Provider-owned storage and transfer behavior for resumable agent sessions. */
  readonly sessionStorage?: AgentSessionStorage;
  buildPrintCommand(options: AgentCommandOptions): PrintCommand;
  buildInteractiveArgs?(options: AgentCommandOptions): string[];
  parseStreamLine(line: string): ParsedStreamEvent[];
  /** Parse token usage from the captured session JSONL content. Only implemented by Claude Code. */
  parseSessionUsage?(content: string): IterationUsage | undefined;
}

export const DEFAULT_MODEL = "claude-opus-4-8";

// ---------------------------------------------------------------------------
// Session storage helpers — file I/O lives here so callers (Orchestrator,
// resumePrecheck) work against the high-level AgentSessionStorage interface
// and tests can exercise transferClaudeSession / transferCodexSession as
// pure string functions.
// ---------------------------------------------------------------------------

const readSandboxFile = async (
  handle: Pick<BindMountSandboxHandle, "copyFileOut">,
  sandboxPath: string,
  tag: string,
): Promise<string> => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  await handle.copyFileOut(sandboxPath, tmpPath);
  try {
    return await readFile(tmpPath, "utf-8");
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
};

const writeSandboxFile = async (
  handle: Pick<BindMountSandboxHandle, "copyFileIn" | "exec">,
  sandboxPath: string,
  content: string,
  tag: string,
): Promise<void> => {
  const tmpPath = join(
    tmpdir(),
    `sandcastle-${tag}-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  await writeFile(tmpPath, content);
  try {
    await handle.exec(`mkdir -p ${JSON.stringify(posix.dirname(sandboxPath))}`);
    await handle.copyFileIn(tmpPath, sandboxPath);
  } finally {
    await rm(tmpPath, { force: true }).catch(() => {});
  }
};

/**
 * Read a Claude JSONL out of the sandbox, rewrite its `cwd` fields from
 * `fromCwd` → `toCwd`, and write the result to `destPath` on the host. Used
 * by `captureToHost` for both the main session file and each subagent /
 * workflow transcript — the read→rewrite→ensure-dir→write sequence is
 * identical, only the source/dest paths differ.
 */
const copyClaudeSessionFile = async ({
  handle,
  sourcePath,
  fromCwd,
  toCwd,
  destPath,
  tag,
}: {
  handle: Pick<BindMountSandboxHandle, "copyFileOut">;
  sourcePath: string;
  fromCwd: string;
  toCwd: string;
  destPath: string;
  tag: string;
}): Promise<void> => {
  const jsonl = await readSandboxFile(handle, sourcePath, tag);
  const rewritten = transferClaudeSession(jsonl, fromCwd, toCwd);
  await mkdir(dirname(destPath), { recursive: true });
  await writeFile(destPath, rewritten);
};

const makeClaudeSessionStorage = (
  options?: ClaudeCodeOptions,
): AgentSessionStorage => {
  const hostProjectsDir = options?.sessionStorage?.hostProjectsDir;
  const sandboxProjectsDir =
    options?.sessionStorage?.sandboxProjectsDir ??
    "/home/agent/.claude/projects";

  return {
    hostSessionFilePath: (cwd, id) =>
      claudeHostSessionPath(cwd, id, hostProjectsDir),
    existsOnHost: (cwd, id) =>
      fileExists(claudeHostSessionPath(cwd, id, hostProjectsDir)),
    readHostSession: async (cwd, id) => {
      const path = claudeHostSessionPath(cwd, id, hostProjectsDir);
      if (!(await fileExists(path))) return undefined;
      return readFile(path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      // Locate the session by id instead of reconstructing
      // `<projectsDir>/<encoded-cwd>/` via encodeProjectPath. Claude Code
      // derives that directory from its own cwd-encoding (which collapses more
      // than path separators, e.g. `.` → `-`), so reconstructing it on the host
      // drifts whenever Claude's encoding changes — the cause of "session not
      // found in container" capture failures. The id is globally unique.
      const mainSandboxPath = await locateClaudeSandboxSession(
        sessionId,
        handle,
        sandboxProjectsDir,
      );

      // Main session: failure is fatal — the user expects their session.
      await copyClaudeSessionFile({
        handle,
        sourcePath: mainSandboxPath,
        fromCwd: sandboxCwd,
        toCwd: hostCwd,
        destPath: claudeHostSessionPath(hostCwd, sessionId, hostProjectsDir),
        tag: "claude-cap",
      });

      // Subagent / workflow transcripts: best-effort. A missing `subagents/`
      // dir is the normal case (no Agent-tool / Workflow usage this run);
      // an individual subagent failing to copy must not abort siblings or
      // the (already-successful) main capture. Derive the directory from the
      // located main-session path so it tracks Claude's real encoding too.
      const subagentSandboxPaths = await listClaudeSubagentSessionsInDir(
        posix.join(posix.dirname(mainSandboxPath), sessionId, "subagents"),
        handle,
      );
      const hostSubagentsDir = claudeSubagentsDirOnHost(
        hostCwd,
        sessionId,
        hostProjectsDir,
      );
      for (const sandboxSubagentPath of subagentSandboxPaths) {
        try {
          await copyClaudeSessionFile({
            handle,
            sourcePath: sandboxSubagentPath,
            fromCwd: sandboxCwd,
            toCwd: hostCwd,
            destPath: join(
              hostSubagentsDir,
              posix.basename(sandboxSubagentPath),
            ),
            tag: "claude-sub",
          });
        } catch (err) {
          console.error(
            `sandcastle: failed to capture Claude subagent transcript ${sandboxSubagentPath}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const hostPath = claudeHostSessionPath(
        hostCwd,
        sessionId,
        hostProjectsDir,
      );
      const jsonl = await readFile(hostPath, "utf-8");
      const rewritten = transferClaudeSession(jsonl, hostCwd, sandboxCwd);
      const sandboxPath = claudeSandboxSessionPath(
        sandboxCwd,
        sessionId,
        sandboxProjectsDir,
      );
      await writeSandboxFile(handle, sandboxPath, rewritten, "claude-res");
    },
    findByIdOnHost: (id) => findClaudeSessionOnHost(id, hostProjectsDir),
  };
};

const makeCodexSessionStorage = (
  options?: CodexOptions,
): AgentSessionStorage => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir =
    options?.sessionStorage?.sandboxSessionsDir ??
    posix.join("/home/agent", ".codex", "sessions");

  // Codex sessions live at YYYY/MM/DD/rollout-*-<id>.jsonl — the path is not
  // derivable from (cwd, id) alone, so we cache the path written by
  // captureToHost for hostSessionFilePath to surface on the IterationResult.
  const capturedPaths = new Map<string, string>();

  return {
    hostSessionFilePath: (_cwd, id) => capturedPaths.get(id),
    existsOnHost: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      return found.path !== undefined;
    },
    readHostSession: async (_cwd, id) => {
      const found = await findCodexSessionOnHost(id, hostSessionsDir);
      if (!found.path) return undefined;
      return readFile(found.path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir,
      );
      const jsonl = await readSandboxFile(handle, located.path, "codex-cap");
      const rewritten = transferCodexSession(jsonl, sandboxCwd, hostCwd);
      const root =
        hostSessionsDir ?? join(process.env.HOME ?? "~", ".codex", "sessions");
      const target = join(root, located.relativePath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten);
      capturedPaths.set(sessionId, target);
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locateCodexHostSession(sessionId, hostSessionsDir);
      const jsonl = await readFile(located.path, "utf-8");
      const rewritten = transferCodexSession(jsonl, hostCwd, sandboxCwd);
      const target = posix.join(sandboxSessionsDir, located.relativePath);
      await writeSandboxFile(handle, target, rewritten, "codex-res");
    },
    findByIdOnHost: (id) => findCodexSessionOnHost(id, hostSessionsDir),
  };
};

// ---------------------------------------------------------------------------
// Pi agent provider
// ---------------------------------------------------------------------------

const makePiSessionStorage = (options?: PiOptions): AgentSessionStorage => {
  const hostSessionsDir = options?.sessionStorage?.hostSessionsDir;
  const sandboxSessionsDir =
    options?.sessionStorage?.sandboxSessionsDir ??
    posix.join("/home/agent", ".pi", "agent", "sessions");

  return {
    hostSessionFilePath: (cwd, _id) => piSessionDirPath(cwd, hostSessionsDir),
    existsOnHost: async (_cwd, id) => {
      const found = await findPiSessionOnHost(id, hostSessionsDir);
      return found.path !== undefined;
    },
    readHostSession: async (_cwd, id) => {
      const found = await findPiSessionOnHost(id, hostSessionsDir);
      if (!found.path) return undefined;
      return readFile(found.path, "utf-8");
    },
    captureToHost: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locatePiSandboxSession(
        sessionId,
        handle,
        sandboxSessionsDir,
      );
      const jsonl = await readSandboxFile(handle, located.path, "pi-cap");
      const rewritten = transferPiSession(jsonl, sandboxCwd, hostCwd);
      // Pi resolves `--session <id>` against the *current project's* encoded
      // directory first; a transferred file in any other directory hits the
      // "fork session?" prompt, which hangs in print/json mode. So we land
      // the file in `--<enc-host-cwd>--/<filename>`, not the sandbox's
      // encoded dir.
      const filename = posix.basename(located.path);
      const target = join(piSessionDirPath(hostCwd, hostSessionsDir), filename);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, rewritten);
    },
    resumeIntoSandbox: async ({ hostCwd, sandboxCwd, sessionId, handle }) => {
      const located = await locatePiHostSession(sessionId, hostSessionsDir);
      const jsonl = await readFile(located.path, "utf-8");
      const rewritten = transferPiSession(jsonl, hostCwd, sandboxCwd);
      const filename = located.relativePath.split(/[\\/]/).pop()!;
      const target = posix.join(
        sandboxSessionsDir,
        encodePiSessionDir(sandboxCwd),
        filename,
      );
      await writeSandboxFile(handle, target, rewritten, "pi-res");
    },
    findByIdOnHost: (id) => findPiSessionOnHost(id, hostSessionsDir),
  };
};

const parsePiStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    // The first line of pi's --mode json stdout stream is a `session` header
    // carrying the UUID; subsequent stream entries (model_change,
    // thinking_level_change, message, ...) do not. Verified against
    // @mariozechner/pi-coding-agent 0.73.1.
    if (obj.type === "session" && typeof obj.id === "string") {
      return [{ type: "session_id", sessionId: obj.id }];
    }
    if (obj.type === "message_update" && obj.assistantMessageEvent) {
      const evt = obj.assistantMessageEvent as {
        type: string;
        delta?: string;
      };
      if (evt.type === "text_delta" && typeof evt.delta === "string") {
        return [{ type: "text", text: evt.delta }];
      }
      return [];
    }
    if (obj.type === "tool_execution_start") {
      const toolName = obj.toolName;
      if (typeof toolName !== "string") return [];
      const argField = TOOL_ARG_FIELDS[toolName];
      if (argField === undefined) return [];
      const args = obj.args as Record<string, unknown> | undefined;
      if (!args) return [];
      const argValue = args[argField];
      if (typeof argValue !== "string") return [];
      return [{ type: "tool_call", name: toolName, args: argValue }];
    }
    // Pi emits agent_error / error events on stdout (not stderr) for auth
    // failures, rate limits, and API errors. Capture them as result events so
    // the Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "agent_error" || obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }
    if (obj.type === "agent_end" && Array.isArray(obj.messages)) {
      const messages = obj.messages as {
        role: string;
        content: { type: string; text?: string }[];
      }[];
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg?.role === "assistant") {
          const texts: string[] = [];
          for (const block of msg.content) {
            if (block.type === "text" && typeof block.text === "string") {
              texts.push(block.text);
            }
          }
          if (texts.length > 0) {
            return [{ type: "result", result: texts.join("") }];
          }
          break;
        }
      }
      return [];
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the pi agent provider. */
export interface PiOptions {
  /** Reasoning effort level. Maps to the CLI's --thinking flag. */
  readonly thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override pi session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
}

export const pi = (
  model: string,
  options?: PiOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "pi",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makePiSessionStorage(options),

  buildPrintCommand({
    prompt,
    resumeSession,
  }: AgentCommandOptions): PrintCommand {
    const thinkingFlag = options?.thinking
      ? ` --thinking ${options.thinking}`
      : "";
    // Pi persists print-mode sessions by default; `--session <id>` resolves an
    // existing session and appends to it in place. Drop the legacy
    // `--no-session` flag so fresh runs also persist and can be resumed later.
    const sessionFlag = resumeSession
      ? ` --session ${shellEscape(resumeSession)}`
      : "";
    return {
      command: `pi -p --mode json --model ${shellEscape(model)}${thinkingFlag}${sessionFlag}`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["pi", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parsePiStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Codex agent provider
// ---------------------------------------------------------------------------

/**
 * Map a Codex token-usage object to the Claude-shaped IterationUsage.
 *
 * OpenAI/Codex usage is `{ input_tokens, cached_input_tokens, output_tokens }`.
 * `turn.completed.usage` and the newer `token_count.info.last_token_usage`
 * carry the same counters: `input_tokens` is the *total* prompt tokens and
 * `cached_input_tokens` is a subset already included in that total. There is no
 * cache-creation concept. To avoid double-counting cached tokens in the
 * context-window display (which sums input + cacheCreation + cacheRead), the
 * cached portion maps to
 * `cacheReadInputTokens` and the remainder to `inputTokens`.
 */
const parseCodexUsage = (usage: unknown): IterationUsage | undefined => {
  if (typeof usage !== "object" || usage === null) return undefined;
  const u = usage as Record<string, unknown>;
  if (
    typeof u.input_tokens !== "number" ||
    typeof u.cached_input_tokens !== "number" ||
    typeof u.output_tokens !== "number"
  ) {
    return undefined;
  }
  const reasoning =
    typeof u.reasoning_output_tokens === "number"
      ? u.reasoning_output_tokens
      : undefined;
  return {
    inputTokens: u.input_tokens - u.cached_input_tokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: u.cached_input_tokens,
    outputTokens: u.output_tokens,
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
  };
};

const codexUsageEvents = (usageInput: unknown): ParsedStreamEvent[] => {
  const usage = parseCodexUsage(usageInput);
  const events: ParsedStreamEvent[] = usage ? [{ type: "usage", usage }] : [];
  if (usage?.reasoningTokens !== undefined && usage.reasoningTokens > 0) {
    events.push({ type: "reasoning", tokens: usage.reasoningTokens });
  }
  return events;
};

const parseCodexStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);

    if (obj.type === "thread.started" && typeof obj.thread_id === "string") {
      return [{ type: "session_id", sessionId: obj.thread_id }];
    }

    // item.completed with agent_message → text + result
    if (
      obj.type === "item.completed" &&
      obj.item?.type === "agent_message" &&
      typeof obj.item.text === "string"
    ) {
      const text = obj.item.text;
      return [
        { type: "text", text },
        { type: "result", result: text },
      ];
    }

    // item.started with command_execution → tool call
    if (
      obj.type === "item.started" &&
      obj.item?.type === "command_execution" &&
      typeof obj.item.command === "string"
    ) {
      return [{ type: "tool_call", name: "Bash", args: obj.item.command }];
    }

    // Codex emits error events on stdout (not stderr) for auth failures,
    // rate limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // Current Codex CLI JSONL reports token usage as an `event_msg` wrapper
    // around `payload.type = "token_count"`. Use `last_token_usage`, not the
    // cumulative `total_token_usage`, because AFK's activity meter sums events.
    if (obj.type === "event_msg" && obj.payload?.type === "token_count") {
      return codexUsageEvents(obj.payload.info?.last_token_usage);
    }

    // Older Codex JSONL carries token usage on turn.completed. Codex does NOT
    // stream a discrete reasoning item — reasoning surfaces only as the per-turn
    // `reasoning_output_tokens` count, so emit a token-bearing reasoning event
    // (alongside the usage event) when the turn did any reasoning.
    if (obj.type === "turn.completed") {
      return codexUsageEvents(obj.usage);
    }
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the codex agent provider. */
export interface CodexOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Codex session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostSessionsDir?: string;
    readonly sandboxSessionsDir?: string;
  };
  /**
   * Maps to Codex's `approvals_reviewer` config key (set via
   * `-c approvals_reviewer="<value>"`). `"auto_review"` swaps the bypass for
   * interactive approvals and Codex's permissive sandbox; Sandcastle retains
   * the filesystem boundary while the reviewer owns per-action approval.
   */
  readonly approvalsReviewer?: "user" | "auto_review";
  /** Per-invocation `-c key=value` overrides (for example plugin/skill gates). */
  readonly configOverrides?: readonly string[];
  readonly ignoreUserConfig?: boolean;
  readonly ignoreRules?: boolean;
}

export const codex = (
  model: string,
  options?: CodexOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "codex",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makeCodexSessionStorage(options),

  buildPrintCommand({
    prompt,
    resumeSession,
    forkSession,
    systemPrompt,
  }: AgentCommandOptions): PrintCommand {
    const effortFlag = options?.effort
      ? ` -c ${shellEscape(`model_reasoning_effort="${options.effort}"`)}`
      : "";
    // auto_review only fires on interactive approvals, so the bypass flag is
    // dropped in favour of `-a on-request`. `-s danger-full-access` disables
    // Codex's own filesystem sandbox — Sandcastle owns that boundary, and
    // here the reviewer agent owns the per-action approval boundary.
    const approvalsFlags =
      options?.approvalsReviewer === "auto_review"
        ? ` -a on-request -s danger-full-access -c ${shellEscape(`approvals_reviewer="auto_review"`)}`
        : " --dangerously-bypass-approvals-and-sandbox";
    const configFlags = `${options?.ignoreUserConfig ? " --ignore-user-config" : ""}${
      options?.ignoreRules ? " --ignore-rules" : ""
    }${(options?.configOverrides ?? []).map((override) => ` -c ${shellEscape(override)}`).join("")}`;
    // Codex distinguishes fork from resume at the verb level — `codex exec
    // fork <id>` leaves the parent rollout intact; `codex exec resume <id>`
    // appends to it. See ADR 0018.
    let base: string;
    if (resumeSession && forkSession) {
      base = `codex exec fork ${shellEscape(resumeSession)}`;
    } else if (resumeSession) {
      base = `codex exec resume ${shellEscape(resumeSession)}`;
    } else {
      base = "codex exec";
    }
    const stdinArg = resumeSession ? " -" : "";
    return {
      command: `${base} --json${configFlags}${approvalsFlags} -m ${shellEscape(model)}${effortFlag}${stdinArg}`,
      // codex has no system-prompt flag — prepend the contract to the stdin prompt.
      stdin: withSystemPrompt(systemPrompt, prompt),
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["codex", "--model", model];
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseCodexStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// OpenCode agent provider
// ---------------------------------------------------------------------------

/** Maps OpenCode tool names to the input field containing the friendly display
 *  arg. Tools not listed here are still surfaced, falling back to a JSON dump of
 *  the whole input. The tool name is surfaced as-is (OpenCode's lowercase names). */
const OPENCODE_TOOL_ARG_FIELDS: Record<string, string> = {
  bash: "command",
  webfetch: "url",
  task: "description",
};

const parseOpenCodeStreamLine = (line: string): ParsedStreamEvent[] => {
  if (!line.startsWith("{")) return [];
  try {
    const obj = JSON.parse(line);
    const part = obj.part;

    // step_start carries the session ID for the run.
    if (obj.type === "step_start" && typeof obj.sessionID === "string") {
      return [{ type: "session_id", sessionId: obj.sessionID }];
    }

    // text event → assistant text. Emit both text (for streaming display) and
    // result (final message; the last result wins in the Orchestrator).
    if (
      obj.type === "text" &&
      part?.type === "text" &&
      typeof part.text === "string"
    ) {
      return [
        { type: "text", text: part.text },
        { type: "result", result: part.text },
      ];
    }

    // tool_use event → tool call. Tool name is in part.tool, args in
    // part.state.input. Gate on the completed status so intermediate
    // pending/running states don't surface duplicate tool calls.
    if (obj.type === "tool_use" && part?.type === "tool") {
      if (typeof part.tool !== "string") return [];
      const state = part.state as
        | { status?: string; input?: Record<string, unknown> }
        | undefined;
      if (state?.status !== "completed") return [];
      const input = state.input;
      if (!input) return [];
      const argField = OPENCODE_TOOL_ARG_FIELDS[part.tool];
      const argValue = argField !== undefined ? input[argField] : undefined;
      const args =
        typeof argValue === "string" ? argValue : JSON.stringify(input);
      return [{ type: "tool_call", name: part.tool, args }];
    }

    // OpenCode emits error events on stdout (not stderr) for auth failures,
    // rate limits, and API errors. Capture them as result events so the
    // Orchestrator's stderr-empty fallback can surface them to the user.
    if (obj.type === "error") {
      const msg = extractErrorMessage(obj);
      return msg ? [{ type: "result", result: msg }] : [];
    }

    // step_finish carries per-step token usage including reasoning. opencode
    // does NOT stream a discrete reasoning part, so this token count is the only
    // reasoning signal — emit a token-bearing reasoning event when the step did
    // any reasoning, AND a full usage event so cost/tokens flow to consumers.
    if (obj.type === "step_finish" && part?.type === "step-finish") {
      const tok = part.tokens as
        | {
            input?: unknown;
            output?: unknown;
            reasoning?: unknown;
            cache?: { read?: unknown; write?: unknown };
          }
        | undefined;
      const num = (v: unknown): number => (typeof v === "number" ? v : 0);
      const rtok = tok?.reasoning;
      const events: ParsedStreamEvent[] = [];
      if (typeof rtok === "number" && rtok > 0) {
        events.push({ type: "reasoning", tokens: rtok });
      }
      // Emit usage when any token field is present (a step with no token data
      // yields nothing beyond the optional reasoning event above).
      if (
        tok &&
        (typeof tok.input === "number" || typeof tok.output === "number")
      ) {
        events.push({
          type: "usage",
          usage: {
            inputTokens: num(tok.input),
            cacheCreationInputTokens: num(tok.cache?.write),
            cacheReadInputTokens: num(tok.cache?.read),
            outputTokens: num(tok.output),
            ...(typeof rtok === "number" ? { reasoningTokens: rtok } : {}),
          },
        });
      }
      return events;
    }

    // tool output, etc. → skip
  } catch {
    // Not valid JSON — skip
  }
  return [];
};

/** Options for the opencode agent provider. */
export interface OpenCodeOptions {
  /** Provider-specific reasoning effort variant (e.g. "high", "max", "low", "minimal"). */
  readonly variant?: string;
  /**
   * Named OpenCode agent/mode to run, mapped to OpenCode's own `--agent` flag
   * (e.g. "build", "plan"). This is distinct from Sandcastle's `--agent`
   * provider selector — it chooses an agent *inside* OpenCode.
   */
  readonly agent?: string;
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
}

export const opencode = (
  model: string,
  options?: OpenCodeOptions,
): AgentProvider => ({
  name: "opencode",
  env: options?.env ?? {},
  captureSessions: false,

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
    systemPrompt,
  }: AgentCommandOptions): PrintCommand {
    const variantFlag = options?.variant
      ? ` --variant ${shellEscape(options.variant)}`
      : "";
    const agentFlag = options?.agent
      ? ` --agent ${shellEscape(options.agent)}`
      : "";
    const permissionsFlag = dangerouslySkipPermissions
      ? " --dangerously-skip-permissions"
      : "";
    // opencode has no per-run system-prompt flag (system prompt lives in the
    // --agent definition) — prepend the contract to the prompt arg.
    return {
      command: `opencode run --format json --model ${shellEscape(model)}${variantFlag}${agentFlag}${permissionsFlag} ${shellEscape(withSystemPrompt(systemPrompt, prompt))}`,
    };
  },

  buildInteractiveArgs({ prompt }: AgentCommandOptions): string[] {
    const args = ["opencode", "--model", model];
    if (options?.agent) args.push("--agent", options.agent);
    // The TUI's seed-prompt flag is `--prompt` (long form only); `-p` is the
    // `opencode run`/`attach` basic-auth password flag, not a prompt seed.
    // Pre-fills the textbox but does not auto-submit (sst/opencode#3937).
    if (prompt) args.push("--prompt", prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseOpenCodeStreamLine(line);
  },
});

// ---------------------------------------------------------------------------
// Claude Code agent provider
// ---------------------------------------------------------------------------

export interface ClaudeCodeOptions {
  readonly effort?: "low" | "medium" | "high" | "xhigh" | "max";
  /** Environment variables injected by this agent provider. */
  readonly env?: Record<string, string>;
  /** When false, session capture is disabled. Default: true. */
  readonly captureSessions?: boolean;
  /** Override Claude session directories for tests or non-standard installs. */
  readonly sessionStorage?: {
    readonly hostProjectsDir?: string;
    readonly sandboxProjectsDir?: string;
  };
  /**
   * Maps directly to Claude's `--permission-mode` flag. When set, replaces the
   * default `--dangerously-skip-permissions` Sandcastle passes on AFK runs —
   * the two flags are mutually exclusive on Claude's CLI. Use `"auto"` for
   * AI-mediated per-tool approve/deny on unsandboxed host runs.
   */
  readonly permissionMode?:
    | "default"
    | "acceptEdits"
    | "plan"
    | "auto"
    | "dontAsk"
    | "bypassPermissions";
  /** Claude settings layers allowed for this invocation. */
  readonly settingSources?: readonly ("user" | "project" | "local")[];
  /** Explicit plugin directories loaded for this invocation only. */
  readonly pluginDirs?: readonly string[];
}

export const claudeCode = (
  model: string,
  options?: ClaudeCodeOptions,
): AgentProvider & { readonly sessionStorage: AgentSessionStorage } => ({
  name: "claude-code",
  env: options?.env ?? {},
  captureSessions: options?.captureSessions ?? true,
  sessionStorage: makeClaudeSessionStorage(options),

  buildPrintCommand({
    prompt,
    dangerouslySkipPermissions,
    resumeSession,
    forkSession,
    systemPrompt,
  }: AgentCommandOptions): PrintCommand {
    // permissionMode and --dangerously-skip-permissions are mutually exclusive
    // on Claude's CLI; an explicit mode on the provider takes precedence over
    // Sandcastle's default bypass.
    const permissionFlag = options?.permissionMode
      ? ` --permission-mode ${options.permissionMode}`
      : dangerouslySkipPermissions
        ? " --dangerously-skip-permissions"
        : "";
    const effortFlag = options?.effort ? ` --effort ${options.effort}` : "";
    const settingSourcesFlag = options?.settingSources?.length
      ? ` --setting-sources ${shellEscape(options.settingSources.join(","))}`
      : "";
    const pluginDirFlags = (options?.pluginDirs ?? [])
      .map((dir) => ` --plugin-dir ${shellEscape(dir)}`)
      .join("");
    // claude is the only runner with a per-invocation system-prompt flag — use
    // it so the contract is a real appended system prompt (kept out of the user
    // turn, cached separately) rather than prefixed into the prompt body.
    const systemFlag = systemPrompt
      ? ` --append-system-prompt ${shellEscape(systemPrompt)}`
      : "";
    const resumeFlag = resumeSession
      ? ` --resume ${shellEscape(resumeSession)}`
      : "";
    // --fork-session is meaningful only alongside --resume; it tells Claude
    // to write the continuation as a new session rather than mutating the
    // resumed one. See ADR 0018.
    const forkFlag = resumeSession && forkSession ? " --fork-session" : "";
    return {
      command: `claude --print --verbose${permissionFlag} --output-format stream-json --model ${shellEscape(model)}${effortFlag}${settingSourcesFlag}${pluginDirFlags}${systemFlag}${resumeFlag}${forkFlag} -p -`,
      stdin: prompt,
    };
  },

  buildInteractiveArgs({
    prompt,
    dangerouslySkipPermissions,
  }: AgentCommandOptions): string[] {
    const args = ["claude"];
    if (options?.permissionMode) {
      args.push("--permission-mode", options.permissionMode);
    } else if (dangerouslySkipPermissions) {
      args.push("--dangerously-skip-permissions");
    }
    args.push("--model", model);
    if (options?.effort) args.push("--effort", options.effort);
    if (prompt) args.push(prompt);
    return args;
  },

  parseStreamLine(line: string): ParsedStreamEvent[] {
    return parseStreamJsonLine(line);
  },

  parseSessionUsage(content: string): IterationUsage | undefined {
    const lines = content.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.startsWith("{")) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === "assistant" && obj.message?.usage) {
          const u = obj.message.usage;
          if (
            typeof u.input_tokens === "number" &&
            typeof u.cache_creation_input_tokens === "number" &&
            typeof u.cache_read_input_tokens === "number" &&
            typeof u.output_tokens === "number"
          ) {
            return {
              inputTokens: u.input_tokens,
              cacheCreationInputTokens: u.cache_creation_input_tokens,
              cacheReadInputTokens: u.cache_read_input_tokens,
              outputTokens: u.output_tokens,
            };
          }
        }
      } catch {
        // Not valid JSON — skip
      }
    }
    return undefined;
  },
});
