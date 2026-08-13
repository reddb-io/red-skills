#!/usr/bin/env node

import { readFile } from "node:fs/promises";

import { parseSkillPaths } from "./lib/path-briefs.mjs";

let failed = false;
for (const file of process.argv.slice(2)) {
  try {
    parseSkillPaths(await readFile(file, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${file}: ${message}\n`);
    failed = true;
  }
}

process.exitCode = failed ? 1 : 0;
