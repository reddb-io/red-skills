#!/usr/bin/env node
/**
 * rsp — thin shim that execs the neutral rsp runtime bundle packaged inside
 * this npm tarball (`dist/rsp.bundle.min.mjs`) beside its lazy core asset.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "rsp.bundle.min.mjs");
const core = join(here, "..", "dist", "rsp-core.bundle.min.mjs");
if (!existsSync(bundle) || !existsSync(core)) {
  process.stderr.write(`rsp: packaged bundle missing at ${!existsSync(bundle) ? bundle : core}\n`);
  process.exit(1);
}
const res = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
