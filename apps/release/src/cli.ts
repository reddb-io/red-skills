#!/usr/bin/env node
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, type FlagSchema } from "@reddb-io/shared/args.js";

const FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
} satisfies FlagSchema;

const RELEASE_USAGE = `red-skills-release

Usage:
  red-skills-release --version
  red-skills-release --help
`;

export function main(argv: readonly string[] = process.argv.slice(2)): number {
  const { values, positionals } = parseFlags(argv, FLAGS, { unknownFlags: "error" });
  const command = positionals[0];

  if (values.version === true || command === "version") {
    process.stdout.write(`${renderVersion(readBuildInfo("red-skills-release"))}\n`);
    return 0;
  }
  if (values.help === true || command === "help" || command === undefined) {
    process.stdout.write(RELEASE_USAGE);
    return 0;
  }
  throw new Error(`unknown release command: ${command}\n\n${RELEASE_USAGE}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
