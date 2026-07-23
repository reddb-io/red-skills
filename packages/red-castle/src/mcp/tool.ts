import type { z } from "zod/v3";

/**
 * One published castle MCP tool. A description starting with `MUTATING:` is
 * the declared mutation mode — the client docs contract reads that prefix.
 *
 * `dangerClass` marks tools that the posture gate intercepts.  Domain modules
 * set it on declaration; the aggregator wires the gate centrally.
 */
export interface CastleMcpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodType>;
  dangerClass?: string;
  invoke(input: Record<string, unknown>): Promise<unknown>;
}
