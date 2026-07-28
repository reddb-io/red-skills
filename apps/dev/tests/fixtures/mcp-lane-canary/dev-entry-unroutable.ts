// The #2677 shape: a slot entry that CANNOT route `run`.
//
// Byte-for-byte the pre-fix failure — the supervisor boots and lives, every
// slot it spawns hits an entry that refuses the worker subcommand and dies on
// the spot, so the fleet drains nothing while `fleet_create` reports success.
// The canary must go red here; a canary that cannot catch its own motivating
// bug is not a canary.

import { canarySupervise } from "./canary-supervisor.js";

const argv = process.argv.slice(2);
if (argv[0] === "__supervise") {
  process.exitCode = await canarySupervise(argv.slice(1));
} else {
  process.stderr.write(
    `castle MCP: unroutable subcommand ${JSON.stringify(argv[0])} — ` +
      "the castle-mcp bundle routes only `__supervise` and `--version`; " +
      "worker subcommands belong to the dev entry (red-skills-dev)\n",
  );
  process.exitCode = 2;
}
