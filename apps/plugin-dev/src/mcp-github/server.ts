// The `rs_github` MCP server: a stateless forwarder over the daemon's gateway.
//
// It exists as its OWN server rather than as a tool of `rs_dev` because the
// forge is not the dev plugin's concern — memory, brain and any later plugin
// reach the same Project credential through the same daemon, and a tool that
// lived inside one plugin's MCP would make the other plugins depend on that
// plugin to ask a question about their own repository (ADR 0147 rule 2).
//
// The process owns nothing worth owning: no credential, no cache, no client,
// no fallback. Its whole body is "shape the envelope, hand it to the daemon,
// render the answer".
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encodeRedskilledMcpToon } from "../mcp-toon.js";
import {
  createRsGithubTools,
  RS_GITHUB_MCP_SERVER_NAME,
  type RsGithubTool,
} from "./tool.js";

/** Forward one daemon method. The server never learns how this is carried. */
export type RsGithubInvoke = (
  method: string,
  params: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Wrap the tool's flat input in the envelope the daemon method takes.
 *
 * The tool is flat because that is how an operator thinks about a request; the
 * wire nests it under `request` because the params object is where a caller
 * would otherwise be tempted to name a Project or a credential profile, and a
 * single declared key leaves nowhere to put one.
 */
export function rsGithubRequestParams(
  input: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    request: {
      method: input.method,
      path: input.path,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(input.headers === undefined ? {} : { headers: input.headers }),
    },
  };
}

export interface CreateRsGithubMcpServerOptions {
  readonly version: string;
  readonly invoke: RsGithubInvoke;
  /** Overridable only so a test can publish the surface without a daemon. */
  readonly tools?: readonly RsGithubTool[];
}

/** Publish the `rs_github` surface over an already-chosen MCP transport. */
export function createRsGithubMcpServer(options: CreateRsGithubMcpServerOptions): McpServer {
  const server = new McpServer({
    name: RS_GITHUB_MCP_SERVER_NAME,
    version: options.version,
  });
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
  for (const tool of options.tools ?? createRsGithubTools()) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => ({
        content: [
          {
            type: "text" as const,
            text: encodeRedskilledMcpToon(
              await options.invoke(tool.method, rsGithubRequestParams(input)),
            ),
          },
        ],
      }),
    );
  }
  return server;
}
