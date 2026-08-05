#!/usr/bin/env node
/**
 * red-skills-release — thin shim that execs the single-file release engine
 * packaged inside this npm tarball. The same bytes are copied into consumer
 * repositories when release.execution is `vendored`.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "release.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`red-skills-release: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
