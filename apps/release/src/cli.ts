#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";
import { readChangesetQueue } from "./changeset-queue.js";
import { computeReleaseStatus, renderReleaseStatus } from "./status.js";
import type { ReleaseClock, VersionScheme } from "./version-core.js";

const FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  root: { kind: "value", coerce: String },
  "changeset-dir": { kind: "value", coerce: String },
  "current-version": { kind: "value", coerce: String },
  scheme: { kind: "value", coerce: parseScheme },
} satisfies FlagSchema;

const RELEASE_USAGE = `red-skills-release

Usage:
  red-skills-release status [--root <repository>] [--scheme semver|calver]
  red-skills-release --version
  red-skills-release --help
`;

export interface ReleaseCliIo {
  readonly cwd?: string;
  readonly clock?: ReleaseClock;
  readonly write?: (text: string) => void;
}

export function main(
  argv: readonly string[] = process.argv.slice(2),
  io: ReleaseCliIo = {},
): number {
  const { values, positionals } = parseFlags(argv, FLAGS, { unknownFlags: "error" });
  const command = positionals[0];
  const write = io.write ?? ((text: string) => process.stdout.write(text));

  if (values.version === true || command === "version") {
    write(`${renderVersion(readBuildInfo("red-skills-release"))}\n`);
    return 0;
  }
  if (values.help === true || command === "help" || command === undefined) {
    write(RELEASE_USAGE);
    return 0;
  }
  if (command === "status") {
    const repoRoot = resolve(io.cwd ?? process.cwd(), values.root ?? ".");
    const changesetDirectory = values["changeset-dir"] === undefined
      ? join(repoRoot, ".changeset")
      : resolve(repoRoot, values["changeset-dir"]);
    const currentVersion = values["current-version"] ?? readCurrentVersion(repoRoot);
    const status = computeReleaseStatus({
      queue: readChangesetQueue(changesetDirectory),
      currentVersion,
      scheme: values.scheme ?? "semver",
      clock: io.clock ?? SYSTEM_CLOCK,
    });
    write(renderReleaseStatus(status));
    return 0;
  }
  throw new Error(`unknown release command: ${command}\n\n${RELEASE_USAGE}`);
}

const SYSTEM_CLOCK: ReleaseClock = {
  today: () => {
    const now = new Date();
    return { year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 };
  },
};

function parseScheme(value: string): VersionScheme {
  if (value === "semver" || value === "calver") return value;
  throw new Error(`invalid release scheme: ${value}; expected semver or calver`);
}

function readCurrentVersion(repoRoot: string): string {
  const manifestPath = join(repoRoot, "package.json");
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new Error(`cannot read current version from package.json: ${errorMessage(error)}`);
  }
  if (!isRecord(manifest) || typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("cannot read current version: package.json has no version");
  }
  return manifest.version;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
