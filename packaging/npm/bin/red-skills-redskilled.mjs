#!/usr/bin/env node
/**
 * red-skills-redskilled — thin shim that execs the host-scoped execution daemon
 * packaged inside this npm tarball (`dist/redskilled.bundle.min.mjs`).
 *
 * The daemon's own auto-spawn resolves the bundle directly (ADR 0130 rule 7), so
 * this bin exists for the operator paths — `redskilled serve` under a user unit,
 * `redskilled statusline` from an agent host — and for the pack contract check
 * that a shipped bundle is actually reachable rather than merely present.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "redskilled.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`red-skills-redskilled: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
