#!/usr/bin/env node
/**
 * redskilled — the daemon under its OWN name, beside `red-skills-redskilled`
 * (issue #2960). Same tarball, same `dist/redskilled.bundle.min.mjs`, same argv:
 * an ergonomic alias, never a second dispatch contract.
 *
 * **The version-pinned form stays canonical** — `npx -y -p @reddb-io/red-skills@<version> redskilled`.
 * ADR 0091 made it so because a bare name resolved off `PATH` can pick up a
 * different installation than the one intended (PR #2465), and adding a bare bin
 * does not weaken that: it shortens the name, not the pin.
 *
 * `rsp` already ships bare from this same map. A name the product owns is a name
 * this repository publishes.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "redskilled.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write(`redskilled: packaged bundle missing at ${bundle}\n`);
  process.exit(1);
}
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
