#!/usr/bin/env node
// brain-mcp — the launch edge of `rs_brain`. Transport, argv, and nothing else.
//
// Everything this file used to do — resolve a root, open a RedDB, run the tool,
// close the store — moved to the daemon, which holds ONE brain for the whole
// host at `~/.red/brain` (ADR 0152). What is left is the shape ADR 0147 rule 2
// asks a Plugin MCP to be: publish the schemas, forward the call, render the
// answer. A host may start one per session without paying for a store.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand, type FlagSchema } from "@reddb-io/shared/args.js";
import { connectRedskillsProjectAcp } from "@reddb-io/redskilled/acp-client";
import { createRsBrainMcpServer } from "./rs-brain/index.js";

const buildInfo = readBuildInfo("brain-mcp");

async function main(): Promise<void> {
  // The connection is LAZY: `tools/list` must answer whether or not a daemon is
  // running, because a host that cannot enumerate the surface reports the whole
  // server as failed rather than the one call that needed a brain.
  const cwd = process.cwd();
  let session: ReturnType<typeof connectRedskillsProjectAcp> | undefined;
  const connected = () => {
    session ??= connectRedskillsProjectAcp({
      cwd,
      name: "RedSkills Brain MCP adapter",
      version: buildInfo.version,
    });
    return session;
  };

  const server: McpServer = createRsBrainMcpServer({
    version: buildInfo.version,
    sourcePath: () => cwd,
    invoke: async (tool, args) => await (await connected()).brain({ tool, arguments: args }),
  });

  const close = () => {
    void server.close();
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
  try {
    await connectStdio(server);
  } finally {
    if (session !== undefined) {
      try {
        (await session).close();
      } catch {
        // A failed lazy ACP connection has no live transport to close.
      }
    }
    process.removeListener("SIGINT", close);
    process.removeListener("SIGTERM", close);
  }
}

/** Serve until the host closes the pipe. Exiting earlier reads as a crash. */
async function connectStdio(server: McpServer): Promise<void> {
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    notifyClosed = resolveClosed;
  });
  server.server.onclose = notifyClosed;
  await server.connect(new StdioServerTransport());
  await closed;
}

/** The server's own flags — the same contract the `brain` CLI routes through. */
const MCP_BINARY_FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

/** Usage as a CONSTANT — the answer needs no daemon, no socket and no stdio. */
const MCP_USAGE = `Usage: brain-mcp [command] [flags]

Commands:
  serve (default)  speak MCP over stdio, forwarding to the host Brain the
                   redskilled daemon holds at ~/.red/brain
  version          print the build stamp
  help             print this usage

Flags:
  -v, --version    print the build stamp (--json for the build info)
  -h, --help       print this usage
`;

const routedMcp = routeCommand<"serve" | "version" | "help">(process.argv.slice(2), {
  commands: { serve: {}, version: {}, help: {} },
  default: "serve",
});
const mcpFlags = parseFlags(routedMcp.args, MCP_BINARY_FLAGS).values;

// Answered before any socket is dialed and before stdio is claimed: "which
// build is this?" and "what can it do?" are asked of a server that would not
// start, so neither may need one (#2878, #2918).
if (routedMcp.command === "help" || mcpFlags.help === true) {
  process.stdout.write(MCP_USAGE);
} else if (routedMcp.command === "version" || mcpFlags.version === true) {
  process.stdout.write(
    mcpFlags.json === true ? `${JSON.stringify(buildInfo)}\n` : `${renderVersion(buildInfo)}\n`,
  );
} else {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
