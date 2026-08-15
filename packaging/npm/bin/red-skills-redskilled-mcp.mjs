#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const bundle = join(here, "..", "dist", "redskilled-mcp.bundle.min.mjs");
if (!existsSync(bundle)) {
  process.stderr.write("red-skills-redskilled-mcp: packaged bundle is missing\n");
  process.exit(1);
}
const result = spawnSync(process.execPath, [bundle, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (result.signal) process.kill(process.pid, result.signal);
process.exit(result.status ?? 1);
