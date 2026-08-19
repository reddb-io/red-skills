/**
 * ADR 0136 ownership ratchets.
 *
 * Consolidating code removes today's duplicates. This guard holds the deletion:
 * a source file that grows the semantic fingerprint of a second custody
 * re-queuer, blocker parser, or requeue applier fails the gate, as does any
 * return of the mutable classification hook. Callers of the canonical APIs are
 * intentionally clean; it is the rival implementation shape that is refused.
 */
import { stripComments, readExtinctSourceFiles } from "./extinct-source-guard.js";

export type CustodyVerdictParkRule =
  | "custody-requeuer"
  | "blocker-parser"
  | "requeue-applier"
  | "classification-hook";

export interface CustodyVerdictParkFile {
  readonly relativePath: string;
  readonly sourceText: string;
}

export interface CustodyVerdictParkFinding {
  readonly rule: CustodyVerdictParkRule;
  readonly kind: "duplicate" | "forbidden" | "owner-missing";
  readonly relativePath: string;
  readonly line: number;
  readonly snippet: string;
}

export const ADR_0136_OWNERS = {
  "custody-requeuer": "apps/plugin-dev/src/core/queue-custodian.ts",
  "blocker-parser": "apps/plugin-dev/src/core/blocker-state.ts",
  "requeue-applier": "apps/plugin-dev/src/core/requeue.ts",
} as const satisfies Record<Exclude<CustodyVerdictParkRule, "classification-hook">, string>;

interface OwnershipRule {
  readonly id: CustodyVerdictParkRule;
  readonly owner?: string;
  readonly markers: readonly RegExp[];
  readonly route: string;
}

/**
 * A fingerprint uses the conjunction of several effects, not a convenient
 * function name. Importing and calling the owner therefore stays clean, while
 * copying the transition's work trips the ratchet even under a new name.
 */
const OWNERSHIP_RULES: readonly OwnershipRule[] = [
  {
    id: "custody-requeuer",
    owner: ADR_0136_OWNERS["custody-requeuer"],
    markers: [
      /\bsemanticBounces\b/,
      /\.\s*adoptBranch\s*\(/,
      /\.\s*readyForAgent\s*\(/,
    ],
    route: "call `repairQueueCustody`; the Queue Custodian alone owns semantic bounce history and branch adoption",
  },
  {
    id: "blocker-parser",
    owner: ADR_0136_OWNERS["blocker-parser"],
    markers: [
      /red:blocker-state v1/,
      /(?:\bfields\.status\s*!==?\s*["']blocked["']|\^status:\\s\*blocked)/,
    ],
    route: "call `parseCurrentBlocker`; blocker-state is the Park's sole parser, writer, and clearer",
  },
  {
    id: "requeue-applier",
    owner: ADR_0136_OWNERS["requeue-applier"],
    markers: [
      /\.\s*verifyBaseFreshness\s*\(/,
      /\.\s*releaseClaims\s*\(/,
      /\.\s*editBody\s*\(/,
      /\.\s*editLabels\s*\(/,
    ],
    route: "call `applyRequeue` with machine or human authority; it is the Park's one requeue door",
  },
  {
    id: "classification-hook",
    markers: [/\bon_feedback_classify\b|["']RED_AFK_FEEDBACK_CLASS["']/],
    route:
      "call the pure `decideVerdict`; declare `plugins.dev.afk.validation.subsecond_failures_are_branch_fault` for the operator escape",
  },
];

const GUARD_PATHS = new Set([
  "apps/plugin-dev/src/core/custody-verdict-park-guard.ts",
  // The older extinction inventory names the deleted hook to guard it too; an
  // inventory literal is not a runtime hook implementation.
  "apps/plugin-dev/src/core/extinct-source-guard.ts",
]);

export function readCustodyVerdictParkFiles(root: string): CustodyVerdictParkFile[] {
  return readExtinctSourceFiles(root);
}

export function collectCustodyVerdictParkFindings(root: string): CustodyVerdictParkFinding[] {
  return collectCustodyVerdictParkFindingsFromFiles(readCustodyVerdictParkFiles(root));
}

export function collectCustodyVerdictParkFindingsFromFiles(
  files: readonly CustodyVerdictParkFile[],
): CustodyVerdictParkFinding[] {
  const eligible = files.filter((file) => !GUARD_PATHS.has(file.relativePath));
  const findings: CustodyVerdictParkFinding[] = [];

  for (const rule of OWNERSHIP_RULES) {
    if (rule.owner !== undefined) {
      const owner = eligible.find((file) => file.relativePath === rule.owner);
      if (owner === undefined || !matchesRule(owner.sourceText, rule)) {
        findings.push({
          rule: rule.id,
          kind: "owner-missing",
          relativePath: rule.owner,
          line: 0,
          snippet: owner === undefined
            ? "the declared owner file is missing"
            : "the declared owner no longer carries the guarded implementation",
        });
      }
    }

    for (const file of eligible) {
      if (file.relativePath === rule.owner || !matchesRule(file.sourceText, rule)) continue;
      const hit = firstMarker(file.sourceText, rule.markers);
      findings.push({
        rule: rule.id,
        kind: rule.owner === undefined ? "forbidden" : "duplicate",
        relativePath: file.relativePath,
        line: hit.line,
        snippet: hit.snippet,
      });
    }
  }

  return findings.sort(
    (left, right) => left.relativePath.localeCompare(right.relativePath) || left.rule.localeCompare(right.rule),
  );
}

export function formatCustodyVerdictParkFailure(
  findings: readonly CustodyVerdictParkFinding[],
): string {
  if (findings.length === 0) return "";
  const routes = [...new Set(findings.map((finding) => {
    const rule = OWNERSHIP_RULES.find((candidate) => candidate.id === finding.rule)!;
    return `  ${finding.rule} → ${rule.route}`;
  }))];
  return [
    `ADR 0136 ownership ratchet: ${findings.length} rival or resurrected implementation${findings.length === 1 ? "" : "s"}.`,
    ...findings.map(
      (finding) =>
        `  - ${finding.rule} ${finding.kind} at ${finding.relativePath}:${finding.line} (${finding.snippet})`,
    ),
    "Routes:",
    ...routes,
    "Landing hands custody off and ends; Verdict has no mutation hook; the Park has one requeue door.",
  ].join("\n");
}

function matchesRule(sourceText: string, rule: OwnershipRule): boolean {
  const code = stripComments(sourceText);
  return rule.markers.every((marker) => test(marker, code));
}

function test(pattern: RegExp, text: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text);
}

function firstMarker(
  sourceText: string,
  markers: readonly RegExp[],
): { line: number; snippet: string } {
  const lines = stripComments(sourceText).split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!markers.some((marker) => test(marker, line))) continue;
    return { line: index + 1, snippet: line.trim().slice(0, 160) };
  }
  return { line: 0, snippet: "matched implementation fingerprint" };
}
