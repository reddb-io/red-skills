// The `rs_memory` MCP server: a stateless forwarder onto the daemon's memory.
//
// The process owns nothing worth owning: no RedDB, no graph store, no root
// resolution, no config read, no fallback to a local store. Its whole body is
// "shape the envelope, hand it to the daemon, render the answer".
//
// There is deliberately no offline mode. A memory the adapter could open by
// itself is a second memory — the exact per-session, per-checkout store
// ADR 0152 replaced — so when the daemon cannot be reached the CALL fails and
// says so. Listing is the one thing that still answers offline, because a host
// that cannot enumerate a surface reports the whole server as failed rather
// than the one call that needed a store.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  RedskilledMemoryAnswer,
  RedskilledMemoryCall,
} from "@reddb-io/protocol-acp";

import {
  createRsMemoryCoreTools,
  RS_MEMORY_MCP_SERVER_NAME,
  RS_MEMORY_SURFACE_TOOL,
  type RsMemoryTool,
} from "./tool.js";

/** Forward one memory call. The server never learns how this is carried. */
export type RsMemoryInvoke = (call: RedskilledMemoryCall) => Promise<RedskilledMemoryAnswer>;

export interface CreateRsMemoryMcpServerOptions {
  readonly version: string;
  readonly invoke: RsMemoryInvoke;
  /**
   * The caller's declared Working mode, read from `RED_MODE`.
   *
   * The daemon cannot know it — it runs in no checkout and is not the process
   * a Worker's environment was handed to — so this is the one fact the adapter
   * contributes to a call. Absence is an answer: it says "no Worker here".
   */
  readonly mode?: () => string | undefined;
  /** Overridable only so a test can publish the surface without a daemon. */
  readonly coreTools?: readonly RsMemoryTool[];
}

/** Publish the `rs_memory` surface over an already-chosen MCP transport. */
export function createRsMemoryMcpServer(options: CreateRsMemoryMcpServerOptions): Server {
  const core = options.coreTools ?? createRsMemoryCoreTools();
  const server = new Server(
    { name: RS_MEMORY_MCP_SERVER_NAME, version: options.version },
    { capabilities: { tools: {} } },
  );
  const forward = (tool: string, args: Record<string, unknown>) => {
    const mode = options.mode?.();
    return options.invoke({
      tool,
      arguments: args,
      ...(mode == null ? {} : { mode: mode as RedskilledMemoryCall["mode"] }),
    });
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listTools(core, forward),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    try {
      const answer = await forward(name, request.params.arguments ?? {});
      return renderMemoryAnswer(answer);
    } catch (error) {
      return {
        content: [{
          type: "text" as const,
          text: error instanceof Error ? error.message : String(error),
        }],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * The tools this session publishes.
 *
 * The daemon is asked first, because it is the only thing that can enumerate
 * memory's generated read-only operation tools. When it cannot be reached the
 * CORE still lists: a host with no daemon running should see a memory surface
 * whose calls fail loudly, not a server that failed to start.
 */
async function listTools(
  core: readonly RsMemoryTool[],
  forward: (tool: string, args: Record<string, unknown>) => Promise<RedskilledMemoryAnswer>,
): Promise<RsMemoryTool[]> {
  try {
    const answer = await forward(RS_MEMORY_SURFACE_TOOL, {});
    const published = memoryToolList(answer.result);
    if (published.length > 0) return published;
  } catch {
    // Fall through to the core: an unreachable daemon costs the generated
    // half of the surface, never the ability to list at all.
  }
  return [...core];
}

function memoryToolList(result: unknown): RsMemoryTool[] {
  const tools = result != null && typeof result === "object" && !Array.isArray(result)
    ? (result as { tools?: unknown }).tools
    : undefined;
  if (!Array.isArray(tools)) return [];
  return tools.filter(isRsMemoryTool);
}

function isRsMemoryTool(value: unknown): value is RsMemoryTool {
  const tool = value as RsMemoryTool | undefined;
  return tool != null && typeof tool === "object" &&
    typeof tool.name === "string" && typeof tool.description === "string" &&
    tool.inputSchema != null && typeof tool.inputSchema === "object";
}

/**
 * Render one answer for a reader.
 *
 * The daemon already shaped the tool's own result for MCP — the memory body has
 * always rendered TOON prose beside structured content — so this unwraps that
 * shape and adds nothing. What it DOES add is `root` and `scope` on the
 * structured side: "which memory answered this?" is the question a per-Project
 * store with a checkout opt-in makes worth asking.
 */
export function renderMemoryAnswer(answer: RedskilledMemoryAnswer): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
} {
  const result = answer.result as {
    content?: Array<{ type: "text"; text: string }>;
    structuredContent?: Record<string, unknown>;
    isError?: boolean;
  } | undefined;
  const content = Array.isArray(result?.content)
    ? result.content
    : [{ type: "text" as const, text: JSON.stringify(answer.result, null, 2) }];
  return {
    content,
    structuredContent: {
      ...(result?.structuredContent ?? {}),
      memory_root: answer.root,
      memory_scope: answer.scope,
    },
    ...(result?.isError === true ? { isError: true } : {}),
  };
}
