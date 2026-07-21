import type { z } from "zod/v3";

/**
 * One published dev:afk MCP tool. A description starting with `MUTATING:` is
 * the declared mutation mode — the client docs contract reads that prefix.
 */
export interface CastleMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}
