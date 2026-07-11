import { RSP_WRAPPER_CAPABILITIES, type RspWrapperCapability } from "./intercept.js";

// Path of the committed artifact this generator renders, relative to the rsp
// package root. The drift test and the regeneration script share this constant
// so the source of truth for the file location lives in one place.
export const AMBIENT_SKILL_RELATIVE_PATH = "generated/AMBIENT-SKILL.md";

/**
 * Render the ambient-instruction surface (the RTK.md-replacement doc) FROM the
 * rsp wrapper capability table, so the ambient surface can never drift from the
 * actual wrappers — the table is the single source. Regenerate the committed
 * artifact whenever the capability table changes; the drift test fails until it
 * is regenerated.
 */
export function renderAmbientSkill(
  capabilities: readonly RspWrapperCapability[] = RSP_WRAPPER_CAPABILITIES,
): string {
  const rows = capabilities.map((capability) => {
    const command = capability.command.join(" ");
    const wrapper = ["rsp", ...capability.wrapper].join(" ");
    return `| \`${command}\` | \`${wrapper}\` |`;
  });

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
    "## Wrapped commands",
    "",
    "When you would run one of these commands, run it through `rsp` instead:",
    "",
    "| Command | rsp wrapper |",
    "| --- | --- |",
    ...rows,
    "",
    "## Recovering elided output",
    "",
    "`rsp show el:<id>` writes the original bytes verbatim to stdout. Expired or",
    "evicted handles print `expired <ISO date> — re-run: <original command>` and",
    "exit 1, so the exact command to reproduce the output is always in reach.",
    "",
  ].join("\n");
}
