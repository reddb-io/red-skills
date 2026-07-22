#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode, type JsonValue } from "@reddb-io/toon";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCastleMcpTools } from "../../../packages/red-castle/src/mcp-server.js";
import { superviseCommand } from "./commands/supervise.js";
import { createDevAfkMcpDependencies } from "./mcp-adapter.js";

const buildInfo = readBuildInfo("afk");

function toon(value: unknown): string {
  return encode(JSON.parse(JSON.stringify(value ?? null)) as JsonValue, {
    keyedMapCollapse: true,
  });
}

export function createDevAfkMcpServer(): McpServer {
  const server = new McpServer({ name: "dev:afk", version: buildInfo.version });
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
    },
    handler: (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
    }>,
  ) => void;
  for (const tool of createCastleMcpTools(createDevAfkMcpDependencies())) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => ({
        content: [
          { type: "text" as const, text: toon(await tool.invoke(input)) },
        ],
      }),
    );
  }
  return server;
}

async function run(): Promise<void> {
  await createDevAfkMcpServer().connect(new StdioServerTransport());
}

export interface McpEntrypointDependencies {
  supervise(args: string[]): Promise<number>;
  connect(): Promise<void>;
}

/** Route every executable role shipped in the afk-mcp bundle. The supervisor
 * launcher deliberately re-execs the current bundle, so `__supervise` must be
 * handled before the default stdio MCP transport is opened. */
export async function main(
  argv = process.argv.slice(2),
  dependencies: McpEntrypointDependencies = {
    supervise: superviseCommand,
    connect: run,
  },
): Promise<number> {
  if (argv[0] === "__supervise") {
    return dependencies.supervise(argv.slice(1));
  }
  if (argv[0] === "--version" || argv[0] === "-v" || argv[0] === "version") {
    process.stdout.write(
      argv.includes("--json")
      ? `${JSON.stringify(buildInfo)}\n`
      : `${renderVersion(buildInfo)}\n`,
    );
    return 0;
  }
  await dependencies.connect();
  return 0;
}

const isDirectExecution =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  void main().then((exitCode) => {
    process.exitCode = exitCode;
  }).catch((error) => {
    process.stderr.write(`dev:afk MCP fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
