#!/usr/bin/env node
/**
 * red-skills-code-nav — thin shim that execs the `code-nav` MCP runtime bundle
 * packaged inside this npm tarball (`dist/code-nav.bundle.min.mjs`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "code-nav.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`red-skills-code-nav: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const res = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
