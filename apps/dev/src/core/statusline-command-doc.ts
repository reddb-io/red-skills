// statusline-command-doc — the documented Claude Code `statusLine` command is
// published in more than one doc, so it must be ONE string and it must end in
// success (issue #3073).
//
// The command is a ONE-producer line today: the dev bundle renders the repo
// header AND the Worker rows. It was a two-producer line — the daemon rendering
// the rows it owns (ADR 0130 rule 10) — and it will be one again; see the interim
// note under rule 5. Either way the rule is the same: one renderer draws a Worker
// row, and a host that cannot reach that renderer says so rather than going blank.
//
// **The first defect this closes (issue #3073).** The command's last statement was the bare test
// `[ -n "$r" ] && "$N" "$r" statusline 2>/dev/null`. With no cached daemon
// bundle `$r` is empty, the test fails, and because it is the FINAL statement
// its status becomes the exit status of the whole `sh -c`: a status producer
// that rendered its header correctly and still reported failure. `/red-setup`
// writes this exact string into every repo it touches, so the defect shipped
// once per project and every operator re-derived the same fix by hand.
//
// **The second defect, same command (issue #3074).** The daemon half globbed
// `~/.cache/red-skills/bundles/redskilled*.bundle.min.mjs`, and nothing wrote a
// `redskilled` bundle there: on a host provisioned through `npx` the only copy
// on the machine lived inside the npx cache. `$r` was empty on EVERY host, the
// daemon was never contacted, and the operator read a blank region below the
// header as "this machine has no Workers". The fix has two halves and this
// module guards the render one: provisioning warms the daemon bundle beside its
// siblings (`companionBundlePlugins` in `packages/shared/bundle-fetch.ts`), and
// the command STATES the absence when it still resolves nothing.
//
// **The third defect, same command (issue #3166).** Rules 1–4 all held and the
// line still got poorer. `--no-workers` silenced the dev bundle's Worker rows and
// the daemon's `line` density drew what it could: a project label, an id and a
// memory figure, where the dev bundle had been drawing a bar, a colour, aligned
// `run=`/`org=`/`iss=` columns, `phase·activity`, elapsed, heartbeat, diff and
// token vitals — code already in the tree, already tested, already correct. The
// sweep did its job perfectly and that was the trap: all four copies said the
// same thing, and all four said the poorer thing, so every repo `/red-setup`
// touched since the cutover shipped it. Rule 5 is the reversal, and it is INTERIM.
//
// Five rules — #3074 added 3 and 4, #3166 added 5:
//
//  1. THE COMMAND ENDS IN AN EXPLICIT SUCCESS. It terminates with
//     {@link STATUSLINE_COMMAND_TERMINATOR} so the exit status states what the
//     command already means: the header is the required half, a missing daemon
//     is never a failure of the line.
//  2. EVERY COPY IS THE SAME COPY. The string is hand-maintained prose in two
//     canonical skill docs and mirrored into the generated `packaging/pi/` tree.
//     Four copies with no guard is four chances to fix one and leave three; the
//     sweep compares them byte-for-byte so the next edit cannot half-land.
//  3. EVERY GLOB RESOLVES WHAT PROVISIONING WRITES. The command names cache
//     files by pattern, and a pattern is only correct relative to the filename
//     the warm path mints. {@link statuslineBundleGlobs} lifts the patterns out
//     so a test can hold them against `bundleFileName(plugin, version)` rather
//     than against a human's memory of it.
//  4. AN UNRESOLVED RENDERER SAYS SO. When no bundle answers the glob the command
//     prints {@link STATUSLINE_COMMAND_ABSENCE} itself. This is not the host
//     rendering a Worker row — ADR 0130 rule 10 still holds, and there is no
//     Worker here to render. It is the host reporting that no renderer exists on
//     this machine, because a blank region and a quiet machine look identical.
//  5. EXACTLY ONE PRODUCER DRAWS THE WORKER ROWS — **INTERIM, until #3151.**
//     {@link statuslineCommandsDelegatingWorkers} refuses both halves of the
//     delegation: `--no-workers`, which mutes the only producer left, and a
//     `redskilled*.bundle.min.mjs` glob, which puts a second block of Worker rows
//     under the first saying less than it.
//
//     **Read this before restoring the delegation.** Rule 5 does not repudiate
//     ADR 0130 rule 10 and is not an argument for two renderers. The daemon owns
//     the Worker line and should serve it finished; the delegation was simply made
//     before the daemon could draw the row, and nothing measured what replaced it.
//     #3151 rewrites the daemon's `line` density to carry it and #3152 gives the
//     other densities the same palette. When #3151 lands, this rule inverts back:
//     the dev bundle returns to `--no-workers`, the daemon half returns, and the
//     `redskilled` glob returns with it (the companion warm path never stopped
//     writing that bundle — see the glob test). Until then, restoring the
//     delegation trades a rich line for a poor one across every repo at once.

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
 * The sentence the command prints when no daemon bundle answers its glob.
 *
 * It is a COPY of `REDSKILLED_RENDER_ABSENCE`, kept here as a literal so
 * this module stays free of the daemon package it describes; the test pins the
 * two together, so the shell branch and the daemon's own render can never say
 * the absence in two different sentences.
 */
export const STATUSLINE_COMMAND_ABSENCE = "redskilled unreachable — Worker state unknown";

/**
 * The issue that ends the interim single-producer form (rule 5).
 *
 * Carried in the guard's own failure message rather than only in a comment: a
 * reader who trips rule 5 is usually restoring ADR 0130 rule 10 on purpose, and
 * what they need is not a refusal but the ticket that makes the restoration
 * correct.
 */
export const STATUSLINE_DELEGATION_ISSUE = "#3151";

/** The bundle cache directory every published glob hangs off. */
const BUNDLE_CACHE_SEGMENT = "/.cache/red-skills/bundles/";

/**
 * The dev-bundle flag that renders the repo header and no Worker rows.
 *
 * In the command it is the whole of the defect: the rich rows are drawn by
 * default, and this flag is what switched them off.
 */
const WORKER_ROWS_OFF = "--no-workers";

/** The daemon bundle the delegated half invoked. Matched as a glob OR a filename. */
const DAEMON_BUNDLE = /redskilled[\w.*-]*\.bundle\.min\.mjs/;

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

/** The copies that never state the absence when no daemon bundle resolves. PURE. */
export function statuslineCommandsMissingAbsence(
  sites: readonly StatuslineCommandSite[],
  sentence: string = STATUSLINE_COMMAND_ABSENCE,
): StatuslineCommandSite[] {
  return sites.filter((site) => !site.body.includes(sentence));
}

/** A failure message naming every copy that renders the absence as nothing. */
export function describeStatuslineAbsence(
  sites: readonly StatuslineCommandSite[],
  sentence: string = STATUSLINE_COMMAND_ABSENCE,
): string {
  const silent = statuslineCommandsMissingAbsence(sites, sentence);
  if (silent.length === 0) return "";
  return [
    `${silent.length} statusLine command cop${silent.length === 1 ? "y" : "ies"} do not print \`${sentence}\` when no daemon bundle resolves.`,
    "A blank region below the header is indistinguishable from a machine with no Workers — the operator reads an outage as calm (#3074).",
    ...silent.map((site) => `  ${site.path}:${site.line}`),
  ].join("\n");
}

/**
 * The copies that split the Worker rows across two producers, or across none.
 * PURE.
 *
 * One check, two spellings of one mistake: `--no-workers` mutes the dev bundle
 * (nothing draws a row), and a `redskilled` bundle glob runs a second renderer
 * under the first (two blocks of rows, the lower one poorer). Both are the
 * delegation, and the delegation is on hold until {@link
 * STATUSLINE_DELEGATION_ISSUE}.
 */
export function statuslineCommandsDelegatingWorkers(
  sites: readonly StatuslineCommandSite[],
): StatuslineCommandSite[] {
  return sites.filter((site) => site.body.includes(WORKER_ROWS_OFF) || DAEMON_BUNDLE.test(site.body));
}

/** A failure message naming every copy that delegates, and the issue that un-holds it. */
export function describeStatuslineDelegation(sites: readonly StatuslineCommandSite[]): string {
  const delegating = statuslineCommandsDelegatingWorkers(sites);
  if (delegating.length === 0) return "";
  return [
    `${delegating.length} statusLine command cop${delegating.length === 1 ? "y" : "ies"} split the Worker rows across two producers, or across none.`,
    `Exactly one producer draws them, and it is the dev bundle — INTERIM, until ${STATUSLINE_DELEGATION_ISSUE} teaches the daemon's \`line\` density to carry the row (#3166).`,
    `Drop \`${WORKER_ROWS_OFF}\` and drop the daemon half; restoring the ADR 0130 rule 10 delegation is correct only once ${STATUSLINE_DELEGATION_ISSUE} has landed.`,
    ...delegating.map((site) => `  ${site.path}:${site.line}`),
  ].join("\n");
}

/**
 * Every bundle-cache filename PATTERN the command globs, in the order it globs
 * them (`dev-*.bundle.min.mjs`, `redskilled*.bundle.min.mjs`, …). PURE.
 *
 * Takes the shell text so a caller may pass the published body escaped or
 * resolved: the cache paths carry no JSON escape, so both spellings read alike.
 */
export function statuslineBundleGlobs(body: string): string[] {
  const globs: string[] = [];
  // A glob ends where the shell word does: whitespace or a metacharacter. `\S+`
  // would swallow the `);` that closes a `$(ls …)` and report a pattern the
  // shell never expands.
  const pattern = new RegExp(`${BUNDLE_CACHE_SEGMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s;)|&"']+)`, "g");
  for (const match of body.matchAll(pattern)) {
    const glob = match[1];
    if (glob) globs.push(glob);
  }
  return globs;
}

/**
 * Does any published glob resolve `fileName`? PURE.
 *
 * The question the render command actually asks of provisioning: the warm path
 * mints `<plugin>-<version>.bundle.min.mjs`, and a glob that does not match it
 * is the whole of #3074 — a command that looked in the right directory for a
 * name nothing writes.
 */
export function statuslineGlobResolves(body: string, fileName: string): boolean {
  return statuslineBundleGlobs(body).some((glob) => globMatches(glob, fileName));
}

/** Shell `*` (never crossing a `/`) against one basename. PURE. */
function globMatches(glob: string, name: string): boolean {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^/]*");
  return new RegExp(`^${source}$`).test(name);
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
