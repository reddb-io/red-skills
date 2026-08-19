// domain-vocabulary-guard — the ownership nouns the live control plane may use,
// and the four it may not (issue #3897, Spec #3880).
//
// ADR 0143's per-project process was retired into **redskilled**'s Project
// control state; the standalone owner of per-project queue demand went with it;
// no Worker coordinates a project; and "Manager" was narrowed to a temporary
// Worker role rather than a service the daemon embeds. The Dev glossary already
// says all four things — and a glossary refuses nothing. The phrase comes back
// as an interface name, an error message or a tool description, it compiles, and
// the next reader learns the wrong architecture from source that passed review.
//
// **A RETIRED OWNER NAMED IN LIVE SOURCE IS AN ARCHITECTURE NOBODY DECIDED.**
// So each retired phrase is declared here beside the live owner that replaced
// it, and the ratchet (`apps/plugin-dev/tests/domain-vocabulary-guard.test.ts`) sweeps
// the control-plane trees for it.
//
// History is deliberately NOT the target. Two mechanisms keep it out of the way,
// and both are explicit rather than incidental:
//
//  1. Comments are stripped before matching. Prose describing what was removed —
//     an ADR reference in a header, a "what replaced it" note above a refusal —
//     is the migration's documentation, never a live claim of ownership.
//  2. Every surviving literal is declared, one site at a time, as an ALLOWANCE
//     carrying which kind of survival it is: `historical` (an inventory or a
//     refusal that must SPELL the retired noun to refuse it) or
//     `pending-demolition` (a live surface still standing, whose removal a named
//     entry of another ratchet already owns). An allowance nothing matches fails
//     too — an inventory nobody prunes is one nobody trusts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { stripComments } from "./extinct-source-guard.js";

/** One retired ownership phrase, paired with the live owner that answers it. */
export interface RetiredOwnershipTerm {
  /** Canonical spelling, as the Dev glossary writes it. */
  readonly term: string;
  /**
   * Case-insensitive and separator-tolerant, so the identifier
   * (`CastleResident`), the kebab kind (`castle-resident`) and the prose
   * spelling all answer to one rule.
   */
  readonly pattern: RegExp;
  /** What a reader should say instead — the live owner, in glossary words. */
  readonly liveOwner: string;
  /** Why the phrase was retired, in one line a reviewer can act on. */
  readonly why: string;
}

/** Why one file may still spell a retired phrase. */
export type DomainVocabularyAllowanceKind = "historical" | "pending-demolition";

/** One declared survival, keyed by file and term. */
export interface DomainVocabularyAllowance {
  /** Repo-relative path, `/`-separated. */
  readonly path: string;
  /** The `term` of the `RetiredOwnershipTerm` this file may spell. */
  readonly term: string;
  readonly kind: DomainVocabularyAllowanceKind;
  /** The ratchet entry or inventory that owns this survival, when one does. */
  readonly ownedBy?: string;
  readonly reason: string;
}

/**
 * How a swept file hides its history. `source` carries `//` and block comments;
 * `prose` is Markdown, where the only comment is `<!-- … -->` and where a `//`
 * strip would swallow everything after the first URL on a line.
 */
export type DomainVocabularyFileKind = "source" | "prose";

export interface DomainVocabularyFile {
  /** Repo-relative path, `/`-separated. */
  readonly path: string;
  readonly sourceText: string;
  /** Defaults to `source`, the shape every root carried before skills joined. */
  readonly kind?: DomainVocabularyFileKind;
}

export interface DomainVocabularyFinding {
  readonly path: string;
  readonly line: number;
  readonly term: string;
  readonly reason: string;
}

/**
 * The trees that carry live control-plane ownership language: the dev runtime
 * and its `rs_dev` schemas, the daemon, the Worker body, and the shared wire the
 * two speak across. A doc tree is deliberately absent — ADRs, CHANGELOGs and the
 * glossary's own RETIRED entries are the record of the retirement, and a record
 * that may not name what it records is not a record.
 */
export const DOMAIN_VOCABULARY_ROOTS = [
  "apps/plugin-dev/src",
  "apps/redskilled/src",
  "packages/worker/src",
  "packages/protocol-acp",
] as const;

/**
 * The SHIPPED skills, swept for the same four phrases (#4005 follow-up).
 *
 * Source was never where an operator learned the architecture — a skill is.
 * `red-doctor` told a reader that "ADR 0143's one versioned Castle resident per
 * canonical project owns engine state" long after the daemon absorbed it, and
 * the liveness doc still credited a reaper to the Demand producer: both compiled
 * nothing, passed every guard, and taught the wrong owner to every agent that
 * read them. **A skill is source for the reader who has no source.**
 *
 * Generated mirrors (`packaging/pi/*\/skills`) are deliberately absent: they are
 * projections of these trees, and reddening a projection teaches the next worker
 * to edit the copy.
 */
export const DOMAIN_VOCABULARY_SKILL_ROOTS = [
  "plugins/dev/skills",
  "plugins/memory/skills",
  "plugins/brain/skills",
] as const;

const SKIP_DIRS = new Set(["node_modules", "dist", "dist-bundle", "generated", ".turbo", "tests"]);
const SOURCE_SUFFIXES = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const PROSE_SUFFIXES = [".md"];

/** Markdown's only comment. Prose describing a retirement is documentation. */
function stripProseComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, (match) => match.replace(/[^\n]/g, " "));
}

function strippedText(file: DomainVocabularyFile): string {
  return file.kind === "prose" ? stripProseComments(file.sourceText) : stripComments(file.sourceText);
}

/**
 * The four retired ownership phrases, in the order the Dev glossary retires them.
 *
 * Each pattern names an OWNERSHIP claim, never a bare word that survives
 * elsewhere: `demand` alone is what a queue has, `manager` alone is the operator
 * Skill, and `resident` alone is rsp's own vocabulary that ADR 0147 keeps. Only
 * the two-word claim is reddened.
 */
export const RETIRED_OWNERSHIP_TERMS: readonly RetiredOwnershipTerm[] = [
  {
    term: "Castle resident",
    pattern: /castle[\s_-]*resident/i,
    liveOwner: "redskilled's Project control state",
    why:
      "ADR 0143's per-project process boundary was discarded: workflow truth, project registration," +
      " GitHub adapters and the background belts are daemon state, not a second resident process",
  },
  {
    term: "Demand producer",
    pattern: /demand[\s_-]*producer/i,
    liveOwner: "redskilled's Project control state",
    why:
      "queue sampling, selector policy, claims, elastic target resolution and continued consumption" +
      " belong to the project's partition inside the daemon, so there is no producer process to rendezvous with",
  },
  {
    term: "Project coordinator Worker",
    pattern: /project[\s_-]*coordinator/i,
    liveOwner: "redskilled's Project control state, requesting disposable Workers",
    why:
      "a Worker is cattle: it holds no durable project-control authority, so a Worker that coordinates" +
      " a project is a pet process the daemon never admitted",
  },
  {
    term: "Manager service",
    pattern: /manager[\s_-]*service/i,
    liveOwner: "the operator-facing Manager Skill, liaison over the existing workflows",
    why:
      "`Manager` names at most a temporary Worker role, never a third architectural player, a service" +
      " in the daemon, or a model runtime embedded beside it",
  },
] as const;

/**
 * Every live site that still spells a retired phrase, with the kind of survival
 * it is. The list only ever SHRINKS: adding an entry to admit a new reference is
 * the regression this guard exists to refuse.
 */
export const DOMAIN_VOCABULARY_ALLOWANCES: readonly DomainVocabularyAllowance[] = [
  {
    path: "apps/plugin-dev/src/core/domain-vocabulary-guard.ts",
    term: "Castle resident",
    kind: "historical",
    reason: "the declaration itself — a guard must spell the phrase it refuses",
  },
  {
    path: "apps/plugin-dev/src/core/domain-vocabulary-guard.ts",
    term: "Demand producer",
    kind: "historical",
    reason: "the declaration itself — a guard must spell the phrase it refuses",
  },
  {
    path: "apps/plugin-dev/src/core/domain-vocabulary-guard.ts",
    term: "Project coordinator Worker",
    kind: "historical",
    reason: "the declaration itself — a guard must spell the phrase it refuses",
  },
  {
    path: "apps/plugin-dev/src/core/domain-vocabulary-guard.ts",
    term: "Manager service",
    kind: "historical",
    reason: "the declaration itself — a guard must spell the phrase it refuses",
  },
  {
    path: "apps/plugin-dev/src/core/extinct-execution-chain.ts",
    term: "Castle resident",
    kind: "historical",
    ownedBy: "EXECUTION_CHAIN_SOURCES, the two retired-resident entries",
    reason: "the extinction inventory spells the retired surface so its own ratchet can refuse it",
  },
  {
    path: "apps/plugin-dev/src/core/extinct-source-guard.ts",
    term: "Demand producer",
    kind: "historical",
    ownedBy: "EXTINCT_SOURCES named-fleet inventory",
    reason: "the ADR 0130 inventory states what the removed fleet vocabulary used to partition",
  },
  {
    path: "apps/plugin-dev/src/mcp-tools/extinct-nouns.ts",
    term: "Demand producer",
    kind: "historical",
    reason: "the refusal an operator reads must say which noun was removed and what replaced it",
  },
  {
    path: "apps/plugin-dev/src/runtime/redskilled-birth.ts",
    term: "Demand producer",
    kind: "historical",
    reason: "the birth refusal states what is NOT launched when the daemon cannot be reached",
  },
  {
    path: "apps/redskilled/src/resource-incidents.ts",
    term: "Castle resident",
    kind: "pending-demolition",
    ownedBy: "EXECUTION_CHAIN_SOURCES, the retired-resident resource-kind entry",
    reason:
      "the retired resource kind is still a live union member of the daemon's incident store;" +
      " ADR 0147's inventory carries its count, and only that count lowering removes it",
  },
] as const;

/**
 * Every retired phrase spelled in live, non-comment source without a declared
 * allowance. PURE.
 */
export function auditDomainVocabulary(
  files: readonly DomainVocabularyFile[],
  terms: readonly RetiredOwnershipTerm[] = RETIRED_OWNERSHIP_TERMS,
  allowances: readonly DomainVocabularyAllowance[] = DOMAIN_VOCABULARY_ALLOWANCES,
): DomainVocabularyFinding[] {
  const allowed = new Set(allowances.map((entry) => `${entry.path} ${entry.term}`));
  const findings: DomainVocabularyFinding[] = [];
  for (const file of files) {
    const lines = strippedText(file).split("\n");
    for (const term of terms) {
      if (allowed.has(`${file.path} ${term.term}`)) continue;
      lines.forEach((text, index) => {
        if (!term.pattern.test(text)) return;
        findings.push({
          path: file.path,
          line: index + 1,
          term: term.term,
          reason:
            `${file.path}:${index + 1} claims the retired owner "${term.term}". Say ${term.liveOwner}` +
            ` instead — ${term.why}.`,
        });
      });
    }
  }
  return findings;
}

/**
 * Declared allowances whose site no longer spells the phrase — the prune
 * direction. An allowance kept past its cause reads as permission nobody asked
 * for, and quietly re-opens the door it was written to narrow. PURE.
 */
export function staleDomainVocabularyAllowances(
  files: readonly DomainVocabularyFile[],
  terms: readonly RetiredOwnershipTerm[] = RETIRED_OWNERSHIP_TERMS,
  allowances: readonly DomainVocabularyAllowance[] = DOMAIN_VOCABULARY_ALLOWANCES,
): string[] {
  const byPath = new Map(files.map((file) => [file.path, strippedText(file)] as const));
  const byTerm = new Map(terms.map((term) => [term.term, term] as const));
  const stale: string[] = [];
  for (const allowance of allowances) {
    const term = byTerm.get(allowance.term);
    if (!term) {
      stale.push(`${allowance.path}: allowance names "${allowance.term}", which is not a declared term`);
      continue;
    }
    const source = byPath.get(allowance.path);
    if (source === undefined) {
      stale.push(`${allowance.path}: allowance points at a file the sweep does not reach`);
      continue;
    }
    if (!term.pattern.test(source)) {
      stale.push(`${allowance.path}: allowance for "${allowance.term}" no longer matches — delete it`);
    }
  }
  return stale;
}

/**
 * Every swept source file, read from disk. Exported so the suite can assert the
 * sweep is non-empty: a walker that reaches nothing is green for the wrong
 * reason, which is what makes a ratchet decorative.
 */
export function readDomainVocabularyFiles(
  root: string,
  roots: readonly string[] = DOMAIN_VOCABULARY_ROOTS,
  skillRoots: readonly string[] = DOMAIN_VOCABULARY_SKILL_ROOTS,
): DomainVocabularyFile[] {
  const files: DomainVocabularyFile[] = [];
  for (const sourceRoot of roots) {
    const absolute = join(root, sourceRoot);
    if (!isDirectory(absolute)) continue;
    collect(root, absolute, files, "source");
  }
  for (const skillRoot of skillRoots) {
    const absolute = join(root, skillRoot);
    if (!isDirectory(absolute)) continue;
    collect(root, absolute, files, "prose");
  }
  return files;
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collect(root: string, dir: string, out: DomainVocabularyFile[], kind: DomainVocabularyFileKind): void {
  const suffixes = kind === "prose" ? PROSE_SUFFIXES : SOURCE_SUFFIXES;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) collect(root, path, out, kind);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    if (!suffixes.some((suffix) => entry.name.endsWith(suffix))) continue;
    out.push({
      path: relative(root, path).split(sep).join("/"),
      sourceText: readFileSync(path, "utf8"),
      kind,
    });
  }
}
