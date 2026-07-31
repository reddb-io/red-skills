// Harness stand-in for the shipped `dev.bundle.min.mjs` — the entry a Worker is
// born against. Since ADR 0130 Amendment 4 (#2909) that is the ONE role a
// project's bundle plays in this lane: the project registers, the daemon polls
// and births, and the argv the registration named is `run`.

import { canaryWorker } from "./canary-worker.js";

const argv = process.argv.slice(2);
if (argv[0] === "run") {
  process.exitCode = await canaryWorker();
} else {
  process.stderr.write(`canary dev entry: unknown role ${JSON.stringify(argv[0])}\n`);
  process.exitCode = 2;
}
