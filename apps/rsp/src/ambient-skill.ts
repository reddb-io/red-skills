import { RSP_WRAPPER_CAPABILITIES, type RspWrapperCapability } from "./intercept.js";

// Path of the committed artifact this generator renders, relative to the rsp
// package root. The drift test and the regeneration script share this constant
// so the source of truth for the file location lives in one place.
export const AMBIENT_SKILL_RELATIVE_PATH = "generated/AMBIENT-SKILL.md";

export type RspInstructionRunner = "claude" | "codex";

export interface AmbientSkillRenderOptions {
  runner?: RspInstructionRunner;
}

/**
 * Render the ambient-instruction surface (the RTK.md-replacement doc) FROM the
 * rsp wrapper capability table, so the ambient surface can never drift from the
 * actual wrappers — the table is the single source. Regenerate the committed
 * artifact whenever the capability table changes; the drift test fails until it
 * is regenerated.
 */
export function renderAmbientSkill(
  capabilities: readonly RspWrapperCapability[] = RSP_WRAPPER_CAPABILITIES,
  options: AmbientSkillRenderOptions = {},
): string {
  const rows = capabilities.map((capability) => {
    const command = capability.command.join(" ");
    const wrapper = ["rsp", ...capability.wrapper].join(" ");
    return `| \`${command}\` | \`${wrapper}\` |`;
  });
  const preferences = capabilities.map((capability) => {
    const wrapper = ["rsp", ...capability.wrapper].join(" ");
    const command = capability.command.join(" ");
    return `- For \`${command}\`, prefer \`${wrapper}\` when the summarized output is enough.`;
  });
  const runnerLines = renderRunnerLines(options.runner);

  return [
    "# rsp — token-efficient command wrappers",
    "",
    "<!-- GENERATED FILE — do not edit by hand.",
    "     Source: apps/rsp/src/intercept.ts (RSP_WRAPPER_CAPABILITIES),",
    "     rendered by apps/rsp/src/ambient-skill.ts.",
    "     Regenerate: pnpm --filter @reddb-io/rsp gen:ambient-skill -->",
    "",
    "`rsp` wraps noisy development commands and stores their full output in a",
    "reversible elision store, so the agent reads a compact summary and can",
    "recover the original bytes on demand with `rsp show el:<id>`.",
    "",
    ...runnerLines,
    ...(runnerLines.length > 0 ? [""] : []),
    "## Wrapped commands",
    "",
    "When you would run one of these commands, run it through `rsp` instead:",
    "",
    "| Command | rsp wrapper |",
    "| --- | --- |",
    "| `cat <file>` | `rsp cat <file>` |",
    "| `head <file>` / `head -n N <file>` | `rsp cat --head N <file>` |",
    "| `tail <file>` / `tail -n N <file>` | `rsp cat --tail N <file>` |",
    ...rows,
    "",
    "## When to prefer rsp",
    "",
    "- For deterministic file reads, prefer `rsp cat <file>`; code files render an outline plus bounded content, text/config files are threshold-gated, and binary files pass through untouched.",
    "- For simple file dumps, Claude pre-exec may rewrite bare `cat <file>`, `head <file>`, `head -n N <file>`, `tail <file>`, and `tail -n N <file>` when the path is an unquoted single file token.",
    ...preferences,
    "",
    "For arbitrary shell pipelines or compound commands where only final stdout",
    "should enter the agent context, call `rsp exec -- \"<command line>\"` directly.",
    "Bytes inside pipes remain untouched; stderr and exit status follow the raw",
    "shell command.",
    "",
    "Use raw commands when exact stdout/stderr is the behavior under test, when",
    "a wrapper does not support the command shape, or when resolving low-level",
    "git conflicts where every byte matters.",
    "",
    "## Loss levels",
    "",
    "Use `--brief` for compact summaries that keep enough inline context for",
    "normal debugging. Use `--terse` for large or repetitive output; lossy output",
    "mints an `el:<id>` handle, and `rsp show el:<id>` writes the original bytes",
    "back to stdout. Use `--full` when exact inline output is required.",
    "",
    "`rsp cat <file>`, large `rsp git diff`, and large `rsp git log` output may",
    "truncate by default; pass `--full` when exact inline output is required.",
    "",
    "## Recovering elided output",
    "",
    "`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or",
    "evicted handles print `expired <ISO date> — re-run: <original command>` and",
    "exit 1, so the exact command to reproduce the output is always in reach.",
    "",
    "## Failure behavior",
    "",
    "If an rsp wrapper is disabled, lacks its store, or fails, it passes through to the raw command",
    "with the raw command's stdout, stderr, and exit status intact.",
    "",
  ].join("\n");
}

function renderRunnerLines(runner: RspInstructionRunner | undefined): string[] {
  if (runner === "codex") {
    return [
      "## Codex lane",
      "",
      "This ambient instruction is the primary Codex lane: call `rsp` directly",
      "when one of the wrapped command forms applies.",
    ];
  }
  if (runner === "claude") {
    return [
      "## Claude lane",
      "",
      "Claude Code pre-execution interception is available for simple wrapped",
      "commands, and direct calls still help when composing commands deliberately.",
    ];
  }
  return [];
}
