// Harness stand-in for the shipped `dev.bundle.min.mjs` — the entry a slot is
// spawned against. It routes BOTH roles the fleet needs: `__supervise` for the
// supervisor the MCP lane launches, and `run` for the worker each slot becomes.

import { canarySupervise } from "./canary-supervisor.js";
import { canaryWorker } from "./canary-worker.js";

const argv = process.argv.slice(2);
if (argv[0] === "__supervise") {
  process.exitCode = await canarySupervise(argv.slice(1));
} else if (argv[0] === "run") {
  process.exitCode = await canaryWorker();
} else {
  process.stderr.write(`canary dev entry: unknown role ${JSON.stringify(argv[0])}\n`);
  process.exitCode = 2;
}
