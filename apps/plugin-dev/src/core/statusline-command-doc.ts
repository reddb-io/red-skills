// statusline-command-doc — the documented Claude Code `statusLine` command is
// published in more than one doc, so it must be ONE string and it must end in
// success (issue #3073).
//
// The command has ONE host producer: the **redskilled bundle** renders the whole
// document — the local bedrock and the Worker tail — out of the daemon's
// host-scoped home. The published shell must not invoke a `dev` bundle: ADR 0147
// deleted the dev runtime, so `dev-3.21.0.bundle.min.mjs` is the last one that
// will ever exist and a machine still holding it runs a 3.21.0-era renderer
// against v4 state lanes it cannot read (#4235 and this slice).
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
// module guards the render one: the command resolves the copy the daemon itself
// keeps, and STATES the absence when it still resolves nothing.
//
// **The third defect, same command (issues #3166 and #3559).** `--no-workers`
// plus a second redskilled invocation first replaced the rich dev output with a
// poor daemon line, then became an exact duplicate after the dev command learned
// to compose the daemon tail itself. The stable contract is one shell producer.
//
// **The fourth defect, same command (this slice).** The producer named by rules 3
// and 5 was the thing ADR 0147 deleted. A host that had ever warmed a dev bundle
// kept resolving it, so the line froze at the last dev release and said nothing
// about Workers; a host that had not resolved nothing at all. The producer is
// redeclared here as the bundle the daemon stabilizes under its own home
// (`redskilledStableBundleDir` / `redskilledStableBundleName`), which is the copy
// that survives every cache prune on the machine — and `dev-*` becomes the
// rejected fossil, so the deleted renderer can never be resolved again.
//
// Five rules — #3074 added 3 and 4; #3166/#3559 added 5:
//
//  1. THE COMMAND ENDS IN AN EXPLICIT SUCCESS. It terminates with
//     {@link STATUSLINE_COMMAND_TERMINATOR} so the exit status states what the
//     command already means: the header is the required half, a missing daemon
//     is never a failure of the line.
//  2. EVERY COPY IS THE SAME COPY. The string is hand-maintained prose in two
//     canonical skill docs and mirrored into the generated `packaging/pi/` tree.
//     Four copies with no guard is four chances to fix one and leave three; the
//     sweep compares them byte-for-byte so the next edit cannot half-land.
//  3. EVERY GLOB RESOLVES WHAT PROVISIONING WRITES. The command names bundle
//     files by pattern, and a pattern is only correct relative to the filename
//     the daemon mints. {@link statuslineBundleGlobs} lifts the patterns out
//     so a test can hold them against the daemon's own namer rather than
//     against a human's memory of it.
//  4. AN UNRESOLVED RENDERER SAYS SO. When no bundle answers the glob the command
//     prints {@link STATUSLINE_COMMAND_ABSENCE} itself. This is not the host
//     rendering a Worker row — ADR 0130 rule 10 still holds, and there is no
//     Worker here to render. It is the host reporting that no renderer exists on
//     this machine, because a blank region and a quiet machine look identical.
//  5. EXACTLY ONE HOST PRODUCER EMITS THE DOCUMENT, AND IT IS A LIVE ONE. The
//     redskilled bundle draws the bedrock and the Worker tail in one process, so
//     the published shell invokes it once and nothing else. {@link
//     statuslineCommandsDelegatingWorkers} rejects both fossils of the retired
//     recipe: `--no-workers`, and any reach for the deleted dev runtime — the
//     `dev-*.bundle.min.mjs` cache entry or the `afk.mjs` launcher behind it.

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
 * The bundle directory every published glob hangs off.
 *
 * The daemon's own home, not a cache: `~/.cache/` is GC'd and an npx or mise
 * store is pruned, while `~/.red/redskilled/bundles/` is the copy the daemon
 * stabilizes for its own unit and therefore the only one a render path may
 * assume is still there.
 */
const BUNDLE_DIR_SEGMENT = "/.red/redskilled/bundles/";

/**
 * The dev-bundle flag that renders the repo header and no Worker rows.
 *
 * In the command it is the whole of the defect: the rich rows are drawn by
 * default, and this flag is what switched them off.
 */
const WORKER_ROWS_OFF = "--no-workers";

/**
 * The deleted dev runtime, in either spelling it was ever reached by.
 *
 * ADR 0147 removed the dev bundle and the launcher that fetched it, so a match
 * here is not a stale preference — it is a command that resolves 3.21.0-era code
 * on any machine that still holds a copy. Anchored left so `redskilled-…` and a
 * path segment ending in `dev` are not swept in.
 */
const DEV_RUNTIME_FOSSIL = /(?:^|[^\w-])(?:dev-[\w.*-]*\.bundle\.min\.mjs|afk\.mjs)/;

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
 * The copies that still carry a fossil of the retired recipe. PURE.
 *
 * One check, two fossils: `--no-workers` asks for a split no renderer exposes,
 * and any reach for the dev runtime resolves a renderer ADR 0147 deleted — the
 * frozen line this rule exists to make impossible.
 */
export function statuslineCommandsDelegatingWorkers(
  sites: readonly StatuslineCommandSite[],
): StatuslineCommandSite[] {
  return sites.filter((site) => site.body.includes(WORKER_ROWS_OFF) || DEV_RUNTIME_FOSSIL.test(site.body));
}

/** A failure message naming every copy that still carries a retired producer. */
export function describeStatuslineDelegation(sites: readonly StatuslineCommandSite[]): string {
  const delegating = statuslineCommandsDelegatingWorkers(sites);
  if (delegating.length === 0) return "";
  return [
    `${delegating.length} statusLine command cop${delegating.length === 1 ? "y" : "ies"} still carry a retired statusline producer.`,
    "Invoke the redskilled bundle once: it renders the local bedrock and the Worker tail in one process (#3559, ADR 0141).",
    `Drop \`${WORKER_ROWS_OFF}\` and drop every reach for the dev runtime ADR 0147 deleted.`,
    ...delegating.map((site) => `  ${site.path}:${site.line}`),
  ].join("\n");
}

/**
 * Every bundle filename PATTERN the command globs, in the order it globs them
 * (`redskilled-*.bundle.min.mjs`, …). PURE.
 *
 * Takes the shell text so a caller may pass the published body escaped or
 * resolved: the bundle paths carry no JSON escape, so both spellings read alike.
 */
export function statuslineBundleGlobs(body: string): string[] {
  const globs: string[] = [];
  // A glob ends where the shell word does: whitespace or a metacharacter. `\S+`
  // would swallow the `);` that closes a `$(ls …)` and report a pattern the
  // shell never expands.
  const pattern = new RegExp(`${BUNDLE_DIR_SEGMENT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^\\s;)|&"']+)`, "g");
  for (const match of body.matchAll(pattern)) {
    const glob = match[1];
    if (glob) globs.push(glob);
  }
  return globs;
}

/**
 * Does any published glob resolve `fileName`? PURE.
 *
 * The question the render command actually asks of provisioning: the daemon
 * mints `redskilled-<version>.bundle.min.mjs`, and a glob that does not match it
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
