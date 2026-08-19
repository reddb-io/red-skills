// bare-invocation-guard — a doc that tells an operator to run a shipped binary
// must give the form that works (issue #3071).
//
// Our binaries are not on an operator's PATH. A shim exists only where an
// installer put one, and where it does exist it may be a stale pin. The house
// rule (ADR 0091, and the report-runtime WRAPPER contract that restates it for
// skills) is that everything runs as:
//
//     npx -y -p @reddb-io/red-skills@<version> <binary> <subcommand> [args]
//
// which pins the version and works on every installation. A PATH shim is a
// warm-cache optimization and may be mentioned as one; it is never the primary
// form.
//
// **The dead end this closes.** `/red-setup` reported the daemon absent and told
// the operator to run `redskilled provision` — the binary that only exists after
// the thing it is supposed to install (#2961). The instruction pointed at its own
// precondition, so an operator on a fresh machine had no move. That shape is not
// specific to provisioning: every bare invocation in a doc is the same dead end
// waiting for a host without the shim.
//
// Four rules:
//
//  1. THE NAME IS FINE, THE COMMAND IS NOT. `\`redskilled\`` naming the daemon is
//     prose. `\`redskilled provision\`` is a line an operator copies, so it must
//     carry the canonical prefix. The guard's whole discrimination is "binary
//     token followed by another token".
//  2. A COMMAND IS A LINE THAT STARTS ONE. Inside a fenced block the binary must
//     open the line (or a `|`/`&&`/`;` segment of it); an indented line is a
//     rendered output sample, not something anyone pastes.
//  3. LEGITIMATE EXCEPTIONS ARE DECLARED, NOT IMPLIED. `rsp` is a repo-local
//     surface by design and is absent from {@link SHIPPED_BINARIES}. Contributor
//     docs running from a checkout invoke `pnpm`/`node`, never a shipped binary,
//     so they never reach this scan.
//  4. HISTORY IS NOT AN INSTRUCTION. `CHANGELOG.md` records what a release said
//     at the time and is never swept.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

/** The canonical invocation prefix every shipped binary rides (ADR 0091). */
export const CANONICAL_INVOCATION_PREFIX = "npx -y -p @reddb-io/red-skills@";

/** One binary whose bare invocation in a doc is a dead end waiting to happen. */
export interface ShippedBinaryName {
  /** The token as it appears at the head of a command line. */
  readonly name: string;
  /**
   * `true` when the token is also an ordinary English word, so matching it in
   * prose would flood the scan with false positives. Such a binary is matched
   * only where a command unambiguously lives: at the head of a fenced shell
   * line.
   */
  readonly fencedOnly?: boolean;
}

/**
 * The binaries the sweep covers.
 *
 * The `red-skills-*` family plus `redskilled` are the operator-facing names —
 * unambiguous tokens, so they are matched in fenced blocks AND in inline prose
 * spans. `memory` / `brain` and their MCP siblings are the in-package bin names;
 * their shipped, operator-facing form is `red-skills-memory` / `red-skills-brain`,
 * and their bare tokens are ordinary nouns this repo writes constantly, so they
 * are matched only at the head of a fenced shell line.
 *
 * `rsp` is deliberately ABSENT: it is a repo-local surface by design (CLAUDE.md),
 * invoked bare on purpose, and adding it here would be a rule the repo does not
 * hold.
 */
/**
 * The dev CLI's bin-map name, as ONE literal.
 *
 * ADR 0147 rule 1 deletes the binary, and the two sweeps that outlive it — this
 * one, and the skill-named-verb ratchet that turns each verb it still carries
 * into an `rs_dev` tool — must agree on the token they are looking for. Spelling
 * it twice would let one sweep keep watching a name the other stopped using.
 */
export const DEV_CLI_BINARY = "red-skills-dev";

export const SHIPPED_BINARIES: readonly ShippedBinaryName[] = [
  { name: DEV_CLI_BINARY },
  { name: "red-skills-memory" },
  { name: "red-skills-brain" },
  { name: "red-skills-redskilled" },
  { name: "red-skills-code-nav" },
  { name: "red-skills-redskilled-mcp" },
  { name: "red-skills-herdr" },
  { name: "redskilled" },
  { name: "memory", fencedOnly: true },
  { name: "brain", fencedOnly: true },
  { name: "memory-mcp", fencedOnly: true },
  { name: "brain-mcp", fencedOnly: true },
];

/**
 * The doc surfaces the sweep covers, as repo-relative globs of a deliberately
 * dumb shape: a file, or a directory walked for `*.md`.
 *
 * `apps/*` and `plugins/*` are expanded at scan time so a new app or plugin
 * inherits the rule the moment its README or skill tree lands.
 */
export const DOC_SWEEP_ROOTS: readonly string[] = [
  "README.md",
  "docs",
  "plugins/*/skills",
  "apps/*/README.md",
  "apps/*/docs",
  "packaging/pi/*/skills",
];

/**
 * Files never swept, by basename.
 *
 * A changelog quotes what a release said when it shipped; rewriting it would be
 * falsifying a record, and nobody pastes a command out of one to fix a live host.
 */
export const SWEEP_EXEMPT_BASENAMES: ReadonlySet<string> = new Set([
  "CHANGELOG.md",
]);

/** Fence info strings whose body is shell a reader pastes. */
const SHELL_FENCE_LANGS: ReadonlySet<string> = new Set([
  "",
  "bash",
  "sh",
  "shell",
  "zsh",
  "console",
]);

/** One bare invocation found in a swept surface. */
export interface BareInvocationSite {
  /** Repo-relative path, POSIX-separated. */
  readonly path: string;
  /** 1-based line. */
  readonly line: number;
  /** The shipped binary that opened the command. */
  readonly binary: string;
  /** Where it was found — a fenced shell line, or an inline code span. */
  readonly kind: "fenced" | "inline";
  /** The offending command text, trimmed for the failure message. */
  readonly command: string;
}

const SEGMENT_SPLIT = /\|\||&&|[|;]/;

function firstTokenOf(segment: string): string {
  const trimmed = segment.trim().replace(/^\$\s+/, "");
  const [head] = trimmed.split(/\s+/, 1);
  return head ?? "";
}

/** The tokens after the head of `segment`, in order. PURE. */
function argumentsOf(segment: string): string[] {
  const trimmed = segment.trim().replace(/^\$\s+/, "");
  return trimmed.split(/\s+/).slice(1);
}

function binaryFor(token: string, fenced: boolean): ShippedBinaryName | undefined {
  return SHIPPED_BINARIES.find(
    (binary) => binary.name === token && (fenced || binary.fencedOnly !== true),
  );
}

/**
 * Every bare invocation in one markdown document. PURE — takes the text, returns
 * the sites, touches no filesystem, so a fixture can prove the rule red before
 * the sweep proves the repo green.
 */
export function findBareInvocations(path: string, text: string): BareInvocationSite[] {
  const sites: BareInvocationSite[] = [];
  const lines = text.split("\n");
  let fenceLang: string | undefined;

  for (const [index, raw] of lines.entries()) {
    const fence = /^\s*```+\s*([^\s`]*)/.exec(raw);
    if (fence) {
      if (fenceLang === undefined) fenceLang = (fence[1] ?? "").toLowerCase();
      else fenceLang = undefined;
      continue;
    }

    if (fenceLang !== undefined) {
      // Rule 2: only a line that STARTS a command is one anybody pastes. An
      // indented line inside a fence is a rendered sample or a continuation.
      if (!SHELL_FENCE_LANGS.has(fenceLang) || /^\s/.test(raw)) continue;
      for (const segment of raw.split(SEGMENT_SPLIT)) {
        const binary = binaryFor(firstTokenOf(segment), true);
        if (!binary) continue;
        if (argumentsOf(segment).length === 0) continue;
        sites.push({
          path,
          line: index + 1,
          binary: binary.name,
          kind: "fenced",
          command: segment.trim(),
        });
      }
      continue;
    }

    for (const span of raw.matchAll(/`([^`\n]+)`/g)) {
      const body = span[1] ?? "";
      const binary = binaryFor(firstTokenOf(body), false);
      if (!binary) continue;
      if (argumentsOf(body).length === 0) continue;
      sites.push({
        path,
        line: index + 1,
        binary: binary.name,
        kind: "inline",
        command: body.trim(),
      });
    }
  }

  return sites;
}

function listMarkdown(absolute: string, repoRoot: string, out: string[]): void {
  let stats;
  try {
    stats = statSync(absolute);
  } catch {
    return;
  }
  if (stats.isFile()) {
    if (absolute.endsWith(".md")) out.push(absolute);
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    listMarkdown(join(absolute, entry.name), repoRoot, out);
  }
}

function expandRoot(repoRoot: string, root: string): string[] {
  const star = root.indexOf("*");
  if (star < 0) return [join(repoRoot, ...root.split("/"))];
  const parts = root.split("/");
  const starAt = parts.findIndex((part) => part === "*");
  if (starAt < 0) return [join(repoRoot, ...parts)];
  const parentAbs = join(repoRoot, ...parts.slice(0, starAt));
  let entries: string[];
  try {
    entries = readdirSync(parentAbs, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  return entries.flatMap((name) =>
    expandRoot(repoRoot, [...parts.slice(0, starAt), name, ...parts.slice(starAt + 1)].join("/")),
  );
}

/** Every swept markdown file, repo-relative and POSIX-separated. */
export function sweptDocuments(
  repoRoot: string,
  roots: readonly string[] = DOC_SWEEP_ROOTS,
): string[] {
  const absolute: string[] = [];
  for (const root of roots) {
    for (const expanded of expandRoot(repoRoot, root)) {
      listMarkdown(expanded, repoRoot, absolute);
    }
  }
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const file of absolute.sort()) {
    const rel = relative(repoRoot, file).split(sep).join("/");
    if (seen.has(rel)) continue;
    if (SWEEP_EXEMPT_BASENAMES.has(rel.split("/").at(-1) ?? "")) continue;
    seen.add(rel);
    paths.push(rel);
  }
  return paths;
}

/** Every bare invocation across the swept surfaces. */
export function scanSweptDocuments(
  repoRoot: string,
  roots: readonly string[] = DOC_SWEEP_ROOTS,
): BareInvocationSite[] {
  return sweptDocuments(repoRoot, roots).flatMap((path) =>
    findBareInvocations(path, readFileSync(join(repoRoot, ...path.split("/")), "utf8")),
  );
}

/** The failure message: every site, and the one edit that cures each. */
export function describeBareInvocations(sites: readonly BareInvocationSite[]): string {
  const lines = sites.map(
    (site) => `  ${site.path}:${site.line} (${site.kind}) — ${site.command}`,
  );
  return [
    `${sites.length} bare shipped-binary invocation(s) in swept doc surfaces:`,
    ...lines,
    "",
    `Each must ride the canonical form: \`${CANONICAL_INVOCATION_PREFIX}<version> <binary> <subcommand>\` (ADR 0091,`,
    "plugins/dev/skills/engineering/_report-runtime/WRAPPER.md). A PATH shim may be mentioned as a warm-cache",
    "optimization, never as the primary form. Naming the binary alone (`redskilled`) is prose and stays legal.",
  ].join("\n");
}
