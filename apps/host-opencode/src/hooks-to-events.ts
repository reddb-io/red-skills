/**
 * hooks-to-events.ts — pure planner for the Claude/Codex hook JSON →
 * opencode plugin TS module mapping (ADR 0077).
 *
 * Reads `plugins/<plugin>/hooks/<host>.hooks.json` and returns a
 * {@link HookPlan} list the emit step turns into
 * `dist/opencode/<plugin>/.opencode/plugin/<event>.ts` modules. Each
 * event class the source registers (`SessionStart`, `PreToolUse`, …)
 * becomes one module — never merged.
 *
 * No `fs` writes happen here. The planner is pure; the emit step is
 * the thin shell that takes the plan and writes files.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** A planned opencode plugin TS module. */
export interface HookPlan {
  /** Event class the source hook registered (e.g. `SessionStart`). */
  sourceEvent: string;
  /** The opencode event key the module subscribes to (`config`,
   *  `tool.execute.before`, …). */
  opencodeEvent: string;
  /** Target path under `dist/opencode/<plugin>/.opencode/plugin/`,
   *  relative to the emit root. */
  target: string;
  /** The TypeScript source code of the module. */
  source: string;
  /** Source hook files that fed this module — useful for diagnostics. */
  sourceFiles: string[];
  /** Warnings: events present in the source the generator does not yet
   *  know how to map. The plan still emits what it can; the warnings
   *  are surfaced to the user (ADR 0077 §5 — warn-and-continue). */
  warnings: string[];
}

/** Map source event class → opencode event key. */
const EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  SessionStart: "config",
  PreToolUse: "tool.execute.before",
  PostToolUse: "tool.execute.after",
  Stop: "session.idle",
  PreCompact: "experimental.session.compacting",
  UserPromptSubmit: "chat.message",
});

const TARGET_BY_EVENT: Readonly<Record<string, string>> = Object.freeze({
  SessionStart: "plugin/session-start.ts",
  PreToolUse: "plugin/pre-tool-use.ts",
  PostToolUse: "plugin/post-tool-use.ts",
  Stop: "plugin/stop.ts",
  PreCompact: "plugin/pre-compact.ts",
  UserPromptSubmit: "plugin/user-prompt-submit.ts",
});

/** All Claude/Codex hook files the generator reads, in priority order. */
const HOOK_FILES = ["codex.hooks.json", "claude.hooks.json"] as const;

interface RawHookGroup {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
}

interface RawHooksFile {
  hooks: Record<string, RawHookGroup[]>;
}

/** Return every `<host>.hooks.json` under `plugins/<plugin>/hooks/`
 *  that exists on disk, in priority order (codex first because it
 *  carries the most environment-specific guards). */
export function listHookFiles(pluginsRoot: string, plugin: string): string[] {
  const hooksRoot = join(pluginsRoot, plugin, "hooks");
  return HOOK_FILES.map((f) => join(hooksRoot, f)).filter((p) => existsSync(p));
}

/** Rewrite `${CLAUDE_PLUGIN_ROOT}` and `${CODEX_PLUGIN_ROOT}` to a
 *  `path.join(directory, "<plugin-root-relative>")` template. The
 *  rewrite is conservative: it only touches the well-known env-var
 *  forms; absolute paths in the source are left alone. */
export function rewritePluginRoot(command: string, plugin: string): string {
  // Replace the env-var with a path.join that the emitted TS module
  // builds from the opencode plugin context `directory`. We emit a
  // JS template that uses the surrounding function's `directory` arg.
  return command
    .replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, `\${__pluginRoot}`)
    .replace(/\$\{CODEX_PLUGIN_ROOT\}/g, `\${__pluginRoot}`)
    .replace(/\brsp-instructions --runner (claude|codex) --hook\b/g, "rsp-instructions --runner opencode --hook");
}

/** The TypeScript template for a single `tool.execute.before` module. */
function toolExecuteBeforeTemplate(input: {
  sourceFiles: string[];
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
}): string {
  // Each hookGroup is a `(matcher, command, sourceFile)` tuple, where the
  // source `command` (a `sh -c` string) is rewritten so that
  // `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}` become
  // `${__pluginRoot}` (resolved from the opencode plugin context).
  // The matcher's glob is translated to an inline `input.tool` check;
  // each group becomes its own `if`.
  //
  // Two hook protocols are supported:
  //
  //   Block-deny: most hooks (branch-lock, command-guard, etc.). The hook
  //   exits 0 to allow or outputs a structured JSON deny + non-zero exit
  //   to block. `__runHook` implements this protocol.
  //
  //   Rsp-rewrite: hooks that invoke `rsp hook claude-pre-exec`. Exit 0 +
  //   non-empty stdout = apply the rewritten command; exit 1 = passthrough
  //   (allow unchanged). The rsp binary owns the capability table; the
  //   generated module contains no allowlist copy. `__runRspRewrite`
  //   implements this protocol (ADR 0095 Decision 7).
  const hasRspHook = input.hookGroups.some((g) =>
    isRspRewriteHook(g.command.replace(/^sh -c\s*'/, "").replace(/'$/, "")),
  );

  const cases = input.hookGroups
    .map((g) => {
      const matcherRe = matcherToRegex(g.matcher);
      // The rewritten command is a `sh -c '…'` string. We embed it as
      // a Bun shell template literal, with the `__pluginRoot`
      // placeholder bound from the opencode plugin context's
      // `directory`. Bun's `$` shell template handles the quoting.
      const inner = g.command.replace(/^sh -c\s*'/, "").replace(/'$/, "");
      if (isRspRewriteHook(inner)) {
        // rsp rewrite/passthrough: exit 0 + stdout → apply rewrite to
        // output.args.command; exit 1 → passthrough (allow unchanged).
        // The per-repo gate (rsp.enabled in .red/config.yaml) is checked
        // inside the rsp binary itself — the generated module delegates.
        return `    if (${matcherRe}.test(input.tool)) {
      const __rewritten = await __runRspRewrite(${JSON.stringify(inner)});
      if (__rewritten !== null && output.args && typeof output.args === "object" && "command" in output.args) {
        output.args = { ...output.args, command: __rewritten };
      }
    }`;
      }
      return `    if (${matcherRe}.test(input.tool)) {
      const __blocked = await __runHook(${JSON.stringify(inner)});
      if (__blocked) return;
    }`;
    })
    .join("\n");

  // `__runRspRewrite` is only emitted when the hook set includes at least
  // one rsp-style hook. Omitting it when unused keeps the generated file
  // free of dead code.
  const rspRewriteHelper = hasRspHook
    ? [
        "      const __runRspRewrite = async (inner: string): Promise<string | null> => {",
        "        const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot, OPENCODE_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
        "        try {",
        "          const writer = proc.stdin.getWriter();",
        "          await writer.write(__encoder.encode(__payload));",
        "          await writer.close();",
        "        } catch { /* hook exited before draining stdin (EPIPE) */ }",
        "        const result = await proc;",
        "        if (result.exitCode !== 0) return null;",
        "        const rewritten = __decoder.decode(result.stdout).trim();",
        "        return rewritten.length > 0 ? rewritten : null;",
        "      };",
      ]
    : [];

  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: PreToolUse → tool.execute.before",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const PreToolUse: Plugin = async (context) => {",
    "  return {",
    "    \"tool.execute.before\": async (input: { tool: string; sessionID?: string; callID?: string }, output: { args: Record<string, unknown> }) => {",
    "      const __encoder = new TextEncoder();",
    "      const __decoder = new TextDecoder();",
    "      const __pluginRoot = context.directory;",
    "      const __cwd = context.worktree;",
    "      const __payload = JSON.stringify({",
    "        hook_event_name: \"PreToolUse\",",
    "        tool_name: input.tool,",
    "        tool_input: output.args ?? {},",
    "        cwd: __cwd,",
    "        workspace: { current_dir: __cwd },",
    "      });",
    "      const __shellQuote = (value: string): string => `'${value.replaceAll(\"'\", \"'\\\\''\")}'`;",
    "      const __denyCommand = (reason: string, code: number): string => `printf '%s\\\\n' ${__shellQuote(reason)} >&2; exit ${code}`;",
    "      const __runHook = async (inner: string): Promise<boolean> => {",
    "        const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot, OPENCODE_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
    "        try {",
    "          const writer = proc.stdin.getWriter();",
    "          await writer.write(__encoder.encode(__payload));",
    "          await writer.close();",
    "        } catch { /* hook exited before draining stdin (EPIPE) */ }",
    "        const result = await proc;",
    "        const stdout = __decoder.decode(result.stdout).trim();",
    "        let structuredReason = \"\";",
    "        if (stdout.length > 0) {",
    "          try {",
    "            const parsed = JSON.parse(stdout) as { decision?: string; reason?: string; hookSpecificOutput?: { permissionDecision?: string; permissionDecisionReason?: string } };",
    "            if (parsed.decision === \"block\" || parsed.hookSpecificOutput?.permissionDecision === \"deny\") {",
    "              structuredReason = parsed.hookSpecificOutput?.permissionDecisionReason || parsed.reason || `RedSkills PreToolUse hook denied ${input.tool}.`;",
    "            }",
    "          } catch { /* non-JSON stdout is ignored */ }",
    "        }",
    "        if (result.exitCode === 0 && structuredReason.length === 0) return false;",
    "        const stderr = __decoder.decode(result.stderr).trim();",
    "        const reason = structuredReason || (stderr.length > 0 ? stderr : `RedSkills PreToolUse hook denied ${input.tool}.`);",
    "        if (output.args && typeof output.args === \"object\" && \"command\" in output.args) {",
    "          output.args = { ...output.args, command: __denyCommand(reason, result.exitCode) };",
    "          return true;",
    "        }",
    "        throw new Error(reason);",
    "      };",
    ...rspRewriteHelper,
    cases,
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

/** TypeScript template for the `config` event module (SessionStart). */
function configEventTemplate(input: {
  sourceFiles: string[];
  commands: string[];
}): string {
  // Each command is a `sh -c '…'` string. The rewritePluginRoot pass
  // already replaced `${CLAUDE_PLUGIN_ROOT}` / `${CODEX_PLUGIN_ROOT}`
  // with `${__pluginRoot}`; the emitted module binds `__pluginRoot`
  // from the opencode plugin context's `directory` and runs the
  // command via Bun's shell template literal.
  const steps = input.commands.map((cmd) => {
    const inner = cmd.replace(/^sh -c\s*'/, "").replace(/'$/, "");
    return [
      `      await __runSessionStart(${JSON.stringify(inner)});`,
    ].join("\n");
  });

  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: SessionStart → config + chat system context",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const SessionStart: Plugin = async (context) => {",
    "  let __ran = false;",
    "  const __sessionContext: string[] = [];",
    "  const __encoder = new TextEncoder();",
    "  const __decoder = new TextDecoder();",
    "  const __pluginRoot = context.directory;",
    "  const __cwd = context.worktree;",
    "  const __payload = JSON.stringify({",
    "    hook_event_name: \"SessionStart\",",
    "    cwd: __cwd,",
    "    workspace: { current_dir: __cwd },",
    "  });",
    "  const __extractContext = (stdout: string): string | null => {",
    "    const text = stdout.trim();",
    "    if (!text || text === \"{}\") return null;",
    "    try {",
    "      const parsed = JSON.parse(text) as { systemMessage?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };",
    "      const direct = typeof parsed.systemMessage === \"string\" ? parsed.systemMessage : null;",
    "      const claude = typeof parsed.hookSpecificOutput?.additionalContext === \"string\" ? parsed.hookSpecificOutput.additionalContext : null;",
    "      return direct ?? claude;",
    "    } catch {",
    "      return text;",
    "    }",
    "  };",
    "  const __runSessionStart = async (inner: string): Promise<void> => {",
    "    try {",
    "      const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot, OPENCODE_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
    "      try {",
    "        const writer = proc.stdin.getWriter();",
    "        await writer.write(__encoder.encode(__payload));",
    "        await writer.close();",
    "      } catch { /* hook exited before draining stdin (EPIPE) */ }",
    "      const result = await proc;",
    "      const ctx = __extractContext(__decoder.decode(result.stdout));",
    "      if (ctx && !__sessionContext.includes(ctx)) __sessionContext.push(ctx);",
    "    } catch { /* best-effort */ }",
    "  };",
    "  const __runOnce = async (): Promise<void> => {",
    "    if (__ran) return;",
    "    __ran = true;",
    steps.join("\n"),
    "  };",
    "  return {",
    "    config: async () => {",
    "      await __runOnce();",
    "    },",
    "    \"experimental.chat.system.transform\": async (_input: { sessionID?: string }, output: { system: string[] }) => {",
    "      await __runOnce();",
    "      for (const ctx of __sessionContext) output.system.push(ctx);",
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

function commandRunnerPrelude(sourceEvent: string): string[] {
  return [
    "      const __encoder = new TextEncoder();",
    "      const __decoder = new TextDecoder();",
    "      const __pluginRoot = context.directory;",
    "      const __cwd = context.worktree;",
    "      const __runHook = async (inner: string, payload: Record<string, unknown>): Promise<string | null> => {",
    "        try {",
    "          const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot, OPENCODE_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
    "          try {",
    "            const writer = proc.stdin.getWriter();",
    "            await writer.write(__encoder.encode(JSON.stringify(payload)));",
    "            await writer.close();",
    "          } catch { /* hook exited before draining stdin (EPIPE) */ }",
    "          const result = await proc;",
    "          return __decoder.decode(result.stdout).trim();",
    "        } catch {",
    "          return null;",
    "        }",
    "      };",
    "      const __extractContext = (stdout: string | null): string | null => {",
    "        const text = (stdout ?? \"\").trim();",
    "        if (!text || text === \"{}\") return null;",
    "        try {",
    "          const parsed = JSON.parse(text) as { systemMessage?: unknown; hookSpecificOutput?: { additionalContext?: unknown } };",
    "          const direct = typeof parsed.systemMessage === \"string\" ? parsed.systemMessage : null;",
    "          const claude = typeof parsed.hookSpecificOutput?.additionalContext === \"string\" ? parsed.hookSpecificOutput.additionalContext : null;",
    "          return direct ?? claude;",
    "        } catch {",
    "          return text;",
    "        }",
    "      };",
    `      const __sourceEvent = ${JSON.stringify(sourceEvent)};`,
  ];
}

function sideEffectCases(input: {
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
  toolExpression?: string;
  payloadExpression: string;
  contextSink?: string;
}): string {
  return input.hookGroups
    .map((g) => {
      const inner = g.command.replace(/^sh -c\s*'/, "").replace(/'$/, "");
      const run = [
        `        const __stdout = await __runHook(${JSON.stringify(inner)}, ${input.payloadExpression});`,
        input.contextSink ? `        const __ctx = __extractContext(__stdout); if (__ctx) ${input.contextSink};` : "",
      ].filter(Boolean).join("\n");
      if (!input.toolExpression) {
        return [
          "      {",
          run,
          "      }",
        ].join("\n");
      }
      return [
        `      if (${matcherToRegex(g.matcher)}.test(${input.toolExpression})) {`,
        run,
        "      }",
      ].join("\n");
    })
    .join("\n");
}

function toolExecuteAfterTemplate(input: {
  sourceFiles: string[];
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
}): string {
  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: PostToolUse → tool.execute.after",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const PostToolUse: Plugin = async (context) => {",
    "  return {",
    "    \"tool.execute.after\": async (input: { tool: string; sessionID?: string; callID?: string; args?: Record<string, unknown> }, output: { title?: string; output?: string; metadata?: unknown }) => {",
    ...commandRunnerPrelude("PostToolUse"),
    "      const __payload = {",
    "        hook_event_name: __sourceEvent,",
    "        session_id: input.sessionID,",
    "        tool_name: input.tool,",
    "        tool_input: input.args ?? {},",
    "        tool_response: { title: output.title, output: output.output, metadata: output.metadata },",
    "        cwd: __cwd,",
    "        workspace: { current_dir: __cwd },",
    "      };",
    sideEffectCases({
      hookGroups: input.hookGroups,
      toolExpression: "input.tool",
      payloadExpression: "__payload",
      contextSink: 'output.output = [__ctx, output.output].filter(Boolean).join("\\n\\n")',
    }),
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

function sessionTranscriptHelpers(): string[] {
  return [
    "      const __textParts = (value: unknown, out: string[] = []): string[] => {",
    "        if (typeof value === \"string\") return out;",
    "        if (!value || typeof value !== \"object\") return out;",
    "        if (Array.isArray(value)) { for (const item of value) __textParts(item, out); return out; }",
    "        const record = value as Record<string, unknown>;",
    "        for (const key of [\"text\", \"content\", \"message\", \"output\"] as const) {",
    "          if (typeof record[key] === \"string\") out.push(record[key] as string);",
    "        }",
    "        for (const child of Object.values(record)) __textParts(child, out);",
    "        return out;",
    "      };",
    "      const __readSessionTranscript = async (sessionID?: string): Promise<string | undefined> => {",
    "        if (!sessionID) return undefined;",
    "        const sessionApi = (context.client as unknown as { session?: { messages?: (input: unknown) => Promise<unknown> } }).session;",
    "        if (!sessionApi?.messages) return undefined;",
    "        const attempts = [{ path: { id: sessionID } }, { path: { sessionID } }, { id: sessionID }, { sessionID }];",
    "        for (const attempt of attempts) {",
    "          try {",
    "            const response = await sessionApi.messages(attempt);",
    "            const data = (response as { data?: unknown })?.data ?? response;",
    "            const text = __textParts(data).join(\"\\n\").trim();",
    "            if (text.length > 0) return text;",
    "            return JSON.stringify(data);",
    "          } catch { /* try the next SDK shape */ }",
    "        }",
    "        return undefined;",
    "      };",
  ];
}

function stopTemplate(input: {
  sourceFiles: string[];
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
}): string {
  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: Stop → session.idle",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const Stop: Plugin = async (context) => {",
    "  return {",
    "    \"session.idle\": async (input: { sessionID?: string }) => {",
    ...commandRunnerPrelude("Stop"),
    ...sessionTranscriptHelpers(),
    "      const __transcript = await __readSessionTranscript(input.sessionID);",
    "      const __payload = {",
    "        hook_event_name: __sourceEvent,",
    "        session_id: input.sessionID,",
    "        transcript_text: __transcript,",
    "        transcriptText: __transcript,",
    "        cwd: __cwd,",
    "        workspace: { current_dir: __cwd },",
    "      };",
    sideEffectCases({ hookGroups: input.hookGroups, payloadExpression: "__payload" }),
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

function preCompactTemplate(input: {
  sourceFiles: string[];
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
}): string {
  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: PreCompact → experimental.session.compacting",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const PreCompact: Plugin = async (context) => {",
    "  return {",
    "    \"experimental.session.compacting\": async (input: { sessionID?: string }, output: { context: string[]; prompt?: string }) => {",
    ...commandRunnerPrelude("PreCompact"),
    ...sessionTranscriptHelpers(),
    "      const __transcript = await __readSessionTranscript(input.sessionID);",
    "      const __payload = {",
    "        hook_event_name: __sourceEvent,",
    "        session_id: input.sessionID,",
    "        transcript_text: __transcript,",
    "        transcriptText: __transcript,",
    "        cwd: __cwd,",
    "        workspace: { current_dir: __cwd },",
    "      };",
    sideEffectCases({
      hookGroups: input.hookGroups,
      payloadExpression: "__payload",
      contextSink: "output.context.push(__ctx)",
    }),
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

function userPromptSubmitTemplate(input: {
  sourceFiles: string[];
  hookGroups: { matcher: string; command: string; sourceFile: string }[];
}): string {
  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: UserPromptSubmit → chat.message",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const UserPromptSubmit: Plugin = async (context) => {",
    "  return {",
    "    \"chat.message\": async (input: { sessionID?: string; messageID?: string }, output: { message?: unknown; parts: unknown[] }) => {",
    ...commandRunnerPrelude("UserPromptSubmit"),
    "      const __payload = {",
    "        hook_event_name: __sourceEvent,",
    "        session_id: input.sessionID,",
    "        message_id: input.messageID,",
    "        prompt: output.message,",
    "        cwd: __cwd,",
    "        workspace: { current_dir: __cwd },",
    "      };",
    sideEffectCases({
      hookGroups: input.hookGroups,
      payloadExpression: "__payload",
      contextSink: "output.parts.unshift({ type: \"text\", text: __ctx } as never)",
    }),
    "    },",
    "  };",
    "};",
    "",
  ].join("\n");
}

/** Returns true if `inner` (the unwrapped `sh -c '…'` body) is an rsp
 *  pre-execution hook — one that uses rewrite/passthrough semantics
 *  (exit 0 + non-empty stdout = rewrite; exit 1 = passthrough) rather
 *  than the block-deny JSON protocol the other hooks use.
 *
 *  The detection is intentionally conservative: only the well-known Claude rsp
 *  pre-exec invocation qualifies; other rsp subcommands are pass-through-safe
 *  for the block-deny path. */
export function isRspRewriteHook(inner: string): boolean {
  return inner.includes("hook claude-pre-exec") || (inner.includes("rsp-hook.sh") && inner.includes("claude-pre-exec"));
}

/** Translate a Claude/Codex matcher glob into a JS regex literal. The
 *  source uses `|`-separated names (e.g. `Bash`, `Task|Agent`). We
 *  anchor with `^…$` so a `Bash` matcher does not match `BashAlias`. */
export function matcherToRegex(matcher: string): string {
  if (matcher === "*" || matcher === "") return "/.*/";
  const alts = matcher.split("|").map((s) => s.trim()).filter(Boolean);
  if (alts.length === 0) return "/.*/";
  const escaped = alts.map((a) => a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return `/^(${escaped.join("|")})$/i`;
}

/** Plan the hook → event mapping for a single plugin. */
export function planPluginHooks(pluginsRoot: string, plugin: string): HookPlan[] {
  const hookFiles = listHookFiles(pluginsRoot, plugin);
  if (hookFiles.length === 0) return [];

  // Aggregate commands per source event class. Claude's matcher
  // grammar is glob-style; we translate each matcher to an inline
  // regex test in the generated module.
  const byEvent = new Map<string, { matcher: string; command: string; sourceFile: string }[]>();
  const warnings: string[] = [];

  for (const hookFile of hookFiles) {
    let raw: RawHooksFile;
    try {
      raw = JSON.parse(readFileSync(hookFile, "utf8")) as RawHooksFile;
    } catch (err) {
      warnings.push(`could not parse ${hookFile}: ${(err as Error).message}`);
      continue;
    }
    for (const [event, groups] of Object.entries(raw.hooks ?? {})) {
      const opencodeEvent = EVENT_MAP[event];
      if (!opencodeEvent) {
        warnings.push(`event "${event}" from ${hookFile} has no known OpenCode plugin event equivalent (warn-and-continue)`);
        continue;
      }
      const list = byEvent.get(event) ?? [];
      for (const group of groups) {
        const matcher = group.matcher ?? "*";
        for (const h of group.hooks) {
          if (h.type !== "command") continue;
          const command = rewritePluginRoot(h.command, plugin);
          list.push({ matcher, command, sourceFile: hookFile });
        }
      }
      byEvent.set(event, list);
    }
  }

  const plans: HookPlan[] = [];
  for (const [sourceEvent, list] of byEvent) {
    const opencodeEvent = EVENT_MAP[sourceEvent];
    const target = TARGET_BY_EVENT[sourceEvent];
    if (!opencodeEvent || !target) continue;
    if (sourceEvent === "SessionStart") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: configEventTemplate({
          sourceFiles: list.map((l) => l.sourceFile),
          commands: list.map((l) => l.command),
        }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (sourceEvent === "PreToolUse") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: toolExecuteBeforeTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (sourceEvent === "PostToolUse") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: toolExecuteAfterTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (sourceEvent === "Stop") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: stopTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (sourceEvent === "PreCompact") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: preCompactTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (sourceEvent === "UserPromptSubmit") {
      plans.push({
        sourceEvent,
        opencodeEvent,
        target,
        source: userPromptSubmitTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    }
  }
  return plans;
}
