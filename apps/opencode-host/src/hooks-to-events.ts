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

/** The Claude/Codex event classes the generator knows how to map. */
const KNOWN_EVENTS = new Set(["SessionStart", "PreToolUse", "UserPromptSubmit", "PostToolUse"]);

/** Map source event class → opencode event key. */
const EVENT_MAP: Readonly<Record<string, string>> = Object.freeze({
  SessionStart: "config",
  PreToolUse: "tool.execute.before",
  // UserPromptSubmit / PostToolUse are not yet mapped. They produce a
  // warning at generate time and no module is emitted for them.
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
    .replace(/\$\{CODEX_PLUGIN_ROOT\}/g, `\${__pluginRoot}`);
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
        "        const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
        "        const writer = proc.stdin.getWriter();",
        "        await writer.write(__encoder.encode(__payload));",
        "        await writer.close();",
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
    "        const proc = Bun.$`sh -c ${inner}`.env({ __pluginRoot, CLAUDE_PLUGIN_ROOT: __pluginRoot, CODEX_PLUGIN_ROOT: __pluginRoot }).quiet().nothrow();",
    "        const writer = proc.stdin.getWriter();",
    "        await writer.write(__encoder.encode(__payload));",
    "        await writer.close();",
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
      "      try {",
      `        const __pluginRoot = context.directory;`,
      `        await Bun.$\`sh -c ${JSON.stringify(inner)}\`.quiet();`,
      "      } catch { /* best-effort */ }",
    ].join("\n");
  });

  return [
    "// generated by @reddb-io/red-skills — slice 2 (hooks → events)",
    "// ADR 0077: SessionStart → config",
    "// do not edit by hand — re-run the generator to refresh.",
    "",
    'import type { Plugin } from "@opencode-ai/plugin";',
    "",
    "export const SessionStart: Plugin = async (context) => {",
    "  return {",
    "    config: async () => {",
    steps.join("\n"),
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
 *  The detection is intentionally conservative: only the well-known
 *  `hook claude-pre-exec` invocation qualifies; other rsp subcommands
 *  are pass-through-safe for the block-deny path. */
export function isRspRewriteHook(inner: string): boolean {
  return inner.includes("hook claude-pre-exec");
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
      if (!KNOWN_EVENTS.has(event)) {
        warnings.push(`event "${event}" from ${hookFile} is not yet mapped (warn-and-continue; will land in a follow-up slice)`);
        continue;
      }
      const opencodeEvent = EVENT_MAP[event];
      if (!opencodeEvent) continue;
      const list = byEvent.get(opencodeEvent) ?? [];
      for (const group of groups) {
        const matcher = group.matcher ?? "*";
        for (const h of group.hooks) {
          if (h.type !== "command") continue;
          const command = rewritePluginRoot(h.command, plugin);
          list.push({ matcher, command, sourceFile: hookFile });
        }
      }
      byEvent.set(opencodeEvent, list);
    }
  }

  const plans: HookPlan[] = [];
  for (const [opencodeEvent, list] of byEvent) {
    if (opencodeEvent === "config") {
      const redFetch = list.find((l) => l.command.includes("red-fetch.mjs"))?.command ?? null;
      const statusline = list.find((l) => l.command.includes("ensure-codex-statusline"))?.command ?? null;
      plans.push({
        sourceEvent: "SessionStart",
        opencodeEvent,
        target: "plugin/session-start.ts",
        source: configEventTemplate({
          sourceFiles: list.map((l) => l.sourceFile),
          commands: [redFetch, statusline].filter((c): c is string => Boolean(c)),
        }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    } else if (opencodeEvent === "tool.execute.before") {
      plans.push({
        sourceEvent: "PreToolUse",
        opencodeEvent,
        target: "plugin/pre-tool-use.ts",
        source: toolExecuteBeforeTemplate({ sourceFiles: list.map((l) => l.sourceFile), hookGroups: list }),
        sourceFiles: list.map((l) => l.sourceFile),
        warnings,
      });
    }
  }
  return plans;
}
