#!/usr/bin/env node
/**
 * red-skills-dev — thin shim that execs the `dev` runtime bundle.
 *
 * **The bundle is not in this package any more, and the shim still is.** ADR
 * 0146 moved every per-plugin runtime bundle into `@reddb-io/red-skills-<plugin>`
 * and left this core package carrying the bin surface, so a shim that looks only
 * beside itself finds nothing: 3.20.0 and 3.21.0 both publish a `dist/` without
 * `dev.bundle.min.mjs`, and every Worker the daemon birthed died on
 * `packaged bundle missing` before it could claim a Ticket.
 *
 * So the lookup is ordered rather than fixed: this package's own `dist/` first,
 * because an older install still carries the bundle there, then the plugin
 * package that owns it now. Every arg is forwarded verbatim to the bundle, which
 * owns its own command surface.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PLUGIN_PACKAGE = "@reddb-io/red-skills-dev";
const BUNDLE = "dev.bundle.min.mjs";

/** Where the bundle can be, newest layout last so a stale copy never wins. */
function resolveBundle() {
  const local = join(here, "..", "dist", BUNDLE);
  if (existsSync(local)) return { path: local, from: "this package" };
  // `createRequire` resolves through node's own algorithm, so the plugin package
  // is found whether it sits beside this one in a shared `node_modules` or is
  // nested under it — the two shapes npx and pnpm produce.
  const require = createRequire(import.meta.url);
  try {
    const path = require.resolve(`${PLUGIN_PACKAGE}/dist/${BUNDLE}`);
    if (existsSync(path)) return { path, from: PLUGIN_PACKAGE };
  } catch {
    /* fall through to the reported failure below */
  }
  return null;
}

const found = resolveBundle();
if (!found) {
  process.stderr.write(
    `red-skills-dev: the dev runtime bundle is not installed.\n` +
      `  looked in this package: ${join(here, "..", "dist", BUNDLE)}\n` +
      `  looked in the plugin package that owns it (ADR 0146): ${PLUGIN_PACKAGE}/dist/${BUNDLE}\n` +
      `  install it with: npm i -g ${PLUGIN_PACKAGE}\n`,
  );
  process.exit(1);
}
const res = spawnSync(process.execPath, [found.path, ...process.argv.slice(2)], { stdio: "inherit" });
if (res.signal) process.kill(process.pid, res.signal);
process.exit(res.status ?? 1);
