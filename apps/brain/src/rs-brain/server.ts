// The `rs_brain` MCP server: a stateless forwarder onto the daemon's brain.
//
// The process owns nothing worth owning: no RedDB, no connection string, no
// root resolution, no channel bridge, no fallback to a local store. Its whole
// body is "shape the envelope, hand it to the daemon, render the answer".
//
// There is deliberately no offline mode. A brain the adapter could open by
// itself is a second brain — the exact per-session, per-checkout store ADR 0152
// replaced — so when the daemon cannot be reached the call FAILS and says so.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RedskilledBrainAnswer, RedskilledBrainTool } from "@reddb-io/protocol-acp";
import {
  createRsBrainTools,
  RS_BRAIN_MCP_SERVER_NAME,
  type RsBrainTool,
} from "./tool.js";

/** Forward one brain call. The server never learns how this is carried. */
export type RsBrainInvoke = (
  tool: RedskilledBrainTool,
  args: Record<string, unknown>,
) => Promise<RedskilledBrainAnswer>;

export interface CreateRsBrainMcpServerOptions {
  readonly version: string;
  readonly invoke: RsBrainInvoke;
  /**
   * Where this session stands, recorded as capture provenance.
   *
   * The daemon cannot know it — it holds one store for the whole machine and
   * runs in no checkout — so the one thing the adapter contributes to a call is
   * the only fact it holds that the daemon does not.
   */
  readonly sourcePath?: () => string;
  /** Overridable only so a test can publish the surface without a daemon. */
  readonly tools?: readonly RsBrainTool[];
}

/**
 * Fill in what the session knows and the daemon cannot.
 *
 * Only `brain_capture` takes provenance, and only when the caller named none:
 * a caller that spelled `source_path` meant it.
 */
export function rsBrainCallArguments(
  tool: RedskilledBrainTool,
  input: Readonly<Record<string, unknown>>,
  sourcePath: () => string,
): Record<string, unknown> {
  if (tool !== "brain_capture" || input.source_path !== undefined) return { ...input };
  return { ...input, source_path: sourcePath() };
}

/** Publish the `rs_brain` surface over an already-chosen MCP transport. */
export function createRsBrainMcpServer(options: CreateRsBrainMcpServerOptions): McpServer {
  const server = new McpServer({
    name: RS_BRAIN_MCP_SERVER_NAME,
    version: options.version,
  });
  const sourcePath = options.sourcePath ?? (() => process.cwd());
  const registerTool = server.registerTool.bind(server) as (
    name: string,
    config: {
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
    },
    handler: (input: Record<string, unknown>) => Promise<{
      content: Array<{ type: "text"; text: string }>;
      structuredContent: unknown;
    }>,
  ) => void;
  for (const tool of options.tools ?? createRsBrainTools()) {
    registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
      },
      async (input) => {
        const answer = await options.invoke(
          tool.name,
          rsBrainCallArguments(tool.name, input ?? {}, sourcePath),
        );
        return {
          content: [{ type: "text" as const, text: renderBrainAnswer(answer) }],
          structuredContent: answer,
        };
      },
    );
  }
  return server;
}

/**
 * Render one answer for a reader.
 *
 * `brain_think` answers in prose and everything else answers in structure, so
 * the prose is shown as prose while the whole answer — root included — travels
 * in `structuredContent` for a caller that wants to know which brain replied.
 */
function renderBrainAnswer(answer: RedskilledBrainAnswer): string {
  const result = answer.result;
  if (answer.tool === "brain_think" && isThinResult(result)) return result.answer;
  return JSON.stringify(result, null, 2);
}

function isThinResult(value: unknown): value is { answer: string } {
  return value != null && typeof value === "object" &&
    typeof (value as { answer?: unknown }).answer === "string";
}
