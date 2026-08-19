#!/usr/bin/env node
// red-skills-memory — thin shim that execs the memory runtime bundle shipped in this
// package's dist/ (ADR 0091: the bundle ships in the package tarball itself).
// Every arg is forwarded verbatim to the bundle, which owns its own command surface.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "memory.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`red-skills-memory: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const res = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
