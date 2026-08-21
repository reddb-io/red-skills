// daemon-death-evidence-guard — the daemon may classify a death; it may never
// learn what the death COST (ADR 0155 §1, issue #4133, Spec #4129).
//
// ADR 0130/0144 gave the daemon exactly one thing no other authority holds —
// Worker-to-process — and deliberately withheld the tracker's nouns: the daemon
// does not know what an issue is, what a label means, or that a tracker exists.
// ADR 0155 then asked it for MORE evidence about a death: who ended the Worker,
// how sure the receipt is, and what it peaked at.
//
// **That ask is exactly the shape that erodes the boundary.** The next honest
// step after "the daemon knows the Worker was OOM-killed" is "so let the daemon
// requeue its Ticket" — one label write, and the host control plane has learned
// a project's workflow. The Spec forbade it in words; words refuse nothing.
//
// So the sweep is DISCOVERY-DRIVEN rather than a hand-kept list: any daemon
// source that names the death vocabulary is a death-evidence carrier and
// inherits the obligation the moment it lands, the way a new binary inherits
// `--version`. A carrier that names an issue number, a triage label or a tracker
// call fails, naming the file, the line and the family it tripped.
//
// Two things keep the ratchet honest about HISTORY, and both are explicit:
//
//  1. Comments are stripped before matching. Prose explaining which boundary
//     this file respects — this header, an ADR reference, the note above a
//     refusal — is the documentation of the decision, never a violation of it.
//  2. Every surviving live site is declared one at a time as an ALLOWANCE with
//     the reason it is not a violation. The only kind that exists is the opaque
//     carrier: a value the CLIENT chose, which the daemon stores and hands back
//     without reading. An allowance nothing matches fails too — an inventory
//     nobody prunes is one nobody trusts.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { stripComments } from "./extinct-source-guard.js";

/** The daemon trees swept. Repo-relative, `/`-separated. */
export const DEATH_EVIDENCE_ROOTS = ["apps/redskilled/src"] as const;

/**
 * What makes a daemon source a death-evidence carrier.
 *
 * Deliberately the vocabulary rather than a path list: `sender_class` and
 * `resolveUnitDeath` cannot spread to a new module without that module joining
 * the sweep, which is the property a hand-kept list does not have.
 */
export const DEATH_EVIDENCE_VOCABULARY =
  /\bworker-death\b|\bresolveUnitDeath\b|\bclassifyUnitDeath\b|\bsender_class\b|\bsenderClass\b|\bDeathSenderClass\b|\bUnitExitFacts\b|\bmemory_peak_bytes\b|\bmemoryPeakBytes\b/;

/** One family of tracker knowledge the daemon may not hold. */
export interface DaemonBoundaryRule {
  /** Slug used in the finding and in an allowance's `family`. */
  readonly family: string;
  /**
   * Tight by design. `project_label` is a PROJECT, not a tracker label, and the
   * daemon owns it — a rule that reddened the bare word "label" would refuse the
   * daemon's own vocabulary and be turned off within a week.
   */
  readonly pattern: RegExp;
  /** What a reader should do instead, in one line a reviewer can act on. */
  readonly instead: string;
}

export const DAEMON_BOUNDARY_RULES: readonly DaemonBoundaryRule[] = [
  {
    family: "tracker-issue",
    pattern: /\bissues?\b|\bissue[_-]?numbers?\b|\bticket[_-]?numbers?\b/i,
    instead:
      "the daemon keys death evidence by `worker_id` alone; the checkout-side sweep joins worker → claim → issue (ADR 0155 §2)",
  },
  {
    family: "triage-label",
    pattern:
      /\bready-for-agent\b|\bready-for-human\b|\bneeds-triage\b|\bblocked:[a-z-]+|\blane:[a-z-]+|\btype:(spec|bug|feature)\b|\bspec:\d/i,
    instead:
      "what a triage label MEANS stays with the checkout that wrote it; the daemon carries a selector it never parses",
  },
  {
    family: "tracker-call",
    pattern:
      /\bgh\s+(api|issue|pr)\b|\/repos\/[^"'`\s]*\/(issues|pulls|labels)|\boctokit\b|\baddLabels\b|\bremoveLabel\b|\bissue-(transition|publication)\b/i,
    instead:
      "a recovery decision is the checkout's to make and the checkout's to write; the daemon emits facts",
  },
];

/** One live site that spells a forbidden word without crossing the boundary. */
export interface DaemonBoundaryAllowance {
  /** Repo-relative path, `/`-separated. */
  readonly path: string;
  /** The `family` of the {@link DaemonBoundaryRule} this site may trip. */
  readonly family: string;
  readonly reason: string;
}

/**
 * The declared survivals. This list only ever SHRINKS.
 *
 * Growing it to admit a new daemon-side tracker reference is the regression the
 * guard exists to refuse: an entry belongs here only when the daemon is holding
 * a value the client chose, unread.
 */
// Empty, and paid for rather than waived: `lifecycle.ts` held the last entry
// because its pulse fold spelled `pulse.issue` inline. The fold moved to
// `worker-display.ts`, beside the display type it builds and the coercion it
// calls, so the daemon's lifecycle no longer names a tracker concept at all.
export const DAEMON_BOUNDARY_ALLOWANCES: readonly DaemonBoundaryAllowance[] = [];

export interface DaemonBoundaryFile {
  /** Repo-relative path, `/`-separated. */
  readonly path: string;
  readonly sourceText: string;
}

export interface DaemonBoundaryFinding {
  readonly path: string;
  /** 1-indexed line of the first offending match in the comment-stripped source. */
  readonly line: number;
  readonly family: string;
  /** The literal that tripped the rule, so a reader does not go hunting. */
  readonly match: string;
  readonly reason: string;
}

/** Every `.ts` file under `roots`, read and keyed repo-relative. */
export function readDaemonBoundaryFiles(
  repoRoot: string,
  roots: readonly string[] = DEATH_EVIDENCE_ROOTS,
): DaemonBoundaryFile[] {
  const files: DaemonBoundaryFile[] = [];
  for (const root of roots) {
    const absolute = join(repoRoot, root);
    let stats;
    try {
      stats = statSync(absolute);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;
    for (const path of walk(absolute)) {
      files.push({
        path: relative(repoRoot, path).split(sep).join("/"),
        sourceText: readFileSync(path, "utf8"),
      });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

/** True when this file carries death evidence and so inherits the boundary. PURE. */
export function carriesDeathEvidence(file: DaemonBoundaryFile): boolean {
  return DEATH_EVIDENCE_VOCABULARY.test(stripComments(file.sourceText));
}

/**
 * Every boundary crossing in the death-evidence carriers among `files`. PURE.
 *
 * One finding per file per family: a file that names an issue on six lines has
 * one problem, and six findings would bury the file that has a different one.
 */
export function auditDaemonBoundary(
  files: readonly DaemonBoundaryFile[],
  allowances: readonly DaemonBoundaryAllowance[] = DAEMON_BOUNDARY_ALLOWANCES,
  rules: readonly DaemonBoundaryRule[] = DAEMON_BOUNDARY_RULES,
): DaemonBoundaryFinding[] {
  const findings: DaemonBoundaryFinding[] = [];
  for (const file of files) {
    if (!carriesDeathEvidence(file)) continue;
    const lines = stripComments(file.sourceText).split("\n");
    for (const rule of rules) {
      if (allowances.some((allowance) => allowance.path === file.path && allowance.family === rule.family)) {
        continue;
      }
      const index = lines.findIndex((line) => rule.pattern.test(line));
      if (index === -1) continue;
      findings.push({
        path: file.path,
        line: index + 1,
        family: rule.family,
        match: lines[index]!.match(rule.pattern)![0],
        reason: rule.instead,
      });
    }
  }
  return findings;
}

/** Declared allowances whose site no longer trips their rule, or no longer exists. PURE. */
export function staleDaemonBoundaryAllowances(
  files: readonly DaemonBoundaryFile[],
  allowances: readonly DaemonBoundaryAllowance[] = DAEMON_BOUNDARY_ALLOWANCES,
  rules: readonly DaemonBoundaryRule[] = DAEMON_BOUNDARY_RULES,
): DaemonBoundaryAllowance[] {
  return allowances.filter((allowance) => {
    const file = files.find((candidate) => candidate.path === allowance.path);
    if (file == null || !carriesDeathEvidence(file)) return true;
    const rule = rules.find((candidate) => candidate.family === allowance.family);
    if (rule == null) return true;
    return !rule.pattern.test(stripComments(file.sourceText));
  });
}
