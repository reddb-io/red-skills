// statusline-command-doc — the documented Claude Code `statusLine` command is
// published in more than one doc, so it must be ONE string and it must end in
// success (issue #3073).
//
// The command is a two-producer line: the dev bundle renders the repo header,
// the `redskilled` daemon renders the Worker rows (ADR 0130 rule 10). Only the
// header is required. The daemon half is best-effort by construction — its
// stderr is already discarded — and a host with no cached daemon bundle is the
// ordinary case, not a fault.
//
// **The defect this closes.** The command's last statement was the bare test
// `[ -n "$r" ] && "$N" "$r" statusline 2>/dev/null`. With no cached daemon
// bundle `$r` is empty, the test fails, and because it is the FINAL statement
// its status becomes the exit status of the whole `sh -c`: a status producer
// that rendered its header correctly and still reported failure. `/red-setup`
// writes this exact string into every repo it touches, so the defect shipped
// once per project and every operator re-derived the same fix by hand.
//
// Two rules, and the second is why this module exists at all:
//
//  1. THE COMMAND ENDS IN AN EXPLICIT SUCCESS. It terminates with
//     {@link STATUSLINE_COMMAND_TERMINATOR} so the exit status states what the
//     command already means: the header is the required half, a missing daemon
//     is never a failure of the line.
//  2. EVERY COPY IS THE SAME COPY. The string is hand-maintained prose in two
//     canonical skill docs and mirrored into the generated `packaging/pi/` tree.
//     Four copies with no guard is four chances to fix one and leave three; the
//     sweep compares them byte-for-byte so the next edit cannot half-land.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The explicit success the command must terminate with.
 *
 * Appended after the best-effort daemon half, it makes the whole `sh -c` report
 * the truth: the header rendered, and whether a daemon answered is not the
 * line's verdict to fail on.
 */
export const STATUSLINE_COMMAND_TERMINATOR = "; exit 0";

/**
 * Every doc surface that publishes the command verbatim.
 *
 * The first two are the hand-maintained sources: the `red-statusline` host
 * recipe and the `/red-setup` interview step that writes `.claude/settings.json`.
 * The last two are their generated `packaging/pi/` mirrors — included so a stale
 * mirror fails here rather than shipping a command the canonical docs no longer
 * describe.
 */
export const STATUSLINE_COMMAND_DOCS: readonly string[] = [
  "plugins/dev/skills/engineering/red-statusline/HOST-NOTES.md",
  "plugins/dev/skills/engineering/red-setup/INTERVIEW.md",
  "packaging/pi/dev/skills/engineering/red-statusline/HOST-NOTES.md",
  "packaging/pi/dev/skills/engineering/red-setup/INTERVIEW.md",
];

/** One published copy of the command, located for a human to go fix. */
export interface StatuslineCommandSite {
  /** Repo-relative path of the doc holding this copy. */
  readonly path: string;
  /** 1-indexed line the `"command"` field sits on. */
  readonly line: number;
  /** The JSON string value, exactly as published (`sh -c '…'`). */
  readonly value: string;
  /** The shell body between the outer single quotes, still JSON-escaped. */
  readonly body: string;
}

/**
 * Matches the published `statusLine` command field. Anchored on `sh -c '` so an
 * unrelated `"command"` key elsewhere in a doc is not swept in, and requires the
 * closing `'` so a truncated paste is a miss rather than a silent pass.
 */
const COMMAND_FIELD = /^"command":\s*"sh -c '(.*)'"\s*,?$/;

/**
 * Every published copy of the command in one document. PURE — takes the text so
 * the rules are testable without touching the repo.
 */
export function findStatuslineCommands(path: string, text: string): StatuslineCommandSite[] {
  const sites: StatuslineCommandSite[] = [];
  const lines = text.split("\n");
  for (const [index, raw] of lines.entries()) {
    const match = COMMAND_FIELD.exec(raw.trim());
    if (!match) continue;
    sites.push({
      path,
      line: index + 1,
      value: `sh -c '${match[1]}'`,
      body: match[1] ?? "",
    });
  }
  return sites;
}

/** Every published copy across every declared doc, in declaration order. */
export function readStatuslineCommands(
  repoRoot: string,
  docs: readonly string[] = STATUSLINE_COMMAND_DOCS,
): StatuslineCommandSite[] {
  return docs.flatMap((doc) => findStatuslineCommands(doc, readFileSync(join(repoRoot, doc), "utf8")));
}

/** The copies whose value differs from the first one found. PURE. */
export function driftedStatuslineCommands(
  sites: readonly StatuslineCommandSite[],
): StatuslineCommandSite[] {
  const canonical = sites[0];
  if (!canonical) return [];
  return sites.filter((site) => site.value !== canonical.value);
}

/** The copies that do not terminate in an explicit success. PURE. */
export function unterminatedStatuslineCommands(
  sites: readonly StatuslineCommandSite[],
  terminator: string = STATUSLINE_COMMAND_TERMINATOR,
): StatuslineCommandSite[] {
  return sites.filter((site) => !site.body.endsWith(terminator));
}

/** A failure message naming every drifted copy and the copy it drifted from. */
export function describeStatuslineDrift(sites: readonly StatuslineCommandSite[]): string {
  const canonical = sites[0];
  const drifted = driftedStatuslineCommands(sites);
  if (!canonical || drifted.length === 0) return "";
  return [
    `${drifted.length} statusLine command cop${drifted.length === 1 ? "y" : "ies"} drifted from ${canonical.path}:${canonical.line}.`,
    "Every copy must be byte-identical — edit one and the rest, or regenerate the packaging/pi mirrors with `pnpm pi:packages:build`.",
    ...drifted.map((site) => `  ${site.path}:${site.line}`),
  ].join("\n");
}

/** A failure message naming every copy that can still exit non-zero. */
export function describeStatuslineTermination(sites: readonly StatuslineCommandSite[]): string {
  const open = unterminatedStatuslineCommands(sites);
  if (open.length === 0) return "";
  return [
    `${open.length} statusLine command cop${open.length === 1 ? "y" : "ies"} do not end in \`${STATUSLINE_COMMAND_TERMINATOR}\`.`,
    "The final statement is a best-effort test, so its status becomes the whole command's status: a rendered header still reports failure (#3073).",
    ...open.map((site) => `  ${site.path}:${site.line}`),
  ].join("\n");
}
