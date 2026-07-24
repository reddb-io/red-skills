import { execFileSync } from "node:child_process";

/**
 * ADR lifecycle governance primitives (ADR 0112).
 *
 * Archived ADRs are first-class: the INDEX bijection spans `active ∪ archived`,
 * every archived record carries a terminal status plus a successor pointer, and
 * `.red/adr/archive/` is append-only — history cannot be destroyed.
 */

/** Terminal statuses an archived ADR may declare. */
export const TERMINAL_STATUSES = ["superseded", "deprecated", "inert"] as const;

export type TerminalStatus = (typeof TERMINAL_STATUSES)[number];

export interface AdrRecord {
  /** Basename of the ADR file, e.g. `0002-retired.md`. */
  file: string;
  /** Full markdown body of the record. */
  text: string;
}

const ADR_FILENAME = /^\d{4}-.+\.md$/;

/** Sorted ADR filenames in `files` — the one ADR-listing filter. */
export function adrFiles(files: string[]): string[] {
  return files.filter((file) => ADR_FILENAME.test(file)).sort();
}

/** Sorted four-digit numbers of every ADR filename in `files`. */
export function adrNumbers(files: string[]): string[] {
  return adrFiles(files).map((file) => file.slice(0, 4));
}

/** Values appearing more than once, sorted. */
export function duplicates(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Array.from(counts.entries())
    .filter(([, count]) => count > 1)
    .map(([value]) => value)
    .sort();
}

/** Four-digit numbers documented as INDEX bullets. */
export function indexNumbers(indexText: string): string[] {
  return Array.from(indexText.matchAll(/^- \*\*(\d{4})\*\*/gm), (match) => match[1]);
}

/**
 * Numbers inside the ADR range that have no file and no INDEX mention — a gap
 * nobody documented. Pass the union of active and archived numbers.
 */
export function undocumentedGaps(numbers: string[], indexText: string): string[] {
  const parsed = numbers.map(Number);
  if (parsed.length === 0) return [];

  const present = new Set(parsed);
  const gaps: string[] = [];
  for (let number = Math.min(...parsed); number <= Math.max(...parsed); number += 1) {
    if (!present.has(number)) gaps.push(String(number).padStart(4, "0"));
  }

  return gaps.filter((number) => !indexText.includes(`**${number}**`));
}

/**
 * Governance violations for one archived record: it must declare a terminal
 * status and carry a `superseded-by:` pointer, and only `inert` records may
 * point at no successor.
 */
export function archivedRecordViolations(record: AdrRecord): string[] {
  const violations: string[] = [];
  const status = terminalStatus(record.text);
  if (!status) {
    violations.push(
      `${record.file}: \`## Status\` must declare one of ${TERMINAL_STATUSES.join(", ")}`,
    );
  }

  const pointer = successorPointer(record.text);
  if (pointer === undefined) {
    violations.push(`${record.file}: missing a \`superseded-by:\` successor pointer`);
    return violations;
  }

  const successors = pointer.match(/\d{4}/g) ?? [];
  if (successors.length === 0 && status !== "inert") {
    violations.push(
      `${record.file}: \`superseded-by:\` must name a successor ADR number for status \`${status ?? "unknown"}\``,
    );
  }

  return violations;
}

/**
 * Records whose H1 fails to identify the record by its own number. Line 1 must
 * read `# NNNN — Title`, with `NNNN` equal to the filename prefix — a renumber
 * that moves the file without moving the heading is the failure this catches.
 */
export function headingViolations(records: AdrRecord[]): string[] {
  const violations: string[] = [];

  for (const record of records) {
    const heading = record.text.split("\n", 1)[0] ?? "";
    const declared = heading.match(/^# (\d{4}) — /)?.[1];
    const expected = record.file.slice(0, 4);

    if (declared === undefined) {
      violations.push(`${record.file}: line 1 must read \`# ${expected} — Title\`, got \`${heading}\``);
    } else if (declared !== expected) {
      violations.push(`${record.file}: H1 says \`${declared}\`, filename says \`${expected}\``);
    }
  }

  return violations;
}

/** Archive paths git history deleted that the working tree no longer carries. */
export function appendOnlyViolations(present: string[], deleted: string[]): string[] {
  const kept = new Set(present);
  return Array.from(new Set(deleted.filter((path) => !kept.has(path)))).sort();
}

/**
 * Paths ever deleted from the archive lane, read from git history. Renames (a
 * `git mv` into or within the lane) are not deletions. Returns `[]` when git is
 * unavailable — a shallow or absent repository cannot prove a deletion.
 */
export function deletedArchivePaths(repoRoot: string, archiveRelDir: string): string[] {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["log", "--diff-filter=D", "--find-renames", "--pretty=format:", "--name-only", "--", archiveRelDir],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
  } catch {
    return [];
  }

  const paths = output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && line !== `${archiveRelDir}/.gitkeep`);

  return Array.from(new Set(paths)).sort();
}

function terminalStatus(text: string): TerminalStatus | undefined {
  const section = text.match(/^##\s+Status\s*$([\s\S]*?)(?=^##\s|$(?![\s\S]))/m)?.[1] ?? "";
  // The pointer line lives in the same section; it declares the successor, not the status.
  const haystack = section
    .split("\n")
    .filter((line) => !/superseded-by:/i.test(line))
    .join("\n")
    .toLowerCase();
  return TERMINAL_STATUSES.find((status) => haystack.includes(status));
}

function successorPointer(text: string): string | undefined {
  return text.match(/superseded-by:\s*(.*)$/im)?.[1]?.trim();
}
