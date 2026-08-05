import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";
import type { PendingBumpSummary } from "./version-core.js";

export type ImpactClass = "major" | "minor" | "patch";

export interface QueuedRelease {
  readonly packageName: string;
  readonly impact: ImpactClass;
}

export interface QueuedChange {
  readonly file: string;
  readonly summary: string;
  readonly body: string;
  readonly impact: ImpactClass;
  readonly releases: readonly QueuedRelease[];
}

export interface ChangesetQueue {
  readonly changes: readonly QueuedChange[];
  readonly pending: PendingBumpSummary;
}

export class ChangesetParseError extends Error {
  readonly file: string;

  constructor(file: string, reason: string) {
    super(`${file}: ${reason}`);
    this.name = "ChangesetParseError";
    this.file = file;
  }
}

const IMPACT_RANK: Readonly<Record<ImpactClass, number>> = {
  patch: 0,
  minor: 1,
  major: 2,
};

/** Read the market-standard `.changeset/*.md` queue in deterministic filename order. */
export function readChangesetQueue(changesetDirectory: string): ChangesetQueue {
  let files: string[];
  try {
    files = readdirSync(changesetDirectory)
      .filter((file) => file.endsWith(".md") && file !== "README.md")
      .sort((left, right) => left.localeCompare(right));
  } catch (error) {
    if (isMissingDirectory(error)) return emptyQueue();
    throw error;
  }

  const changes = files.map((file) =>
    parseChangeset(file, readFileSync(join(changesetDirectory, file), "utf8"))
  );
  const pending = { major: 0, minor: 0, patch: 0 };
  for (const change of changes) pending[change.impact] += 1;
  return { changes, pending };
}

export function parseChangeset(filePath: string, source: string): QueuedChange {
  const file = basename(filePath);
  const match = /^---[\t ]*\r?\n([\s\S]*?)\r?\n---[\t ]*(?:\r?\n|$)([\s\S]*)$/.exec(
    source.replace(/^\uFEFF/, ""),
  );
  if (match === null) throw new ChangesetParseError(file, "expected YAML frontmatter between --- delimiters");

  let frontmatter: unknown;
  try {
    frontmatter = parse(match[1]!, { uniqueKeys: true });
  } catch (error) {
    throw new ChangesetParseError(file, `invalid YAML frontmatter: ${errorMessage(error)}`);
  }
  if (!isRecord(frontmatter) || Object.keys(frontmatter).length === 0) {
    throw new ChangesetParseError(file, "frontmatter must name at least one package");
  }

  const releases: QueuedRelease[] = [];
  for (const [packageName, impact] of Object.entries(frontmatter)) {
    if (packageName.trim() === "") {
      throw new ChangesetParseError(file, "frontmatter contains an empty package name");
    }
    if (!isImpactClass(impact)) {
      throw new ChangesetParseError(
        file,
        `package ${JSON.stringify(packageName)} has invalid impact ${JSON.stringify(impact)}; expected major, minor, or patch`,
      );
    }
    releases.push({ packageName, impact });
  }

  const body = match[2]!.trim();
  if (body === "") throw new ChangesetParseError(file, "markdown body must not be empty");
  const summary = body.split(/\r?\n/, 1)[0]!.trim();
  const impact = releases.reduce<ImpactClass>(
    (highest, release) => IMPACT_RANK[release.impact] > IMPACT_RANK[highest] ? release.impact : highest,
    "patch",
  );
  return { file, summary, body, impact, releases };
}

function emptyQueue(): ChangesetQueue {
  return { changes: [], pending: { major: 0, minor: 0, patch: 0 } };
}

function isImpactClass(value: unknown): value is ImpactClass {
  return value === "major" || value === "minor" || value === "patch";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingDirectory(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
