#!/usr/bin/env node
/**
 * red-skills-brain — thin shim that execs the `brain` runtime bundle packaged
 * inside this npm tarball (`dist/brain.bundle.min.mjs`). ADR 0091: the JS bundle
 * ships in the tarball; no postinstall download. (The Brain runtime's native
 * `red` engine binary is resolved separately by the plugin at runtime — see the
 * brain bootstrap — because per-platform native binaries cannot live in a
 * platform-independent tarball.)
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "brain.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`red-skills-brain: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const res = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
