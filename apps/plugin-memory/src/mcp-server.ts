#!/usr/bin/env node
// memory-mcp — the launch edge of `rs_memory`. Transport, argv, and nothing else.
//
// Everything this file used to reach — a config read, a store URI, an open
// RedDB, the tool bodies, a close on SIGTERM — moved to the daemon, which holds
// one memory per Project (ADR 0152). What is left is the shape ADR 0147 rule 2
// asks a Plugin MCP to be: publish the schemas, forward the call, render the
// answer. A host may start one per session without paying for a store.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { readBuildInfo, renderVersion } from "@reddb-io/build-info";
import { parseFlags, routeCommand, type FlagSchema } from "@reddb-io/shared/args.js";
import { connectRedskillsProjectAcp } from "@reddb-io/redskilled/acp-client";
import { RED_MODE_ENV } from "@reddb-io/shared/working-mode.js";
import { createRsMemoryMcpServer } from "./rs-memory/index.js";

const buildInfo = readBuildInfo("memory-mcp");

async function main(): Promise<void> {
  // The connection is LAZY: listing must answer whether or not a daemon is
  // running, because a host that cannot enumerate the surface reports the whole
  // server as failed rather than the one call that needed a store.
  const cwd = process.cwd();
  let session: ReturnType<typeof connectRedskillsProjectAcp> | undefined;
  const connected = () => {
    session ??= connectRedskillsProjectAcp({
      cwd,
      name: "RedSkills Memory MCP adapter",
      version: buildInfo.version,
    });
    return session;
  };

  const server: Server = createRsMemoryMcpServer({
    version: buildInfo.version,
    // The one fact this process holds and the daemon does not: whether a Worker
    // is what is asking (ADR 0150 §2). Read here, at the edge, so the adapter
    // body stays a forwarder with no environment of its own.
    mode: () => process.env[RED_MODE_ENV]?.trim() || undefined,
    invoke: async (call) => await (await connected()).memory(call),
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
async function connectStdio(server: Server): Promise<void> {
  let notifyClosed!: () => void;
  const closed = new Promise<void>((resolveClosed) => {
    notifyClosed = resolveClosed;
  });
  server.onclose = notifyClosed;
  await server.connect(new StdioServerTransport());
  await closed;
}

/** The server's own flags — the same contract the `memory` CLI routes through. */
const MCP_BINARY_FLAGS = {
  version: { kind: "boolean", aliases: ["v"] },
  help: { kind: "boolean", aliases: ["h"] },
  json: { kind: "boolean" },
} satisfies FlagSchema;

/** Usage as a CONSTANT — the answer needs no daemon, no socket and no stdio. */
const MCP_USAGE = `Usage: memory-mcp [command] [flags]

Commands:
  serve (default)  speak MCP over stdio, forwarding to this Project's memory —
                   the store the redskilled daemon holds at
                   ~/.red/memory/<project-id>, or this checkout's ./.red/memory
                   when the repository opted in and no RED_MODE is exported
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
