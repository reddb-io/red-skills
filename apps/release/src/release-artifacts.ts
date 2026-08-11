import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { encode, type JsonValue } from "@reddb-io/toon";
import type { ImpactClass, QueuedChange } from "./changeset-queue.js";

export interface AttributedReleaseChange extends QueuedChange {
  readonly authors: readonly string[];
  readonly pullRequests: readonly number[];
}

export interface ReleaseArtifactInput {
  readonly version: string;
  readonly date: string;
  readonly changes: readonly AttributedReleaseChange[];
}

export interface WriteReleaseArtifactsInput extends ReleaseArtifactInput {
  readonly outputDirectory: string;
}

export interface ReleaseManifestChange {
  file: string;
  summary: string;
  body: string;
  packages: string[];
  authors: string[];
  pullRequests: number[];
}

export interface ReleaseManifest {
  version: string;
  date: string;
  changes: {
    major: ReleaseManifestChange[];
    minor: ReleaseManifestChange[];
    patch: ReleaseManifestChange[];
  };
  authors: string[];
  pullRequests: number[];
}

export interface RenderedReleaseArtifacts {
  readonly manifest: ReleaseManifest;
  readonly notes: string;
  readonly json: string;
  readonly toon: string;
}

export interface WrittenReleaseArtifacts {
  readonly directory: string;
  readonly notesPath: string;
  readonly jsonManifestPath: string;
  readonly toonManifestPath: string;
}

const IMPACT_ORDER: readonly ImpactClass[] = ["major", "minor", "patch"];
const IMPACT_HEADINGS: Readonly<Record<ImpactClass, string>> = {
  major: "Major (breaking changes)",
  minor: "Minor changes",
  patch: "Patch changes",
};

/** Render every public release artifact from one normalized manifest value. */
export function renderReleaseArtifacts(input: ReleaseArtifactInput): RenderedReleaseArtifacts {
  const manifest = buildReleaseManifest(input);
  return {
    manifest,
    notes: renderReleaseNotes(manifest),
    json: `${JSON.stringify(manifest, null, 2)}\n`,
    toon: withTrailingNewline(encode(manifest as unknown as JsonValue)),
  };
}

/**
 * Publish the notes and both manifests as one directory rename. The destination
 * must be new: callers never observe a subset of the three release artifacts.
 */
export function writeReleaseArtifacts(input: WriteReleaseArtifactsInput): WrittenReleaseArtifacts {
  const rendered = renderReleaseArtifacts(input);
  const directory = resolve(input.outputDirectory);
  if (existsSync(directory)) {
    throw new Error(`release artifact directory already exists: ${input.outputDirectory}`);
  }

  const parent = dirname(directory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(join(parent, `.${basename(directory)}-`));
  try {
    writeFileSync(join(staging, "release-notes.md"), rendered.notes, "utf8");
    writeFileSync(
      join(staging, "release-manifest.json"),
      `${JSON.stringify(rendered.manifest, null, 2)}\n`,
      "utf8",
    );
    writeFileSync(join(staging, "release-manifest.toon"), rendered.toon, "utf8");
    renameSync(staging, directory);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw error;
  }

  return {
    directory,
    notesPath: join(directory, "release-notes.md"),
    jsonManifestPath: join(directory, "release-manifest.json"),
    toonManifestPath: join(directory, "release-manifest.toon"),
  };
}

export function buildReleaseManifest(input: ReleaseArtifactInput): ReleaseManifest {
  if (input.version.trim() === "") throw new Error("release version must not be empty");
  assertIsoDate(input.date);

  const changes: ReleaseManifest["changes"] = { major: [], minor: [], patch: [] };
  for (const change of [...input.changes].sort(compareChanges)) {
    const authors = sortedUniqueStrings(change.authors, `${change.file} author`);
    const pullRequests = sortedUniquePullRequests(change.pullRequests, change.file);
    const packages = sortedUniqueStrings(
      change.releases.map((release) => release.packageName),
      `${change.file} package`,
    );
    changes[change.impact].push({
      file: change.file,
      summary: change.summary,
      body: change.body,
      packages,
      authors,
      pullRequests,
    });
  }

  return {
    version: input.version,
    date: input.date,
    changes,
    authors: sortedUniqueStrings(
      input.changes.flatMap((change) => change.authors),
      "release author",
    ),
    pullRequests: sortedUniquePullRequests(
      input.changes.flatMap((change) => change.pullRequests),
      "release",
    ),
  };
}

export function renderReleaseNotes(manifest: ReleaseManifest): string {
  const lines = [`# Release ${manifest.version}`, "", `Released ${manifest.date}.`];
  for (const impact of IMPACT_ORDER) {
    const changes = manifest.changes[impact];
    if (changes.length === 0) continue;
    lines.push("", `## ${IMPACT_HEADINGS[impact]}`, "");
    for (const change of changes) {
      const attribution = [
        change.pullRequests.map((pullRequest) => `#${pullRequest}`).join(", "),
        change.authors.join(", "),
      ].filter((value) => value !== "").join(" — ");
      lines.push(`- **${change.summary}**${attribution === "" ? "" : ` (${attribution})`}`);

      const details = bodyDetails(change.body, change.summary);
      if (details !== "") lines.push("", ...details.split("\n").map((line) => `  ${line}`));
    }
  }
  return `${lines.join("\n")}\n`;
}

function compareChanges(left: AttributedReleaseChange, right: AttributedReleaseChange): number {
  const impact = IMPACT_ORDER.indexOf(left.impact) - IMPACT_ORDER.indexOf(right.impact);
  return impact === 0 ? left.file.localeCompare(right.file) : impact;
}

function sortedUniqueStrings(values: readonly string[], label: string): string[] {
  const normalized = values.map((value) => value.trim());
  if (normalized.some((value) => value === "")) throw new Error(`${label} must not be empty`);
  return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

function sortedUniquePullRequests(values: readonly number[], label: string): number[] {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 1)) {
    throw new Error(`${label} pull request numbers must be positive safe integers`);
  }
  return [...new Set(values)].sort((left, right) => left - right);
}

function bodyDetails(body: string, summary: string): string {
  const trimmed = body.trim();
  if (trimmed === summary) return "";
  if (!trimmed.startsWith(summary)) return trimmed;
  return trimmed.slice(summary.length).trim();
}

function assertIsoDate(value: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`invalid release date: ${value}`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new Error(`invalid release date: ${value}`);
  }
}

function withTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}
