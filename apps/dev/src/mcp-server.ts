#!/usr/bin/env node
import { renderVersion, readBuildInfo } from "@reddb-io/build-info";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { encode, type JsonValue } from "@reddb-io/toon";
import { createCastleMcpTools } from "../../../packages/red-castle/src/mcp-server.js";
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

if (
  process.argv[2] === "--version" ||
  process.argv[2] === "-v" ||
  process.argv[2] === "version"
) {
  process.stdout.write(
    process.argv.includes("--json")
      ? `${JSON.stringify(buildInfo)}\n`
      : `${renderVersion(buildInfo)}\n`,
  );
} else {
  run().catch((error) => {
    process.stderr.write(`dev:afk MCP fatal: ${String(error)}\n`);
    process.exitCode = 1;
  });
}
