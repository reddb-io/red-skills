// host-owns-birth-guard — the ratchet that keeps the daemon the only launcher
// (issue #2851, Spec #2772, ADR 0130 rules 2 and 6).
//
// The cutover moved Worker birth out of the per-project runtime and behind the
// `redskilled` socket. Deleting the local spawn is the crossing; keeping it
// deleted is a different job, and a harder one, because **the local spawn is
// always the convenient answer**. A slice that needs one more Worker — a
// reconcile dispatch, a probe, a retry — reaches for `child_process` and nothing
// in the tree fails. The result is not a visible regression: it is a Worker no
// host admission verdict ever judged, running outside the budget, invisible to
// the host event lane, and reported by no surface. Ticket #2784 is the warning:
// it claimed exactly this criterion and left every spawn path standing, because
// the criterion was checked by inspection.
//
// **A PER-PROJECT MODULE THAT CAN CREATE A PROCESS IS A REGRESSION.** The list
// below names the modules the cutover emptied and what each one asks instead, so
// a failure teaches the route rather than only refusing the reference.
//
// Three rules, mirroring the extinction ratchet of ADR 0125:
//
//  1. THE LIST ONLY GROWS. A module added here is a module that has stopped
//     birthing Workers. Removing one is admitting a birth path back.
//  2. PROSE IS NOT A SPAWN. Comments explaining what was removed — including
//     this one — are documentation, so comments are stripped before matching.
//  3. THE SUPERVISOR IS NOT A WORKER. `spawnSupervisor` and the watchdog start
//     the project's OWN runtime process, which ADR 0130 leaves with the project;
//     they are not on this list and must not be. What the daemon owns is the
//     Worker — the process that claims a ticket and does the work.

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** One module the cutover emptied, and where its births go now. */
export interface HostOwnedBirthSite {
  /** Repo-relative path — the file that must hold no process-creation reach. */
  path: string;
  /** What it used to launch, in one noun phrase. */
  what: string;
  /** Where that launch goes instead, named concretely enough to act on. */
  replacement: string;
}

/**
 * The per-project modules that no longer birth Workers.
 *
 * `commands/supervise.ts` is the whole point: it held `spawnSlot` and
 * `spawnReconcileWorker`, the two paths that put every AFK Worker on the
 * machine. Both now state a spec and ask the host.
 */
export const HOST_OWNED_BIRTH_SITES: readonly HostOwnedBirthSite[] = [
  {
    path: "apps/dev/src/commands/supervise.ts",
    what: "the per-slot Worker spawn (`spawnSlot`) and the reconcile Worker spawn",
    replacement:
      "`runtime/redskilled-birth.ts` — `createRedskilledBirthPort(...).start(spec)`, which fails closed when no daemon answers",
  },
  {
    path: "apps/dev/src/core/supervisor/tick.ts",
    what: "the tick's respawn, half-open probe and idle un-park births",
    replacement:
      "the same birth port, reached through `deps.proc.spawnSlot`; the tick states demand and never creates a process",
  },
  {
    path: "apps/dev/src/core/supervisor/resize.ts",
    what: "the grow-to-target births",
    replacement: "the same birth port, reached through `deps.proc.spawnSlot`",
  },
  {
    path: "apps/dev/src/core/supervisor/slot-actions.ts",
    what: "the dead-slot respawn and the reconcile dispatch births",
    replacement: "the same birth port, reached through `deps.proc.spawnSlot` / `spawnReconcileWorker`",
  },
  {
    path: "apps/dev/src/core/supervisor/budget.ts",
    what: "the budget-gated Worker spawn",
    replacement: "the same birth port; the budget decides WHETHER to ask, never how to launch",
  },
];

/**
 * Every way a Node module can put a process on the machine.
 *
 * Named as reaches rather than as one `spawn` pattern, because the failure mode
 * is a slice picking a DIFFERENT api — `execFile` reads as harmless and starts a
 * process exactly the same way. The list is the whole surface of
 * `node:child_process` plus the two module specifiers that reach it.
 */
export const PROCESS_CREATION_REACHES: readonly RegExp[] = [
  /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|fork)\s*\(/,
];

/**
 * Reaches that live INSIDE a string literal — a module specifier.
 *
 * They are matched separately because the two need opposite treatment of
 * quotes: a call must be read with strings blanked out (so a message NAMING a
 * spawn is text, not a spawn), and a specifier is nothing but a string.
 */
export const PROCESS_MODULE_REACHES: readonly RegExp[] = [
  /(?:from|require\(|import\()\s*["'](?:node:)?child_process["']/,
];

/** One process-creation reach found where the host is supposed to launch. */
export interface HostOwnedBirthFinding {
  readonly path: string;
  readonly line: number;
  /** The matched text, and the line it sits on. */
  readonly match: string;
  readonly snippet: string;
  readonly what: string;
  readonly replacement: string;
}

const SNIPPET_LIMIT = 160;

/**
 * Scan every declared site for a process-creation reach. PURE over `read`.
 *
 * A site that does not exist is itself a finding rather than a silent pass: a
 * module renamed out from under this list would empty the ratchet without
 * anything failing, which is the same invisibility the ratchet exists to close.
 */
export function collectHostOwnedBirthFindings(
  root: string,
  sites: readonly HostOwnedBirthSite[] = HOST_OWNED_BIRTH_SITES,
  read: (path: string) => string | null = defaultRead,
): HostOwnedBirthFinding[] {
  const findings: HostOwnedBirthFinding[] = [];
  for (const site of sites) {
    const text = read(join(root, site.path));
    if (text === null) {
      findings.push({
        path: site.path,
        line: 0,
        match: "<missing>",
        snippet: "the declared site no longer exists at this path",
        what: site.what,
        replacement: site.replacement,
      });
      continue;
    }
    // Two readings of the same file: one with strings blanked (a CALL is code,
    // and a message naming a spawn is not one), one with strings intact (a
    // module specifier is nothing but a string). Comments are gone from both.
    const callLines = stripComments(text, { strings: "blank" }).split("\n");
    const specifierLines = stripComments(text, { strings: "keep" }).split("\n");
    for (let index = 0; index < callLines.length; index += 1) {
      const hit =
        firstMatch(callLines[index]!, PROCESS_CREATION_REACHES) ??
        firstMatch(specifierLines[index] ?? "", PROCESS_MODULE_REACHES);
      if (hit === null) continue;
      findings.push({
        path: site.path,
        line: index + 1,
        match: hit,
        snippet: (specifierLines[index] ?? callLines[index]!).trim().slice(0, SNIPPET_LIMIT),
        what: site.what,
        replacement: site.replacement,
      });
    }
  }
  return findings;
}

/**
 * The failure message the ratchet carries. A bare count would name neither the
 * line nor the route, so a worker reading its own gate output would learn only
 * that something broke. PURE.
 */
export function formatHostOwnedBirthFailure(findings: readonly HostOwnedBirthFinding[]): string {
  if (findings.length === 0) return "";
  const plural = findings.length === 1 ? "reach" : "reaches";
  return [
    `host-owns-birth ratchet (ADR 0130 rules 2 and 6): ${findings.length} process-creation ${plural}` +
      " in a per-project module the cutover emptied.",
    ...findings.map(
      (finding) => `  - ${finding.path}:${finding.line} — \`${finding.match}\` (${finding.snippet})`,
    ),
    "Routes:",
    ...[...new Set(findings.map((finding) => `  ${finding.what} → ${finding.replacement}`))],
    "A Worker this process starts itself is one no host admission verdict judged: outside the budget," +
      " absent from the host event lane, and reported by no surface. Ask the daemon instead.",
  ].join("\n");
}

function defaultRead(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function firstMatch(line: string, patterns: readonly RegExp[]): string | null {
  for (const pattern of patterns) {
    const hit = pattern.exec(line);
    if (hit !== null) return hit[0];
  }
  return null;
}

/**
 * Blank out comments, and optionally string literals, preserving line structure.
 *
 * Blanking strings is what makes an error message NAMING a spawn text rather
 * than a spawn. Keeping them is what makes a module specifier visible at all.
 * Both readings are needed, and neither is correct for both patterns.
 */
function stripComments(source: string, options: { strings: "blank" | "keep" }): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const two = source.slice(index, index + 2);
    if (two === "//") {
      while (index < source.length && source[index] !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (two === "/*") {
      while (index < source.length && source.slice(index, index + 2) !== "*/") {
        out += source[index] === "\n" ? "\n" : " ";
        index += 1;
      }
      out += "  ";
      index += 2;
      continue;
    }
    const quote = source[index]!;
    if (quote === '"' || quote === "'" || quote === "`") {
      const blank = options.strings === "blank";
      out += blank ? " " : quote;
      index += 1;
      while (index < source.length) {
        const ch = source[index]!;
        if (ch === "\\") {
          out += blank ? "  " : source.slice(index, index + 2);
          index += 2;
          continue;
        }
        out += ch === "\n" ? "\n" : blank ? " " : ch;
        index += 1;
        if (ch === quote) break;
      }
      continue;
    }
    out += source[index];
    index += 1;
  }
  return out;
}
