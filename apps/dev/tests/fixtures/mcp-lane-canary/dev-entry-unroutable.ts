// The #2677 shape: a Worker entry that CANNOT route `run`.
//
// Byte-for-byte the pre-fix failure — every Worker born for this project hits an
// entry that refuses the worker subcommand and dies on the spot, so the project
// drains nothing while `project_start` reports success. The canary must go red
// here; a canary that cannot catch its own motivating bug is not a canary.

const argv = process.argv.slice(2);
process.stderr.write(
  `castle MCP: unroutable subcommand ${JSON.stringify(argv[0])} — ` +
    "the castle-mcp bundle routes only `--version` and `--help`; " +
    "worker subcommands belong to the dev entry (red-skills-dev)\n",
);
process.exitCode = 2;
